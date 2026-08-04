/**
 * Phase 7A4A — hard safety gates (§7). These are ABSOLUTE: if any gate fails, the enriched email is FAIL
 * regardless of its quality score. Most gates are already enforced by `validateEnrichedComposition` /
 * the schema / the copy gate inside `composeEnrichedEmail`; this module aggregates them plus the
 * ordering / subject / section-count / mode / schema / hash-stability checks into one auditable list.
 */

import { COMPETITOR_EVIDENCE_MODE_APPROVED } from './constants.js';
import { buildEmailContext } from '../../domain/email/email-render.js';
import { composeEnrichedEmail } from '../../domain/email/competitor-email-composer.js';
import { claimSpansResolved, type ClaimSpan } from '../../domain/email/competitor-enrichment.js';
import { EMAIL_SCHEMA_VERSION } from '../../domain/email/email-schema.js';
import { type HarnessSuccess } from './harness.js';

/** Detects competitor language in the subject line (mirrors the copy gate's competitor regex intent). */
const SUBJECT_COMPETITOR_RE = /\b(?:competitors?|competition|other (?:clinics?|practices?|businesses)|market leaders?|rivals?)\b/i;

/**
 * Bounded, secret-free diagnostic emitted ONLY when the determinism gate fails. It names the differing
 * canonical field, shows the expected vs recomputed composed-message hash, and flags whether the body,
 * subject, claim spans, or provenance differed on re-composition. It never contains API keys, headers, or
 * raw provider material — only the deterministically recomputed email fields already present in the report.
 */
export interface DeterminismDiagnostic {
  differingField: 'composed_message_hash' | 'claim_spans' | 'both' | 'none';
  expectedHash: string;
  recomputedHash: string;
  bodyDiffered: boolean;
  subjectDiffered: boolean;
  claimSpansDiffered: boolean;
  provenanceDiffered: boolean;
}

export interface HardGateResult {
  id: string;
  passed: boolean;
  detail: string | null;
  /** Populated ONLY for the determinism gate (`unstable_claim_spans_or_hash`); null on that gate when it passes. */
  diagnostic?: DeterminismDiagnostic | null;
}

export interface HardGateReport {
  gates: HardGateResult[];
  allPassed: boolean;
  failedIds: string[];
}

function hasViolation(violations: string[], prefix: string): boolean {
  return violations.some((v) => v === prefix || v.startsWith(`${prefix}:`) || v.startsWith(prefix));
}

/** Two claim-span lists are identical iff every claim type, text, and bounded offset matches in order. */
function claimSpansEqual(a: ClaimSpan[], b: ClaimSpan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i]!;
    return s.claimType === t.claimType && s.text === t.text && s.start === t.start && s.end === t.end && s.valid === t.valid;
  });
}

/** Evaluate every hard safety gate against the enriched artifact produced by the harness. */
export function evaluateHardGates(result: HarnessSuccess): HardGateReport {
  const gates: HardGateResult[] = [];
  const add = (id: string, passed: boolean, detail: string | null = null, diagnostic?: DeterminismDiagnostic | null): void => {
    gates.push(diagnostic === undefined ? { id, passed, detail } : { id, passed, detail, diagnostic });
  };

  const enriched = result.enriched;
  const ev = enriched.enrichedValidation.violations;
  const base = enriched.baseValidation.violations;
  const body = enriched.rendered.body;
  const subject = enriched.rendered.subject;
  const pattern = result.plan.selection.pattern;
  const sections = enriched.sections;
  const ledger = enriched.ledger;

  const competitorSections = sections.filter((s) => s.kind === 'COMPETITOR_PATTERN');

  // 1. Unsupported competitor claim (sentence not verbatim from approved wording).
  add('unsupported_competitor_claim', !hasViolation(ev, 'competitor_sentence_not_in_body'));
  // 2. Unsupported prospect claim (prospect observation must cite an accepted finding id).
  const ctx = buildEmailContext(result.emailInputs);
  const prospectEntry = ledger.find((e) => e.claimType === 'PROSPECT_OBSERVATION');
  const prospectCited = Boolean(
    prospectEntry &&
    prospectEntry.prospectEvidenceIds.length > 0 &&
    prospectEntry.prospectEvidenceIds.every((id) => ctx.availableEvidenceIds.has(id)) &&
    prospectEntry.prospectEvidenceIds.some((id) => ctx.acceptedFindingIds.has(id)),
  );
  add('unsupported_prospect_claim', prospectCited, prospectCited ? null : 'prospect observation not bound to an accepted finding');
  // 3. Competitor identity / domain leakage.
  add('competitor_identity_or_domain_leakage', !hasViolation(ev, 'competitor_identity_leak'));
  // 4. Incorrect competitor count.
  add('incorrect_competitor_count', !hasViolation(ev, 'competitor_count_wording_mismatch') && !hasViolation(ev, 'competitor_count_form_inconsistent'));
  // 5. Sample-of-one comparison.
  add('sample_of_one', pattern.usableDenominator >= 2 && pattern.presentCount >= 2, `denominator=${String(pattern.usableDenominator)} present=${String(pattern.presentCount)}`);
  // 6. Stale / invalidated / superseded / unsafe evidence.
  add('stale_or_unsafe_evidence', result.revalidationFreshnessFailures.length === 0, result.revalidationFreshnessFailures.join('; ') || null);
  // 7. Package hash mismatch.
  add('package_hash_mismatch', result.revalidationHashMatched);
  // 8. Missing claim traceability.
  add(
    'missing_claim_traceability',
    !hasViolation(ev, 'missing_comparative_traceability') &&
    !hasViolation(ev, 'comparative_missing_pattern_ref') &&
    !hasViolation(ev, 'competitor_claim_missing_evidence_refs') &&
    !hasViolation(ev, 'contrast_missing_refs'),
  );
  // 9. Prohibited performance / conversion / revenue / ranking / volume claim.
  add(
    'prohibited_performance_claim',
    !hasViolation(ev, 'prohibited_claim') &&
    !base.includes('contains_performance_claim') &&
    !base.includes('contains_metric_claim') &&
    !base.includes('contains_unsupported_customer_behavior'),
  );
  // 10. Competitor context in the subject.
  add('competitor_context_in_subject', !SUBJECT_COMPETITOR_RE.test(subject) && !base.includes('competitor_language_in_subject'));
  // 11. Competitor section before the prospect observation.
  const firstIsProspect = sections[0]?.kind === 'PROSPECT_OBSERVATION';
  const prospectBeforeCompetitor =
    competitorSections.length === 0 ||
    (firstIsProspect && body.indexOf(sections[0]!.text) < body.indexOf(result.plan.competitorSentence));
  add('competitor_before_prospect_observation', firstIsProspect && prospectBeforeCompetitor);
  // 12. More than one competitor section.
  add('more_than_one_competitor_section', competitorSections.length === 1, `count=${String(competitorSections.length)}`);
  // 13. Consequence not supported by the approved label.
  add('unsupported_consequence', !hasViolation(ev, 'consequence_not_from_template') && !hasViolation(ev, 'consequence_label_unsupported') && !hasViolation(ev, 'consequence_sentence_not_in_body'));
  // 14. Final artifact still reports NONE.
  add('final_mode_not_approved', enriched.artifact.competitor_evidence_used === COMPETITOR_EVIDENCE_MODE_APPROVED);
  // 15. Final schema is not email-copy-schema-3.
  add('final_schema_not_schema3', enriched.schemaOk && enriched.schemaVersion === EMAIL_SCHEMA_VERSION);

  // 16. Unstable claim spans or message hash: every ledger claim resolves to a bounded body substring, and
  //     RE-COMPOSING THE IDENTICAL INPUTS reproduces the exact composed-message hash + claim spans. The
  //     recompose MUST use the ACTUAL base draft the artifact under test was composed from
  //     (`result.baseDraft`) — never a pinned fixture — otherwise a live (Terra-authored) base would always
  //     mismatch the fixture and report a false "not reproducible". This is the Phase 7A4B1 fix.
  const spansResolve = claimSpansResolved(enriched.claimSpans);
  const recomposed = composeEnrichedEmail({
    prospectDraft: result.baseDraft,
    emailInputs: result.emailInputs,
    validationCtx: ctx,
    plan: result.plan,
    pkg: result.enrichmentPackage,
  });
  const hashStable = recomposed.composedMessageHash === enriched.composedMessageHash;
  const spansStable = claimSpansEqual(recomposed.claimSpans, enriched.claimSpans);
  const stable = spansResolve && hashStable && spansStable;
  const diagnostic: DeterminismDiagnostic | null = stable
    ? null
    : {
      differingField: !hashStable && (!spansStable || !spansResolve) ? 'both' : !hashStable ? 'composed_message_hash' : 'claim_spans',
      expectedHash: enriched.composedMessageHash,
      recomputedHash: recomposed.composedMessageHash,
      bodyDiffered: recomposed.rendered.body !== enriched.rendered.body,
      subjectDiffered: recomposed.rendered.subject !== enriched.rendered.subject,
      claimSpansDiffered: !spansStable || !spansResolve,
      provenanceDiffered:
        recomposed.plan.selection.pattern.patternId !== enriched.plan.selection.pattern.patternId ||
        (recomposed.plan.selection.contrast?.contrastId ?? null) !== (enriched.plan.selection.contrast?.contrastId ?? null),
    };
  add(
    'unstable_claim_spans_or_hash',
    stable,
    stable
      ? null
      : `${hashStable ? 'claim spans not reproducible' : 'composed message hash not reproducible'} (field=${diagnostic!.differingField}, body_differed=${String(diagnostic!.bodyDiffered)})`,
    diagnostic,
  );

  // 17. Structured copy redundancy (Phase 7A4B2 §5): the enriched copy must never express the same approved
  //     consequence meaning twice — a rendered cautious consequence that duplicates the base recommendation,
  //     two external sentences serving one consequence label, or a contrast repeating the prospect
  //     observation. `validateEnrichedComposition` already surfaces these as `redundant_*` violations.
  const redundant = ev.filter((v) => v.startsWith('redundant_'));
  add('structured_copy_redundancy', redundant.length === 0, redundant.join('; ') || null);

  const failedIds = gates.filter((g) => !g.passed).map((g) => g.id);
  return { gates, allPassed: failedIds.length === 0, failedIds };
}
