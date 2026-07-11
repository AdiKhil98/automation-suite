/**
 * Minimal, deterministic normalization used to populate a lead's normalized_*
 * fields. Full normalization + deduplication logic (stable identity keys, etc.)
 * is built in Phase 2; this is the intentionally small starting point.
 */

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeDomain(domain: string | null): string | null {
  if (!domain) return null;
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return cleaned.length > 0 ? cleaned : null;
}
