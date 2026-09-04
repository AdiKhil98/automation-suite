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
 * Markers that a "Director" title belongs to a parent company / group rather than to this practice.
 * These are what the practice-name check was really guarding against, so they keep requiring it.
 */
const CORPORATE_AMBIGUITY_RE = /\b(group|holdings?|plc|ltd\.?|limited|corporate|head office|parent company|regional|area manager|nationwide)\b/i;

/**
 * Where a candidate's evidence came from. A page fetched by `gatherWebsiteEvidence` is always on the
 * lead's own verified official domain (same-origin enforced at fetch time), so a team/about page on
 * that domain already establishes the employer relationship.
 */
export interface TitleProvenance {
  role: 'home' | 'team' | 'about' | 'contact';
  /** True when the evidence page was fetched from the lead's own verified official domain. */
  officialDomain: boolean;
}

/** Provenance strong enough to establish "this person works for THIS practice" on its own. */
function establishesEmployer(provenance: TitleProvenance | null | undefined): boolean {
  if (!provenance?.officialDomain) return false;
  return provenance.role === 'team' || provenance.role === 'about';
}

/**
 * Classify a title into a priority tier (1 = strongest), or `null` to exclude it entirely.
 *
 * Tier 4 ("Managing Director"/"Director") is the ambiguous tier: the title alone does not say whose
 * organisation the person directs. It is accepted when EITHER the practice name appears in the
 * evidence snippet, OR page provenance already establishes the employer — a named Managing Director on
 * the practice's own team/about page needs no redundant repetition of the practice name in the same
 * sentence (a real roster renders "Mena Williams — Managing Director" as a title card, with the
 * practice name in the page header, not the card). Corporate-group wording in the snippet re-imposes
 * the practice-name requirement.
 */
export function classifyTitlePriority(
  title: string,
  evidenceSnippet: string,
  practiceName: string | null,
  provenance?: TitleProvenance | null,
): TitlePriority | null {
  const t = title.trim();
  if (!t) return null;
  if (TIER_1_RE.test(t)) return 1;
  if (TIER_2_RE.test(t)) return 2;
  if (TIER_3_RE.test(t)) return 3;
  if (TIER_4_RE.test(t)) {
    const name = practiceName?.trim().toLowerCase() ?? '';
    const practiceNameConfirmed = name.length > 0 && evidenceSnippet.toLowerCase().includes(name);
    if (practiceNameConfirmed) return 4;
    if (CORPORATE_AMBIGUITY_RE.test(evidenceSnippet)) return null;
    return establishesEmployer(provenance) ? 4 : null;
  }
  return null;
}
