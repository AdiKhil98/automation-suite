import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { isBlockedIp } from './ip-guard.js';

export class PolicyBlockedError extends AppError {
  constructor(message: string) {
    super('POLICY_BLOCKED', message);
  }
}
export class TransientFetchError extends AppError {
  constructor(message: string) {
    super('TRANSIENT_FETCH', message);
  }
}

export type FetchOutcome =
  | { kind: 'ok'; finalUrl: string; host: string; status: number; html: string }
  | { kind: 'policy_blocked'; reason: string }
  | { kind: 'transient'; reason: string }
  | { kind: 'invalid'; reason: string };

export type Resolver = (hostname: string) => Promise<string[]>;

/** Default resolver: all A/AAAA records for a hostname. */
export const dnsResolveAll: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * Validate a URL for fetching: scheme allowlist, no embedded credentials, and every
 * resolved address must pass the SSRF guard. Used both pre-flight and (with the
 * real resolver) at connect time to mitigate DNS rebinding.
 */
export async function assertUrlSafe(rawUrl: string, resolve: Resolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyBlockedError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PolicyBlockedError(`blocked scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new PolicyBlockedError('URL must not contain credentials');
  }
  // IP-literal hosts (incl. bracketed IPv6 and numeric forms URL normalizes) validate directly.
  const literalHost = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const addresses = isIP(literalHost) ? [literalHost] : await resolve(url.hostname);
  if (addresses.length === 0) throw new PolicyBlockedError(`no DNS results for ${url.hostname}`);
  for (const addr of addresses) {
    if (isBlockedIp(addr)) throw new PolicyBlockedError(`blocked address ${addr} for ${url.hostname}`);
  }
  return url;
}

export interface SafeGetOptions {
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  resolver?: Resolver;
}

const HTML_TYPES = /(text\/html|application\/xhtml\+xml)/i;

/**
 * SSRF-hardened HTML GET. Redirects are followed MANUALLY with per-hop validation;
 * DNS is re-validated at connect time via a custom lookup; only HTML is accepted;
 * bytes and total time are capped. Non-fatal issues map to a typed FetchOutcome.
 */
export async function safeGetHtml(rawUrl: string, opts: SafeGetOptions): Promise<FetchOutcome> {
  const resolve = opts.resolver ?? dnsResolveAll;
  let current = rawUrl;
  const deadline = Date.now() + opts.timeoutMs;

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = await assertUrlSafe(current, resolve);
    } catch (err) {
      if (err instanceof PolicyBlockedError) return { kind: 'policy_blocked', reason: err.message };
      return { kind: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }

    let res: HopResult;
    try {
      res = await fetchHop(url, resolve, Math.max(1, deadline - Date.now()), opts.maxBytes);
    } catch (err) {
      if (err instanceof PolicyBlockedError) return { kind: 'policy_blocked', reason: err.message };
      return { kind: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, url).toString();
      continue;
    }
    if (res.status === 429) {
      return { kind: 'transient', reason: `rate limited (429)${res.retryAfter ? `, retry-after ${res.retryAfter}` : ''}` };
    }
    if (res.status >= 500) return { kind: 'transient', reason: `upstream ${res.status}` };
    if (res.status >= 400) return { kind: 'invalid', reason: `http ${res.status}` };
    if (!res.contentType || !HTML_TYPES.test(res.contentType)) {
      return { kind: 'policy_blocked', reason: `non-HTML content-type: ${res.contentType ?? 'none'}` };
    }
    return { kind: 'ok', finalUrl: url.toString(), host: url.host.toLowerCase(), status: res.status, html: res.body };
  }
  return { kind: 'transient', reason: 'too many redirects' };
}

interface HopResult {
  status: number;
  location: string | null;
  contentType: string | null;
  retryAfter: string | null;
  body: string;
}

function fetchHop(url: URL, resolve: Resolver, timeoutMs: number, maxBytes: number): Promise<HopResult> {
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HopResult>((resolvePromise, reject) => {
    const req = requestFn(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'automation-suite-enrichment/0.1 (+contact via operator)', Accept: 'text/html' },
        // Connect-time re-validation (DNS rebinding mitigation).
        lookup: (hostname, _o, cb) => {
          resolve(hostname)
            .then((addresses) => {
              const blocked = addresses.find((a) => isBlockedIp(a));
              if (blocked) {
                cb(new PolicyBlockedError(`blocked address ${blocked} at connect for ${hostname}`), '', 4);
                return;
              }
              const first = addresses[0];
              if (!first) {
                cb(new PolicyBlockedError(`no address for ${hostname}`), '', 4);
                return;
              }
              cb(null, first, first.includes(':') ? 6 : 4);
            })
            .catch((e: unknown) => cb(e instanceof Error ? e : new Error(String(e)), '', 4));
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = (res.headers.location as string | undefined) ?? null;
        const contentType = (res.headers['content-type'] as string | undefined) ?? null;
        const retryAfter = (res.headers['retry-after'] as string | undefined) ?? null;

        if (status >= 300 && status < 400) {
          res.destroy();
          resolvePromise({ status, location, contentType, retryAfter, body: '' });
          return;
        }
        if (contentType && !HTML_TYPES.test(contentType)) {
          res.destroy();
          resolvePromise({ status, location, contentType, retryAfter, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new PolicyBlockedError('response exceeds byte cap'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolvePromise({ status, location, contentType, retryAfter, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', (e) => reject(new TransientFetchError(e.message)));
      },
    );
    req.on('timeout', () => req.destroy(new TransientFetchError('request timeout')));
    req.on('error', (e) => reject(e instanceof PolicyBlockedError ? e : new TransientFetchError(e.message)));
    req.end();
  });
}
