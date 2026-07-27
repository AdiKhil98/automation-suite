import { canonicalStringify, hashCanonical, sha256Hex } from '../../utils/hash.js';
import { normalizeDomain } from '../leads/normalize.js';
import {
  KU64_EXPECTED_NORMALIZED_DOMAIN,
  KU64_EXPORT_SCHEMA_VERSION,
  KU64_EXPORT_SOURCE_TYPES,
  Ku64ExportError,
  type Ku64EvidenceExport,
  type Ku64ExportRecord,
  type Ku64ExportSourceType,
  type Ku64RawExportData,
} from './types.js';

const ALLOWED_SOURCE_TYPES = new Set<string>(KU64_EXPORT_SOURCE_TYPES);

export interface BuildEvidenceExportOptions {
  /** The operator-supplied --expected-domain flag (must normalize to ku64.de). */
  readonly expectedDomain: string;
  /** Must be exactly true — mirrors the required --confirm-production-read flag. */
  readonly confirmProductionRead: boolean;
  /** Injected timestamp so callers/tests control it; stored outside every hash. */
  readonly exportedAt: string;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Build a canonical export record (payload hashed on its own, without exportedAt). */
function makeRecord(
  sourceType: Ku64ExportSourceType,
  recordId: string,
  payload: Record<string, unknown>,
): Ku64ExportRecord {
  return { recordId, sourceType, payload, payloadSha256: sha256Hex(canonicalStringify(payload)) };
}

/**
 * Deterministically build a redacted evidence export for exactly one KU64 lead.
 *
 * Pure function: it performs no IO. Every fail-closed condition throws a typed
 * {@link Ku64ExportError}. The only records it can emit are the ones present in
 * `data`; it never fabricates, and it verifies that every record binds back to the
 * single target lead (unrelated records fail the export closed).
 */
export function buildEvidenceExport(
  data: Ku64RawExportData,
  opts: BuildEvidenceExportOptions,
): Ku64EvidenceExport {
  if (opts.confirmProductionRead !== true) {
    throw new Ku64ExportError('confirmation_required', 'production-read confirmation is required');
  }

  const normalizedExpected = normalizeDomain(opts.expectedDomain);
  if (normalizedExpected !== KU64_EXPECTED_NORMALIZED_DOMAIN) {
    throw new Ku64ExportError(
      'domain_not_allowed',
      `expected-domain must normalize to ${KU64_EXPECTED_NORMALIZED_DOMAIN} (got ${opts.expectedDomain})`,
    );
  }

  if (data.leads.length === 0) {
    throw new Ku64ExportError('lead_not_found', 'no lead matched the requested id');
  }
  if (data.leads.length > 1) {
    throw new Ku64ExportError('multiple_leads', 'more than one lead was returned for the requested id');
  }

  const lead = data.leads[0]!;
  const leadNormalized = lead.normalizedDomain ?? normalizeDomain(lead.domain);
  if (leadNormalized !== normalizedExpected) {
    throw new Ku64ExportError(
      'domain_mismatch',
      `lead normalized domain (${leadNormalized ?? 'null'}) does not match expected ${normalizedExpected}`,
    );
  }

  const leadId = lead.id;

  // --- Referential-binding guards: every record must belong to this lead. ---
  const require = (condition: boolean, detail: string): void => {
    if (!condition) throw new Ku64ExportError('unrelated_record', detail);
  };

  for (const f of data.leadFacts) require(f.leadId === leadId, `lead_fact ${f.id} is not bound to lead ${leadId}`);
  for (const q of data.qualificationResults) require(q.leadId === leadId, `qualification_result ${q.id} is not bound to lead ${leadId}`);
  for (const e of data.evidence) require(e.leadId === leadId, `evidence ${e.id} is not bound to lead ${leadId}`);

  for (const a of data.auditRuns) require(a.leadId === leadId, `audit_run ${a.id} is not bound to lead ${leadId}`);
  const auditRunIds = new Set(data.auditRuns.map((a) => a.id));
  for (const f of data.auditFindings) require(auditRunIds.has(f.auditRunId), `audit_finding ${f.id} references unknown audit_run`);
  const findingIds = new Set(data.auditFindings.map((f) => f.id));
  for (const r of data.auditReviews) require(auditRunIds.has(r.auditRunId), `audit_review ${r.id} references unknown audit_run`);
  const reviewIds = new Set(data.auditReviews.map((r) => r.id));
  for (const rf of data.auditReviewFindings) require(reviewIds.has(rf.auditReviewId), `audit_review_finding ${rf.id} references unknown audit_review`);
  for (const o of data.opportunityAssessments) {
    require(o.leadId === leadId, `opportunity_assessment ${o.id} is not bound to lead ${leadId}`);
    require(auditRunIds.has(o.auditRunId), `opportunity_assessment ${o.id} references unknown audit_run`);
  }

  for (const c of data.captureRuns) require(c.leadId === leadId, `capture_run ${c.id} is not bound to lead ${leadId}`);
  const captureRunIds = new Set(data.captureRuns.map((c) => c.id));
  for (const p of data.capturedPages) require(captureRunIds.has(p.captureRunId), `captured_page ${p.id} references unknown capture_run`);
  const pageIds = new Set(data.capturedPages.map((p) => p.id));
  for (const ce of data.captureEvidence) require(pageIds.has(ce.capturedPageId), `capture_evidence ${ce.id} references unknown captured_page`);
  const captureEvidenceIds = new Set(data.captureEvidence.map((ce) => ce.id));

  const qualificationResultIds = new Set(data.qualificationResults.map((q) => q.id));
  const leadFactIds = new Set(data.leadFacts.map((f) => f.id));
  for (const link of data.qualificationResultFacts) {
    require(qualificationResultIds.has(link.qualificationResultId), `qualification_result_fact references unknown qualification_result`);
    require(leadFactIds.has(link.leadFactId), `qualification_result_fact references unknown lead_fact`);
  }
  for (const link of data.auditFindingEvidence) {
    require(findingIds.has(link.auditFindingId), `audit_finding_evidence references unknown audit_finding`);
    require(captureEvidenceIds.has(link.captureEvidenceId), `audit_finding_evidence references unknown capture_evidence`);
  }

  // --- Build whitelisted, canonical records. ---
  const records: Ku64ExportRecord[] = [];

  records.push(
    makeRecord('lead', lead.id, {
      id: lead.id,
      businessName: lead.businessName,
      normalizedName: lead.normalizedName,
      domain: lead.domain,
      normalizedDomain: lead.normalizedDomain,
      city: lead.city,
      country: lead.country,
      status: lead.status,
      factsSource: lead.factsSource,
      factsSourceUrl: lead.factsSourceUrl,
      factsCapturedAt: iso(lead.factsCapturedAt),
    }),
  );

  for (const f of data.leadFacts) {
    records.push(
      makeRecord('lead_fact', f.id, {
        id: f.id,
        factType: f.factType,
        value: f.value,
        normalizedValue: f.normalizedValue,
        sourceType: f.sourceType,
        sourceUrl: f.sourceUrl,
        confidence: f.confidence,
        capturedAt: iso(f.capturedAt),
        isCurrent: f.isCurrent,
      }),
    );
  }

  for (const q of data.qualificationResults) {
    const supportingLeadFactIds = data.qualificationResultFacts
      .filter((l) => l.qualificationResultId === q.id)
      .map((l) => l.leadFactId)
      .sort();
    records.push(
      makeRecord('qualification_result', q.id, {
        id: q.id,
        campaign: q.campaign,
        qualificationStage: q.qualificationStage,
        rulesVersion: q.rulesVersion,
        rulesConfigHash: q.rulesConfigHash,
        decision: q.decision,
        priority: q.priority,
        nextStep: q.nextStep,
        businessViabilityScore: q.businessViabilityScore,
        auditabilityScore: q.auditabilityScore,
        contactabilityScore: q.contactabilityScore,
        opportunityScore: q.opportunityScore,
        deterministicScore: q.deterministicScore,
        triggeredRules: q.triggeredRules,
        missingRequiredFacts: q.missingRequiredFacts,
        reasons: q.reasons,
        inputFingerprint: q.inputFingerprint,
        supportingLeadFactIds,
        evaluatedAt: iso(q.evaluatedAt),
      }),
    );
  }

  for (const a of data.auditRuns) {
    records.push(
      makeRecord('audit_run', a.id, {
        id: a.id,
        captureRunId: a.captureRunId,
        outcome: a.outcome,
        rubricVersion: a.rubricVersion,
        generatorPromptVersion: a.generatorPromptVersion,
        reviewerPromptVersion: a.reviewerPromptVersion,
        schemaVersion: a.schemaVersion,
        opportunityRulesVersion: a.opportunityRulesVersion,
        opportunityRulesHash: a.opportunityRulesHash,
        inputFingerprint: a.inputFingerprint,
        startedAt: iso(a.startedAt),
        completedAt: iso(a.completedAt),
      }),
    );
  }

  for (const f of data.auditFindings) {
    const evidenceCaptureIds = data.auditFindingEvidence
      .filter((l) => l.auditFindingId === f.id)
      .map((l) => l.captureEvidenceId)
      .sort();
    records.push(
      makeRecord('audit_finding', f.id, {
        id: f.id,
        auditRunId: f.auditRunId,
        findingRef: f.findingRef,
        category: f.category,
        observation: f.observation,
        affectedUrls: f.affectedUrls,
        affectedProfiles: f.affectedProfiles,
        severity: f.severity,
        confidence: f.confidence,
        businessImpact: f.businessImpact,
        recommendation: f.recommendation,
        safeForOutreach: f.safeForOutreach,
        outreachAngle: f.outreachAngle,
        uncertainty: f.uncertainty,
        reviewDecision: f.reviewDecision,
        evidenceCaptureIds,
      }),
    );
  }

  for (const r of data.auditReviews) {
    records.push(
      makeRecord('audit_review', r.id, {
        id: r.id,
        auditRunId: r.auditRunId,
        overallDecision: r.overallDecision,
      }),
    );
  }

  for (const rf of data.auditReviewFindings) {
    records.push(
      makeRecord('audit_review_finding', rf.id, {
        id: rf.id,
        auditReviewId: rf.auditReviewId,
        findingRef: rf.findingRef,
        decision: rf.decision,
        evidenceSupported: rf.evidenceSupported,
        impactSupported: rf.impactSupported,
        safeForOutreach: rf.safeForOutreach,
        problems: rf.problems,
        revisedObservation: rf.revisedObservation,
        revisedBusinessImpact: rf.revisedBusinessImpact,
        revisedRecommendation: rf.revisedRecommendation,
        revisedOutreachAngle: rf.revisedOutreachAngle,
      }),
    );
  }

  for (const o of data.opportunityAssessments) {
    records.push(
      makeRecord('opportunity_assessment', o.id, {
        id: o.id,
        auditRunId: o.auditRunId,
        conversionScore: o.conversionScore,
        mobileScore: o.mobileScore,
        trustScore: o.trustScore,
        contactabilityScore: o.contactabilityScore,
        overallScore: o.overallScore,
        rulesVersion: o.rulesVersion,
        rulesHash: o.rulesHash,
        breakdown: o.breakdown,
        capsApplied: o.capsApplied,
      }),
    );
  }

  for (const e of data.evidence) {
    records.push(
      makeRecord('evidence', e.id, {
        id: e.id,
        sourceType: e.sourceType,
        sourceUrl: e.sourceUrl,
        claim: e.claim,
        confidence: e.confidence,
        selector: e.selector,
        capturedAt: iso(e.capturedAt),
      }),
    );
  }

  for (const c of data.captureRuns) {
    records.push(
      makeRecord('capture_run', c.id, {
        id: c.id,
        purpose: c.purpose,
        outcome: c.outcome,
        primaryUrl: c.primaryUrl,
        normalizedEvidenceFingerprint: c.normalizedEvidenceFingerprint,
        extractorVersion: c.extractorVersion,
        pageSelectionPolicyVersion: c.pageSelectionPolicyVersion,
        startedAt: iso(c.startedAt),
        completedAt: iso(c.completedAt),
      }),
    );
  }

  for (const p of data.capturedPages) {
    records.push(
      makeRecord('captured_page', p.id, {
        id: p.id,
        captureRunId: p.captureRunId,
        requestedUrl: p.requestedUrl,
        finalUrl: p.finalUrl,
        canonicalUrl: p.canonicalUrl,
        httpStatus: p.httpStatus,
        role: p.role,
        profile: p.profile,
        ok: p.ok,
        hasHorizontalOverflow: p.hasHorizontalOverflow,
      }),
    );
  }

  for (const ce of data.captureEvidence) {
    records.push(
      makeRecord('capture_evidence', ce.id, {
        id: ce.id,
        capturedPageId: ce.capturedPageId,
        evidenceType: ce.evidenceType,
        sourceUrl: ce.sourceUrl,
        profile: ce.profile,
        selector: ce.selector,
        normalizedValue: ce.normalizedValue,
      }),
    );
  }

  // Defensive: nothing outside the closed source-type set may be emitted.
  for (const r of records) {
    if (!ALLOWED_SOURCE_TYPES.has(r.sourceType)) {
      throw new Ku64ExportError('unknown_source_type', `refusing to emit unknown source type ${r.sourceType}`);
    }
  }

  // Stable sort by (sourceType, recordId) so ordering is deterministic.
  records.sort((a, b) =>
    a.sourceType === b.sourceType
      ? a.recordId.localeCompare(b.recordId)
      : a.sourceType.localeCompare(b.sourceType),
  );

  const recordsSha256 = hashCanonical(
    records.map((r) => ({ recordId: r.recordId, sourceType: r.sourceType, payloadSha256: r.payloadSha256 })),
  );

  return {
    schemaVersion: KU64_EXPORT_SCHEMA_VERSION,
    leadId,
    normalizedDomain: normalizedExpected,
    exportedAt: opts.exportedAt,
    recordCount: records.length,
    recordsSha256,
    records,
  };
}

/** Convenience: count exported records grouped by source type (for reporting). */
export function countBySourceType(exportDoc: Ku64EvidenceExport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of exportDoc.records) counts[r.sourceType] = (counts[r.sourceType] ?? 0) + 1;
  return counts;
}
