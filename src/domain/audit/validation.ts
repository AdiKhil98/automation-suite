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
    placeholder: 'Text contains placeholder content (e.g. TODO / lorem ipsum).',
    prompt_leakage: 'Text appears to leak system/prompt instructions.',
    forbidden_claim: 'Text makes a forbidden claim (e.g. revenue, traffic, ranking, percentage, guarantee).',
    review_ref_unknown: 'Reviewer referenced a finding ref not produced by the generator.',
    duplicate_review_ref: 'Reviewer referenced the same finding twice.',
  };
  return messages[rule] ?? `Validation rule "${rule}" failed.`;
}

// Claims the audit must never make (deterministic denylist).
const FORBIDDEN_CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d+(\.\d+)?\s?%/, 'numeric_percentage'],
  [/\b(revenue|profit|sales figures?)\b/i, 'revenue_claim'],
  [/\b(traffic|footfall|number of visitors)\b/i, 'traffic_claim'],
  [/\b(rank(ing)?|seo|search engine position)\b/i, 'ranking_claim'],
  [/\bconversion rate\b/i, 'conversion_rate_claim'],
  [/\b(competitor|competing (business|practice|site))\b/i, 'competitor_claim'],
  [/\b(will|guarantee[sd]?|definitely|boost|double|increase)\b[^.]*\b(revenue|sales|leads?|customers?|bookings?|traffic|conversions?)\b/i, 'performance_promise'],
  [/\bvisitors? (will|definitely) leave\b/i, 'behavior_claim'],
  [/\b\d+\s*(stars?|reviews?|ratings?)\b/i, 'fabricated_rating_count'],
  [/\brated\s*\d/i, 'fabricated_rating'],
  [/\blost (revenue|customers|leads|sales)\b/i, 'loss_claim'],
];

const PLACEHOLDER = /(TODO|FIXME|lorem ipsum|\{\{|<insert|xxxx|placeholder)/i;
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
    if (PLACEHOLDER.test(text)) violations.push(`placeholder:${f.findingRef}`);
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
    if (PLACEHOLDER.test(text)) violations.push(`placeholder:review:${r.findingRef}`);
    if (PROMPT_LEAK.test(text)) violations.push(`prompt_leakage:review:${r.findingRef}`);
    for (const [re, label] of FORBIDDEN_CLAIM_PATTERNS) {
      if (re.test(text)) violations.push(`forbidden_claim:${label}:review:${r.findingRef}`);
    }
  }
  return { ok: violations.length === 0, violations };
}
