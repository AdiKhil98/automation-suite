import { createHash } from 'node:crypto';
import { COMPARABILITY_RULES_VERSION } from './constants.js';
import { type SelectionConfig } from './selection.js';
import { type CompetitorInputCandidate, type ProspectProfileInput } from './types.js';

/** Stable, key-sorted JSON so identical logical input always hashes identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash of the exact prospect + candidate input set (order-independent for candidates). */
export function computeInputHash(
  profile: ProspectProfileInput,
  candidates: CompetitorInputCandidate[],
): string {
  const normalizedCandidates = [...candidates]
    .map((c) => ({ ...c, secondaryCategories: [...c.secondaryCategories] }))
    .sort((a, b) => a.rowIndex - b.rowIndex);
  return sha256(stableStringify({ profile, candidates: normalizedCandidates }));
}

/** Hash of the scoring configuration + rules version. */
export function computeConfigHash(config: SelectionConfig): string {
  return sha256(stableStringify({ rulesVersion: COMPARABILITY_RULES_VERSION, config }));
}
