import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { AppError } from './errors.js';
import { isBlockedIp } from './ip-guard.js';
import {
  classifyHttpStatus,
  classifyInvalidRedirect,
  classifyNetworkError,
  classifyRedirectLimit,
  type VerificationFailureStage,
} from './network-error-classification.js';

export class PolicyBlockedError extends AppError {
  constructor(message: string) {
    super('POLICY_BLOCKED', message);
  }
}
export class TransientFetchError extends AppError {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super('TRANSIENT_FETCH', message);
    this.cause = cause;
  }
}

export type FetchFinalClassification = 'OK' | 'TRANSIENT' | 'INVALID' | 'POLICY_BLOCKED';

export interface FetchDiagnostic {
  attemptedAt: Date;
  finalClassification: FetchFinalClassification;
  failureStage: VerificationFailureStage | null;
  errorCode: string | null;
  httpStatus: number | null;
  redirectCount: number;
  elapsedMs: number;
  resolvedIpFamily: 4 | 6 | null;
  retryable: boolean;
}

export type FetchOutcome =
  | { kind: 'ok'; finalUrl: string; host: string; status: number; html: string; diagnostic?: FetchDiagnostic }
  | { kind: 'policy_blocked'; reason: string; diagnostic?: FetchDiagnostic }
  | { kind: 'transient'; reason: string; diagnostic?: FetchDiagnostic }
  | { kind: 'invalid'; reason: string; diagnostic?: FetchDiagnostic };

export type Resolver = (hostname: string) => Promise<string[]>;

/** Default resolver: all A/AAAA records for a hostname. */
export const dnsResolveAll: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

function addressFamily(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

/**
 * Build a connect-time DNS lookup that returns only addresses resolved and
 * validated for this connection attempt. Returning the complete array when
 * Node requests `all: true` preserves its IPv6/IPv4 fallback behavior without
 * allowing an unvalidated address to enter the connection race.
 */
export function createValidatedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        const blocked = addresses.find((address) => isBlockedIp(address));
        if (blocked) {
          callback(new PolicyBlockedError(`blocked address ${blocked} at connect for ${hostname}`), '', 4);
          return;
        }
        const approved = addresses.map((address) => ({ address, family: addressFamily(address) }));
        const first = approved[0];
        if (!first) {
          callback(new PolicyBlockedError(`no address for ${hostname}`), '', 4);
          return;
        }
        if (options.all) {
          callback(null, approved);
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)), '', 4),
      );
  };
}

/**
 * Validate a URL for fetching: scheme allowlist, no embedded credentials, and every
 * resolved address must pass the SSRF guard. Used both pre-flight and (with the
 * real resolver) at connect time to mitigate DNS rebinding.
 */
export async function assertUrlSafe(rawUrl: string, resolve: Resolver): Promise<URL> {
  return (await inspectUrlSafe(rawUrl, resolve)).url;
}

async function inspectUrlSafe(rawUrl: string, resolve: Resolver): Promise<{ url: URL; ipFamily: 4 | 6 | null }> {
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
  const first = addresses[0];
  return { url, ipFamily: first ? (first.includes(':') ? 6 : 4) : null };
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
  const attemptedAt = new Date();
  const startedAtMs = Date.now();
  const deadline = Date.now() + opts.timeoutMs;

  const diagnostic = (
    finalClassification: FetchFinalClassification,
    failureStage: VerificationFailureStage | null,
    errorCode: string | null,
    httpStatus: number | null,
    redirectCount: number,
    resolvedIpFamily: 4 | 6 | null,
    retryable: boolean,
  ): FetchDiagnostic => ({
    attemptedAt,
    finalClassification,
    failureStage,
    errorCode,
    httpStatus,
    redirectCount,
    elapsedMs: Math.max(0, Date.now() - startedAtMs),
    resolvedIpFamily,
    retryable,
  });

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    let url: URL;
    let resolvedIpFamily: 4 | 6 | null;
    try {
      const inspected = await inspectUrlSafe(current, resolve);
      url = inspected.url;
      resolvedIpFamily = inspected.ipFamily;
    } catch (err) {
      if (err instanceof PolicyBlockedError) {
        return { kind: 'policy_blocked', reason: err.message, diagnostic: diagnostic('POLICY_BLOCKED', 'POLICY', 'POLICY_BLOCKED', null, hop, null, false) };
      }
      const classified = classifyNetworkError(err);
      return { kind: 'transient', reason: 'network resolution failed', diagnostic: diagnostic('TRANSIENT', classified.stage, classified.errorCode, null, hop, null, classified.retryable) };
    }

    let res: HopResult;
    try {
      res = await fetchHop(url, resolve, Math.max(1, deadline - Date.now()), opts.maxBytes);
    } catch (err) {
      if (err instanceof PolicyBlockedError) {
        return { kind: 'policy_blocked', reason: err.message, diagnostic: diagnostic('POLICY_BLOCKED', 'POLICY', 'POLICY_BLOCKED', null, hop, resolvedIpFamily, false) };
      }
      const classified = classifyNetworkError(err);
      return { kind: 'transient', reason: 'network request failed', diagnostic: diagnostic('TRANSIENT', classified.stage, classified.errorCode, null, hop, resolvedIpFamily, classified.retryable) };
    }

    if (res.status >= 300 && res.status < 400) {
      try {
        if (!res.location) throw new Error('missing redirect location');
        current = new URL(res.location, url).toString();
        continue;
      } catch {
        const redirectFailure = classifyInvalidRedirect();
        return {
          kind: 'invalid',
          reason: 'invalid redirect location',
          diagnostic: diagnostic(
            'INVALID',
            redirectFailure.stage,
            redirectFailure.errorCode,
            res.status,
            hop,
            resolvedIpFamily,
            redirectFailure.retryable,
          ),
        };
      }
    }
    const httpFailure = classifyHttpStatus(res.status);
    if (httpFailure?.finalClassification === 'TRANSIENT') {
      return { kind: 'transient', reason: `http ${res.status}`, diagnostic: diagnostic('TRANSIENT', httpFailure.stage, httpFailure.errorCode, res.status, hop, resolvedIpFamily, httpFailure.retryable) };
    }
    if (httpFailure?.finalClassification === 'INVALID') {
      return { kind: 'invalid', reason: `http ${res.status}`, diagnostic: diagnostic('INVALID', httpFailure.stage, httpFailure.errorCode, res.status, hop, resolvedIpFamily, httpFailure.retryable) };
    }
    if (!res.contentType || !HTML_TYPES.test(res.contentType)) {
      return { kind: 'policy_blocked', reason: `non-HTML content-type: ${res.contentType ?? 'none'}`, diagnostic: diagnostic('POLICY_BLOCKED', 'POLICY', 'NON_HTML_RESPONSE', res.status, hop, resolvedIpFamily, false) };
    }
    return { kind: 'ok', finalUrl: url.toString(), host: url.host.toLowerCase(), status: res.status, html: res.body, diagnostic: diagnostic('OK', null, null, res.status, hop, resolvedIpFamily, false) };
  }
  const redirectFailure = classifyRedirectLimit();
  return { kind: 'transient', reason: 'too many redirects', diagnostic: diagnostic('TRANSIENT', redirectFailure.stage, redirectFailure.errorCode, null, opts.maxRedirects + 1, null, redirectFailure.retryable) };
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
        servername: url.protocol === 'https:' ? url.hostname : undefined,
        headers: {
          Host: url.host,
          'User-Agent': 'automation-suite-enrichment/0.1 (+contact via operator)',
          Accept: 'text/html',
        },
        // Connect-time re-resolution + validation prevents DNS rebinding while
        // retaining Node's safe IPv6/IPv4 fallback across approved addresses.
        lookup: createValidatedLookup(resolve),
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
        res.on('error', (e) => reject(new TransientFetchError(e.message, e)));
      },
    );
    req.on('timeout', () => {
      const timeout = Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' });
      req.destroy(new TransientFetchError('request timeout', timeout));
    });
    req.on('error', (e) => reject(e instanceof PolicyBlockedError ? e : new TransientFetchError(e.message, e)));
    req.end();
  });
}
