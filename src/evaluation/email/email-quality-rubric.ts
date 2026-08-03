/**
 * Phase 7A4A — deterministic 100-point email quality rubric. Every sub-check is reproducible from the
 * recorded artifacts alone (no model-graded scores). Category weights and per-sub-check point values are
 * the operator-approved allocation in docs/phase-7a4-email-validation.md §6.1. The SAME function scores
 * the baseline and the enriched email; a NONE-mode (baseline) artifact earns competitor-specific
 * sub-checks only vacuously (nothing to violate) and 0 on Material relevance by construction.
 */

import { ISSUE_KEYWORDS, MAX_MODEL_BODY_WORDS, MAX_PARAGRAPH_CHARS, RUBRIC_WEIGHTS } from './constants.js';

export interface SubCheck {
  name: string;
  points: number;
  max: number;
  pass: boolean;
}

export interface CategoryScore {
  category: keyof typeof RUBRIC_WEIGHTS;
  points: number;
  max: number;
  checks: SubCheck[];
}

export interface RubricScore {
  categories: CategoryScore[];
  total: number;
}

/** Normalized, artifact-derived inputs the rubric scores. Built by the report from the harness output. */
export interface RubricInput {
  mode: 'NONE' | 'APPROVED_COMPETITOR_PATTERN_PACKAGE';
  modelBody: string;
  renderedBody: string;
  subject: string;
  modelParagraphs: string[];
  competitorSectionCount: number;
  selectedPatternCategory: string | null;
  alignedEvidenceCategories: readonly string[];
  consequenceLabelMatches: boolean;
  contrastPresent: boolean;
  competitorEvidenceCited: boolean;
  wordingText: string | null;
  competitorSentence: string | null;
  consequenceSentence: string | null;
  recommendationText: string | null;
  recommendationCount: number;
  ctaValid: boolean;
  prospectEvidenceCited: boolean;
  hashReproducible: boolean;
  packageIntegrityOk: boolean;
  ledgerCoversSections: boolean;
  comparativeRefsOk: boolean;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const ALLOWED_TOKENS = /\{\{(?:SENDER_NAME|DEMO_URL)\}\}/g;

function containsIssueKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return ISSUE_KEYWORDS.some((k) => lower.includes(k));
}

function bodySentences(body: string): string[] {
  return body
    .split(/\n+/)
    .flatMap((line) => line.split(SENTENCE_SPLIT))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('{{'));
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function cat(category: keyof typeof RUBRIC_WEIGHTS, checks: SubCheck[]): CategoryScore {
  const points = checks.reduce((s, c) => s + (c.pass ? c.points : 0), 0);
  return { category, points, max: RUBRIC_WEIGHTS[category], checks };
}

const chk = (name: string, points: number, pass: boolean): SubCheck => ({ name, points, max: points, pass });

/** Score one email artifact against the full rubric. Deterministic and pure. */
export function scoreEmail(input: RubricInput): RubricScore {
  const enriched = input.mode === 'APPROVED_COMPETITOR_PATTERN_PACKAGE';
  const firstPara = (input.modelParagraphs[0] ?? '').trim();
  const sentences = bodySentences(input.renderedBody);

  // --- Prospect specificity (20) ---
  const prospectBeforeCompetitor =
    !enriched || !input.competitorSentence ||
    input.renderedBody.indexOf(firstPara) < input.renderedBody.indexOf(input.competitorSentence);
  const prospectSpecificity = cat('prospectSpecificity', [
    chk('observation_present', 5, firstPara !== ''),
    chk('observation_first', 5, firstPara !== '' && prospectBeforeCompetitor),
    chk('cites_primary_finding', 5, input.prospectEvidenceCited),
    chk('concrete_issue_keyword', 5, containsIssueKeyword(firstPara) || containsIssueKeyword(input.modelBody)),
  ]);

  // --- Material relevance (20) — baseline earns 0 by construction ---
  const materialRelevance = cat('materialRelevance', [
    chk('one_competitor_section', 5, input.competitorSectionCount === 1),
    chk('pattern_aligned_to_issue', 5, input.selectedPatternCategory !== null && input.alignedEvidenceCategories.includes(input.selectedPatternCategory)),
    chk('competitor_evidence_cited', 4, input.competitorEvidenceCited),
    chk('consequence_matches_category', 3, input.consequenceLabelMatches),
    chk('contrast_tied_to_issue', 3, input.contrastPresent),
  ]);

  // --- Evidence & traceability integrity (20) — must be 20/20 to accept enriched ---
  const integrity = cat('integrity', [
    chk('all_sections_ledgered', 4, enriched ? input.ledgerCoversSections : true),
    chk('comparative_refs_pattern_id', 4, enriched ? input.comparativeRefsOk : true),
    chk('competitor_claim_evidence_ref', 3, enriched ? input.competitorEvidenceCited : true),
    chk('prospect_observation_evidence_ref', 3, input.prospectEvidenceCited),
    chk('composed_hash_reproducible', 3, input.hashReproducible),
    chk('package_hash_ok', 3, input.packageIntegrityOk),
  ]);

  // --- Clarity & readability (15) ---
  const noDupSentence = new Set(sentences.map((s) => s.toLowerCase())).size === sentences.length;
  const gluedFree = !/[a-zäöü][A-ZÄÖÜ]/.test(input.modelBody);
  const strippedTokens = input.renderedBody.replace(ALLOWED_TOKENS, '');
  const noMarkdown = !/[#*`]|\[[^\]]+\]\([^)]+\)|\{\{/.test(strippedTokens);
  const clarity = cat('clarity', [
    chk('paragraph_length_bound', 4, input.modelParagraphs.every((p) => p.length <= MAX_PARAGRAPH_CHARS)),
    chk('no_duplicate_sentence', 4, noDupSentence),
    chk('no_glued_tokens', 3, gluedFree),
    chk('paragraph_count_2_to_4', 2, input.modelParagraphs.length >= 2 && input.modelParagraphs.length <= 4),
    chk('no_markdown_or_placeholder', 2, noMarkdown),
  ]);

  // --- Brevity & focus (10) ---
  const wordCount = input.modelBody.trim().split(/\s+/).filter(Boolean).length;
  const issueSentenceCount = sentences.filter((s) => containsIssueKeyword(s)).length;
  const brevity = cat('brevity', [
    chk('word_count_within_max', 4, wordCount <= MAX_MODEL_BODY_WORDS),
    chk('at_most_one_competitor_section', 3, input.competitorSectionCount <= 1),
    chk('no_redundant_issue_restatement', 3, issueSentenceCount <= 2),
  ]);

  // --- Recommendation & CTA coherence (10) ---
  const recAligned = input.recommendationText !== null && containsIssueKeyword(input.recommendationText);
  const ctaSubjectClean = !/\b(?:competitors?|competition|other (?:clinics?|practices?)|rivals?)\b/i.test(input.subject);
  const recommendationCta = cat('recommendationCta', [
    chk('exactly_one_recommendation', 3, input.recommendationCount === 1),
    chk('exactly_one_cta', 3, input.ctaValid),
    chk('cta_subject_no_competitor', 2, ctaSubjectClean),
    chk('recommendation_aligned', 2, recAligned),
  ]);

  // --- Naturalness & non-template feel (5) ---
  const consequenceOnce = input.consequenceSentence === null || occurrences(input.renderedBody, input.consequenceSentence) <= 1;
  let mechanicalFree = !/ {2,}/.test(input.renderedBody);
  for (let i = 1; i < sentences.length; i += 1) {
    const prev = sentences[i - 1]!.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    const curr = sentences[i]!.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    if (prev !== '' && prev === curr) mechanicalFree = false;
  }
  const countPhraseProse = !enriched || (input.wordingText !== null && input.wordingText.toLowerCase().includes('nearby clinics'));
  const naturalness = cat('naturalness', [
    chk('consequence_at_most_once', 2, consequenceOnce),
    chk('no_mechanical_stitching', 2, mechanicalFree),
    chk('count_phrase_reads_as_prose', 1, countPhraseProse),
  ]);

  const categories = [prospectSpecificity, materialRelevance, integrity, clarity, brevity, recommendationCta, naturalness];
  return { categories, total: categories.reduce((s, c) => s + c.points, 0) };
}

/** Convenience: category points by name. */
export function categoryPoints(score: RubricScore, category: keyof typeof RUBRIC_WEIGHTS): number {
  return score.categories.find((c) => c.category === category)?.points ?? 0;
}
