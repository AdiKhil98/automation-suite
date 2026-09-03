/**
 * Deterministic title-priority classifier — the trust/filtering boundary between what the LLM is
 * allowed to interpret (messy website text -> candidate name+title+evidence) and what only
 * deterministic code decides (which titles actually count as a decision-maker, and in what order).
 * Per CLAUDE.md: "AI must never perform calculations normal code can do reliably" / "Deterministic
 * code owns: ... filtering". A title that doesn't map to one of these four tiers is EXCLUDED
 * entirely, never merely deprioritized — this is what keeps ordinary associates/hygienists/
 * receptionists/unrelated staff out even if the model proposes them.
 */

export type TitlePriority = 1 | 2 | 3 | 4;

const TIER_1_RE = /\b(owner|founder|co-?founder|principal dentist|principal)\b/i;
const TIER_2_RE = /\b(clinical director|dental director)\b/i;
const TIER_3_RE = /\b(practice manager)\b/i;
const TIER_4_RE = /\b(managing director|director)\b/i;

/**
 * Classify a title into a priority tier (1 = strongest), or `null` to exclude it entirely.
 *
 * Tier 4 ("Managing Director"/"Director") additionally requires `practiceName` to appear in
 * `evidenceSnippet` — a simple, deterministic stand-in for "clearly involved in the practice" that
 * does not trust the model's own unverifiable claim of involvement.
 */
export function classifyTitlePriority(title: string, evidenceSnippet: string, practiceName: string | null): TitlePriority | null {
  const t = title.trim();
  if (!t) return null;
  if (TIER_1_RE.test(t)) return 1;
  if (TIER_2_RE.test(t)) return 2;
  if (TIER_3_RE.test(t)) return 3;
  if (TIER_4_RE.test(t)) {
    if (!practiceName) return null;
    const name = practiceName.trim().toLowerCase();
    if (name && evidenceSnippet.toLowerCase().includes(name)) return 4;
    return null;
  }
  return null;
}
