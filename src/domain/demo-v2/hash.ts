import { createHash } from 'node:crypto';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function demoV2Hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function aggregateBindings(
  values: ReadonlyArray<{ id: string; hash: string }>,
): string {
  return demoV2Hash([...values].sort((a, b) => a.id.localeCompare(b.id)));
}
