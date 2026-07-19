import { request as httpsRequest } from 'node:https';
import { assertUrlSafe, dnsResolveAll, PolicyBlockedError, type Resolver } from '../../utils/safe-fetch.js';
import { isBlockedIp } from '../../utils/ip-guard.js';

export type VerifyFetchOutcome =
  | { kind: 'ok'; status: number; finalUrl: string; host: string; headers: Record<string, string>; body: string }
  | { kind: 'policy_blocked'; reason: string }
  | { kind: 'transient'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface VerifyFetchOptions {
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  resolver?: Resolver;
}

/**
 * SSRF-hardened HTTPS GET that returns response HEADERS (needed for X-Robots-Tag) as well as
 * the body. HTTPS-only, redirects followed manually with per-hop URL validation + connect-time
 * DNS re-validation (rebinding mitigation), bytes + time capped. The public Netlify preview is
 * on the public internet, so the guard blocks only private/loopback/link-local targets.
 */
export async function verifyFetch(rawUrl: string, opts: VerifyFetchOptions): Promise<VerifyFetchOutcome> {
  const resolve = opts.resolver ?? dnsResolveAll;
  let current = rawUrl;
  const deadline = Date.now() + opts.timeoutMs;

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = await assertUrlSafe(current, resolve);
    } catch (err) {
      return err instanceof PolicyBlockedError
        ? { kind: 'policy_blocked', reason: err.message }
        : { kind: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }
    if (url.protocol !== 'https:') return { kind: 'policy_blocked', reason: `blocked scheme: ${url.protocol}` };

    let hopRes: { status: number; location: string | null; headers: Record<string, string>; body: string };
    try {
      hopRes = await fetchHop(url, resolve, Math.max(1, deadline - Date.now()), opts.maxBytes);
    } catch (err) {
      return err instanceof PolicyBlockedError
        ? { kind: 'policy_blocked', reason: err.message }
        : { kind: 'transient', reason: err instanceof Error ? err.message : String(err) };
    }

    if (hopRes.status >= 300 && hopRes.status < 400 && hopRes.location) {
      current = new URL(hopRes.location, url).toString();
      continue;
    }
    if (hopRes.status === 429) return { kind: 'transient', reason: 'rate limited (429)' };
    if (hopRes.status >= 500) return { kind: 'transient', reason: `upstream ${String(hopRes.status)}` };
    return { kind: 'ok', status: hopRes.status, finalUrl: url.toString(), host: url.host.toLowerCase(), headers: hopRes.headers, body: hopRes.body };
  }
  return { kind: 'transient', reason: 'too many redirects' };
}

function fetchHop(url: URL, resolve: Resolver, timeoutMs: number, maxBytes: number): Promise<{ status: number; location: string | null; headers: Record<string, string>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'automation-suite-verify/0.1', Accept: 'text/html' },
        lookup: (hostname, o, cb) => {
          resolve(hostname)
            .then((addresses) => {
              const blocked = addresses.find((a) => isBlockedIp(a));
              if (blocked) { cb(new PolicyBlockedError(`blocked address ${blocked} at connect for ${hostname}`), '', 4); return; }
              const first = addresses[0];
              if (!first) { cb(new PolicyBlockedError(`no address for ${hostname}`), '', 4); return; }
              const fam = (a: string): number => (a.includes(':') ? 6 : 4);
              // Node's happy-eyeballs (autoSelectFamily) calls lookup with { all: true } and
              // expects an ARRAY of { address, family }; otherwise a single (address, family).
              if ((o as { all?: boolean }).all) cb(null, addresses.map((a) => ({ address: a, family: fam(a) })) as never, undefined as never);
              else cb(null, first, fam(first));
            })
            .catch((e: unknown) => cb(e instanceof Error ? e : new Error(String(e)), '', 4));
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, val] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val ?? '');
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) { req.destroy(new PolicyBlockedError('response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('verify request timeout')));
    req.on('error', reject);
    req.end();
  });
}
