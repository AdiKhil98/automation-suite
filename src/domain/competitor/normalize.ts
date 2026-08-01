import { getDomain } from 'tldts';
import { normalizeDomain, normalizeName } from '../leads/normalize.js';

/**
 * Deterministic normalization helpers for competitor comparability. Pure functions only —
 * identical input always yields identical output. No AI, no network.
 */

/** Normalize a single supplied service/category token. */
export function normalizeService(value: string | null): string | null {
  return normalizeName(value);
}

/** Normalize + dedupe a list of supplied service tokens, preserving first-seen order. */
export function normalizeServices(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const norm = normalizeService(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** Count unique services present in BOTH lists (by normalized identity). */
export function overlappingServiceCount(a: readonly string[], b: readonly string[]): number {
  const setB = new Set(b);
  let count = 0;
  for (const s of new Set(a)) {
    if (setB.has(s)) count += 1;
  }
  return count;
}

/**
 * Registrable (eTLD+1) domain via the Public Suffix List, e.g. "www.clinic.co.uk/x" → "clinic.co.uk".
 * Never naive suffix matching. Returns null when it cannot be determined.
 */
export function registrableDomain(websiteOrDomain: string | null): string | null {
  const host = normalizeDomain(websiteOrDomain);
  if (!host) return null;
  return getDomain(host) ?? null;
}

/** Normalize a parent-brand label deterministically (no AI inference). */
export function normalizeBrand(value: string | null): string | null {
  return normalizeName(value);
}

export { normalizeDomain, normalizeName };
