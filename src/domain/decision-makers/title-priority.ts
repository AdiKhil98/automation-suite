/**
 * Deterministic title-priority classifier — the trust/filtering boundary between what the LLM is
 * allowed to interpret (messy website text -> candidate name+title+evidence) and what only
 * deterministic code decides (which titles actually count as a decision-maker, and in what order).
 * Per CLAUDE.md: "AI must never perform calculations normal code can do reliably" / "Deterministic
 * code owns: ... filtering". A title that doesn't map to one of these three tiers is EXCLUDED
 * entirely, never merely deprioritized — this is what keeps ordinary associates/hygienists/
 * receptionists/unrelated staff out even if the model proposes them.
 *
 * The tiers rank BUYING AUTHORITY for website / conversion / follow-up automation work, not clinical
 * seniority. In an independent practice the person who approves that spend is the owner or partner
 * first, a director second, and the practice manager third — the manager usually owns the problem and
 * runs the implementation, but rarely signs off alone.
 *
 * Tier 4 no longer exists. It used to hold "Managing Director / Director", which conflated two
 * different things: how sure we are the person belongs to THIS practice, and how much authority they
 * have. Sorting on that number then ranked a Managing Director below a Practice Manager. Employer
 * ambiguity is now an accept/reject GATE on the ambiguous Director family (see
 * `directorEmployerConfirmed`), and the tier expresses authority alone.
 */

export type TitlePriority = 1 | 2 | 3;

/**
 * Tier 1 — economic buyer / ownership.
 * `\bowner\b` deliberately matches across a hyphen, so Co-Owner / Joint Owner / Practice Owner all
 * land here. `\bpartner\b` covers the whole partner family (Managing / Equity / Dental / Practice
 * Partner, Partner Dentist, "Partner & Dentist", "Partner / Principal Dentist") while NOT matching
 * "Partnerships Manager" — the trailing `s` defeats the word boundary. `\bprincipal\b` covers both
 * "Principal" and "Principal Dentist"; in UK practice "principal" is the ownership word that
 * distinguishes them from an associate.
 */
const TIER_1_RE = /\b(owner|proprietor|founder|co-?founder|partner|principal)\b/i;

/**
 * Tier 2a — clinical leadership. Inherently practice-specific, so it needs no employer gate: nobody
 * is the "Clinical Director" of a holding company's dentistry.
 */
const CLINICAL_DIRECTOR_RE = /\b(clinical director|dental director)\b/i;

/**
 * Tier 2b — general directorship. "Managing Director" / "Director" say nothing about WHOSE
 * organisation the person directs, so this family passes through `directorEmployerConfirmed` before
 * it is accepted at all.
 */
const AMBIGUOUS_DIRECTOR_RE = /\bdirector\b/i;

/**
 * Tier 3 — operational management. Each qualifying manager is named explicitly rather than matching a
 * bare `manager`, which would sweep in Marketing Manager, Area Manager and similar non-buyers.
 */
const TIER_3_RE = /\b(practice|business|operations)\s+manager\b/i;

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
 * The employer GATE for the ambiguous Director family — unchanged in behaviour, only separated from
 * ranking. Confirmed when EITHER the practice name appears in the evidence snippet, OR page
 * provenance already establishes the employer (a named Managing Director on the practice's own
 * team/about page needs no redundant repetition of the practice name in the same sentence: a real
 * roster renders "Mena Williams — Managing Director" as a title card, with the practice name in the
 * page header, not the card). Corporate-group wording in the snippet re-imposes the practice-name
 * requirement.
 */
function directorEmployerConfirmed(evidenceSnippet: string, practiceName: string | null, provenance?: TitleProvenance | null): boolean {
  const name = practiceName?.trim().toLowerCase() ?? '';
  if (name.length > 0 && evidenceSnippet.toLowerCase().includes(name)) return true;
  if (CORPORATE_AMBIGUITY_RE.test(evidenceSnippet)) return false;
  return establishesEmployer(provenance);
}

/**
 * Shared tier resolution. Checked strictly highest-authority-first, so a combined title resolves to
 * the strongest role it actually contains ("Principal Dentist and Clinical Director" -> 1).
 *
 * The Director branch is the one that can FAIL rather than match: when the employer gate rejects it,
 * evaluation falls through to Tier 3 instead of returning null, so "Managing Director & Practice
 * Manager" on an unverifiable page is still correctly kept as a Practice Manager.
 */
function classify(title: string, employerConfirmed: boolean): TitlePriority | null {
  if (TIER_1_RE.test(title)) return 1;
  if (CLINICAL_DIRECTOR_RE.test(title)) return 2;
  if (AMBIGUOUS_DIRECTOR_RE.test(title) && employerConfirmed) return 2;
  if (TIER_3_RE.test(title)) return 3;
  return null;
}

/**
 * Classify a title into a priority tier (1 = strongest, highest outreach priority), or `null` to
 * exclude it entirely.
 */
export function classifyTitlePriority(
  title: string,
  evidenceSnippet: string,
  practiceName: string | null,
  provenance?: TitleProvenance | null,
): TitlePriority | null {
  const t = title.trim();
  if (!t) return null;
  return classify(t, directorEmployerConfirmed(evidenceSnippet, practiceName, provenance));
}

/**
 * Re-tier a title that was ALREADY accepted by `classifyTitlePriority` during extraction, using only
 * the title itself.
 *
 * Used by the offline `decision-makers-rerank` command. A candidate is present in candidates.json
 * only because it passed the full gate — including the Director employer check — at extraction time,
 * against evidence and provenance the stored entry no longer carries (the file records `sourceUrl`,
 * not the page role). Re-running the gate here with less information than the original decision had
 * would reject valid stored candidates, so the gate is treated as already satisfied and only the
 * authority ranking is recomputed.
 */
export function classifyValidatedTitlePriority(title: string): TitlePriority | null {
  const t = title.trim();
  if (!t) return null;
  return classify(t, true);
}
