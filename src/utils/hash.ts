import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively so semantically-equal inputs
 * always serialize identically. Used for deterministic hashing/fingerprinting.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable hash of any JSON-serializable value (canonical key order). */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
