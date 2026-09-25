import { canonicalizeUrl, type EvidencePackage } from './evidence-package.js';
import { type AuditGeneratorOutputParsed, type AuditReviewOutputParsed } from './audit-schema.js';

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

/** Human-readable description for a validation violation code (for the debug envelope
 * and operator diagnosis). The code itself is `<rule>:<...context>`; we key off the rule. */
export function describeViolation(code: string): string {
  const rule = code.split(':')[0] ?? code;
  const messages: Record<string, string> = {
    schema_invalid: 'Output did not match the required strict JSON schema.',
    duplicate_finding_ref: 'Two findings share the same finding reference.',
    no_evidence: 'Finding cites no evidence IDs (at least one is required).',
    evidence_outside_package: 'Finding cites an evidence ID that was not in the supplied package.',
    unsupported_url: 'Finding references a URL that is not in the captured page set.',
    confidence_range: 'Confidence is outside the allowed [0,1] range.',
    template_artifact: 'Text contains an unresolved template artifact (e.g. {{VAR}}, ${var}, <insert ...>, TODO:, lorem ipsum).',
    // Legacy code retained so historical stored violations still describe correctly.
    placeholder: 'Text contained the word "placeholder" (retired rule; superseded by template_artifact).',
    prompt_leakage: 'Text appears to leak system/prompt instructions.',
    forbidden_claim: 'Text makes a forbidden claim (e.g. revenue, traffic, ranking, percentage, guarantee).',
    review_ref_unknown: 'Reviewer referenced a finding ref not produced by the generator.',
    duplicate_review_ref: 'Reviewer referenced the same finding twice.',
  };
  return messages[rule] ?? `Validation rule "${rule}" failed.`;
}

// A PERFORMANCE PROMISE is a claim that a business OUTCOME will change for the better.
// The previous rule detected it as "future-tense word … business noun anywhere before the
// next full stop", which is structurally wrong: ordinary descriptive prose uses "will"
// freely, so any outcome noun later in the sentence tripped it. It killed a real paid
// audit (Vaswani, lead e3813658) on the legitimate recommendation "…explains how and when
// the practice will confirm the booking."
//
// We now detect the PERFORMANCE-CHANGE CONSTRUCTION itself, in three shapes:
//   (a) a directional change verb standing close to a plural/mass outcome noun
//       ("increase bookings", "increase the number of bookings", "boost conversions");
//   (b) a comparative quantifier modifying one ("more leads", "more new patients");
//   (c) an explicit guarantee marker in the same sentence as one ("guarantees … bookings").
// Bare "will" is no longer a signal at all, and singular/attributive uses ("confirm the
// booking", "the booking page", "patient information") are deliberately not matched.
//
// People nouns (patients/customers/clients) are matched ONLY in shapes (b) and (c): as the
// audience of a recommendation they appear constantly in valid prose ("improve the
// experience for patients"), whereas "more patients" is always a promise.
const OUTCOME_NOUN = String.raw`(?:revenue|sales|leads|bookings|appointments|enquiries|inquiries|conversions|sign-?ups|traffic|(?:patient|customer|client|booking|enquiry|appointment)\s+(?:numbers|volume|count))`;
const PEOPLE_OUTCOME_NOUN = String.raw`(?:customers|clients|patients)`;
const CHANGE_VERB = String.raw`(?:increase[sd]?|increasing|boost(?:s|ed|ing)?|double[sd]?|doubling|tripl(?:e|es|ed|ing)|grow(?:s|ing|n)?|rais(?:e|es|ed|ing)|lift(?:s|ed|ing)?|improv(?:e|es|ed|ing)|maximi[sz](?:e|es|ed|ing)|multipl(?:y|ies|ied|ying)|generat(?:e|es|ed|ing)|driv(?:e|es|ing)|drove)`;
// Up to three intervening words ("increase the number of bookings"), never a full stop.
const CHANGE_GAP = String.raw`(?:\s+\w+){0,3}\s+`;
const QUANTIFIER = String.raw`(?:more|additional|extra|higher|increased|fewer)`;
const GUARANTEE_MARKER = String.raw`(?:guarantee[sd]?|guaranteeing|definitely|certainly)`;
const PERFORMANCE_PROMISE = new RegExp(
  [
    String.raw`\b${CHANGE_VERB}\b${CHANGE_GAP}${OUTCOME_NOUN}\b`,
    String.raw`\b${QUANTIFIER}\s+(?:\w+\s+)?(?:${OUTCOME_NOUN}|${PEOPLE_OUTCOME_NOUN})\b`,
    String.raw`\b${GUARANTEE_MARKER}\b[^.]*\b(?:${OUTCOME_NOUN}|${PEOPLE_OUTCOME_NOUN})\b`,
  ].join('|'),
  'i',
);

// Claims the audit must never make (deterministic denylist).
const FORBIDDEN_CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d+(\.\d+)?\s?%/, 'numeric_percentage'],
  [/\b(revenue|profit|sales figures?)\b/i, 'revenue_claim'],
  [/\b(traffic|footfall|number of visitors)\b/i, 'traffic_claim'],
  [/\b(rank(ing)?|seo|search engine position)\b/i, 'ranking_claim'],
  [/\bconversion rate\b/i, 'conversion_rate_claim'],
  [/\b(competitor|competing (business|practice|site))\b/i, 'competitor_claim'],
  [PERFORMANCE_PROMISE, 'performance_promise'],
  [/\bvisitors? (will|definitely) leave\b/i, 'behavior_claim'],
  [/\b\d+\s*(stars?|reviews?|ratings?)\b/i, 'fabricated_rating_count'],
  [/\brated\s*\d/i, 'fabricated_rating'],
  [/\blost (revenue|customers|leads|sales)\b/i, 'loss_claim'],
];

// Unresolved TEMPLATE ARTIFACTS the model must never emit. This detects STRUCTURE
// (mustache/shell interpolation, bracketed sentinels, filler text) — never ordinary
// vocabulary. The bare word "placeholder" is deliberately NOT matched: on a website
// audit it is normal technical English ("placeholder anchors", "placeholder text
// disappears", "do not rely on placeholders as the only field description"), and
// policing it destroyed two paid audits. Maintaining an allow-list of innocent
// phrasings was the wrong shape of fix; structure is the reliable signal.
const TEMPLATE_ARTIFACT = new RegExp(
  [
    String.raw`\{\{[^}]*\}\}`, // {{VARIABLE}}
    String.raw`\$\{[^}]*\}`, // ${variable}
    String.raw`<\s*insert\b[^>]*>`, // <insert business name>
    String.raw`\[\s*(?:TODO|FIXME|PLACEHOLDER|INSERT|XXX+)\b[^\]]*\]`, // [TODO: ...] / [PLACEHOLDER]
    String.raw`\bTODO\s*:`, // TODO:
    String.raw`\bFIXME\b`,
    String.raw`lorem ipsum`,
    String.raw`\bX{4,}\b`, // XXXX sentinel
  ].join('|'),
  'i',
);
const PROMPT_LEAK =
  /(system prompt|you are an? (ai|assistant|expert)|as an ai|ignore (all )?previous instructions|do not reveal|reveal (your|the) (prompt|instructions)|my instructions)/i;

function textOf(strings: Array<string | null | undefined>): string {
  return strings.filter((s): s is string => Boolean(s)).join(' \n ');
}

/**
 * Deterministic validation of generator output against the evidence package. AI never
 * bypasses this. Returns all violations found (caller maps to SCHEMA_INVALID /
 * VALIDATION_FAILED and routes appropriately).
 */
export function validateGeneratorOutput(
  output: AuditGeneratorOutputParsed,
  pkg: EvidencePackage,
): ValidationResult {
  const violations: string[] = [];
  const evidenceIds = new Set(pkg.evidence.map((e) => e.id));
  const refs = new Set<string>();

  for (const f of output.findings) {
    if (refs.has(f.findingRef)) violations.push(`duplicate_finding_ref:${f.findingRef}`);
    refs.add(f.findingRef);

    if (f.evidenceIds.length === 0) violations.push(`no_evidence:${f.findingRef}`);
    for (const eid of f.evidenceIds) {
      if (!evidenceIds.has(eid)) violations.push(`evidence_outside_package:${f.findingRef}:${eid}`);
    }
    for (const url of f.affectedUrls) {
      const canon = canonicalizeUrl(url);
      if (!canon || !pkg.allowedCanonicalUrls.has(canon)) violations.push(`unsupported_url:${f.findingRef}`);
    }
    if (f.confidence < 0 || f.confidence > 1) violations.push(`confidence_range:${f.findingRef}`);

    const text = textOf([f.observation, f.businessImpact, f.recommendation, f.outreachAngle, f.uncertainty]);
    if (TEMPLATE_ARTIFACT.test(text)) violations.push(`template_artifact:${f.findingRef}`);
    if (PROMPT_LEAK.test(text)) violations.push(`prompt_leakage:${f.findingRef}`);
    for (const [re, label] of FORBIDDEN_CLAIM_PATTERNS) {
      if (re.test(text)) violations.push(`forbidden_claim:${label}:${f.findingRef}`);
    }
  }

  const summaryText = textOf([output.summary]);
  if (PROMPT_LEAK.test(summaryText)) violations.push('prompt_leakage:summary');

  return { ok: violations.length === 0, violations };
}

/** Validate reviewer references map to generator findings (no dup/missing/extra). */
export function validateReviewMapping(
  generator: AuditGeneratorOutputParsed,
  review: AuditReviewOutputParsed,
): ValidationResult {
  const violations: string[] = [];
  const genRefs = new Set(generator.findings.map((f) => f.findingRef));
  const seen = new Set<string>();
  for (const r of review.findings) {
    if (seen.has(r.findingRef)) violations.push(`duplicate_review_ref:${r.findingRef}`);
    seen.add(r.findingRef);
    if (!genRefs.has(r.findingRef)) violations.push(`review_ref_unknown:${r.findingRef}`);
    // Revised text is subject to the same forbidden-claim checks.
    const text = textOf([r.revisedObservation, r.revisedBusinessImpact, r.revisedRecommendation, r.revisedOutreachAngle]);
    if (TEMPLATE_ARTIFACT.test(text)) violations.push(`template_artifact:review:${r.findingRef}`);
    if (PROMPT_LEAK.test(text)) violations.push(`prompt_leakage:review:${r.findingRef}`);
    for (const [re, label] of FORBIDDEN_CLAIM_PATTERNS) {
      if (re.test(text)) violations.push(`forbidden_claim:${label}:review:${r.findingRef}`);
    }
  }
  return { ok: violations.length === 0, violations };
}
