import { randomBytes } from 'node:crypto';

/**
 * Security helpers for the local review dashboard. The server binds to 127.0.0.1 only; these
 * add defence in depth: a Host-header allowlist (blocks DNS-rebinding), same-origin checks on
 * mutating POSTs, a per-session CSRF token, and restrictive response headers.
 */

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; img-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

/** Extract the hostname (no port) from a Host header value. */
export function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  // IPv6 in brackets, else strip trailing :port.
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  const h = hostHeader.split(':')[0];
  return h ?? null;
}

/** True when the Host header names a loopback interface. */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  const h = hostname(hostHeader);
  return h !== null && LOOPBACK_HOSTS.has(h);
}

/**
 * Same-origin check for a mutating request. The Origin (preferred) or Referer must point back
 * at this loopback host. A cross-site POST (which cannot set a matching Origin) is rejected.
 */
export function isSameOrigin(opts: { origin?: string; referer?: string; host?: string }): boolean {
  const host = opts.host;
  if (!host || !isAllowedHost(host)) return false;
  const expected = `http://${host}`;
  if (opts.origin !== undefined && opts.origin !== 'null') return opts.origin === expected;
  if (opts.referer !== undefined) return opts.referer.startsWith(`${expected}/`) || opts.referer === expected;
  return false; // no Origin and no Referer → refuse a mutation
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

/** Constant-time-ish token comparison. */
export function csrfMatches(expected: string, provided: string | undefined): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/** Parse an application/x-www-form-urlencoded body into a flat map. */
export function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const idx = pair.indexOf('=');
    const k = decodeURIComponent((idx < 0 ? pair : pair.slice(0, idx)).replace(/\+/g, ' '));
    const v = idx < 0 ? '' : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}
