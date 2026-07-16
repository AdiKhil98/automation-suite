/**
 * Output-security helpers for demo generation. EVERY lead fact is treated as untrusted
 * input: text is HTML-escaped, URLs are allow-listed by scheme, and file-path segments
 * are constrained to prevent traversal. Nothing here ever emits raw fact text.
 */

/** HTML-escape text for safe interpolation into element content or attributes. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_HTTP = /^https?:\/\//i;
// Schemes we explicitly refuse even if they somehow parse.
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file|blob|about):/i;

/**
 * Sanitize a URL for use as an href. Allows only http(s), tel:, and mailto:.
 * Returns null for anything else (javascript:, data:, path traversal, malformed) —
 * the caller must omit the link rather than emit an unsafe destination.
 */
export function sanitizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === '' || DANGEROUS_SCHEME.test(value)) return null;

  if (value.toLowerCase().startsWith('tel:')) {
    const digits = value.slice(4).replace(/[\s()-]/g, '');
    return /^\+?[0-9]{3,20}$/.test(digits) ? `tel:${digits}` : null;
  }
  if (value.toLowerCase().startsWith('mailto:')) {
    const addr = value.slice(7);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? `mailto:${addr}` : null;
  }
  if (SAFE_HTTP.test(value)) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  return null; // scheme-relative, relative, or unknown scheme → refuse
}

/** Build a `tel:` href from a raw phone fact, or null if it isn't a usable number. */
export function telHref(rawPhone: string | null | undefined): string | null {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/[^\d+]/g, '');
  return /^\+?[0-9]{3,20}$/.test(digits) ? `tel:${digits}` : null;
}

/** Build a `mailto:` href from a raw email fact, or null if malformed. */
export function mailtoHref(rawEmail: string | null | undefined): string | null {
  if (!rawEmail) return null;
  const addr = rawEmail.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? `mailto:${addr}` : null;
}

/**
 * Constrain a string to a safe single path segment (no traversal, no separators).
 * Used for the per-lead output directory name. Throws if it cannot be made safe.
 */
export function safePathSegment(input: string): string {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (cleaned === '' || cleaned.includes('..')) {
    throw new Error(`unsafe path segment: ${JSON.stringify(input)}`);
  }
  return cleaned;
}
