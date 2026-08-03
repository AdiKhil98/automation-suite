/**
 * Phase 7A4A — offline synthetic end-to-end validation harness. Drives the REAL Phase 7A1–7A3B domain
 * services over in-memory adapters (Decision D1) to produce, from ONE fictional scenario, a prospect-only
 * BASELINE email and an ENRICHED email that differ only by an approved competitor pattern package.
 *
 * It NEVER hand-builds the final approved package or the enriched claim ledger, never bypasses package
 * approval, and performs zero network, live-model, Gmail, Sheets, or database work. Every timestamp is the
 * fixture clock, and every identifier that flows into an output hash is normalized to a deterministic,
 * content-derived value so two runs are byte-identical.
 */

import { CompetitorResearchService } from '../../domain/competitor/research-service.js';
import { CompetitorCaptureService } from '../../domain/competitor/capture-service.js';
import { CompetitorPatternService } from '../../domain/competitor/pattern-service.js';
import { MockCaptureProvider } from '../../integrations/capture/mock-capture.js';
import { isApprovableConfidence, validatePackage } from '../../domain/competitor/pattern-validator.js';
import { supportingEvidenceFailure } from '../../domain/competitor/pattern-eligibility.js';
import { evaluateFreshness } from '../../domain/competitor/evidence-freshness.js';
import {
  type CompetitorPatternPackage,
  type PatternBuildInput,
  type PatternCompetitorInput,
  type PatternEvidenceItem,
} from '../../domain/competitor/pattern-types.js';
import { type SelectedCompetitorInput } from '../../domain/competitor/capture-eligibility.js';
import { type ConsequenceLabel, type PatternConfidence } from '../../domain/competitor/pattern-constants.js';
import { type EvidenceCategory } from '../../domain/competitor/evidence-types.js';
import {
  composeEnrichedEmail,
  type ComposedEnrichedEmail,
} from '../../domain/email/competitor-email-composer.js';
import {
  planEnrichment,
  type EnrichmentPackage,
  type EnrichmentPlan,
  type EnrichmentProspectFinding,
} from '../../domain/email/competitor-enrichment.js';
import { buildEmailContext, renderEmail, type EmailInputs } from '../../domain/email/email-render.js';
import { validateEmail, type EmailValidationResult } from '../../domain/email/email-validation.js';
import { emailWriterSchema, EMAIL_SCHEMA_VERSION, type EmailWriterParsed } from '../../domain/email/email-schema.js';
import { type AuditCategory } from '../../domain/audit/audit-types.js';
import { type RenderedEmail } from '../../domain/email/email-types.js';
import {
  InMemoryCaptureStore,
  InMemoryPatternStore,
  InMemoryResearchStore,
} from './inmemory-competitor-stores.js';
import {
  baseEmailDraft,
  competitorCandidates,
  competitorPages,
  FIXTURE_NOW,
  leadFacts,
  PROSPECT_NORMALIZED_DOMAIN,
  prospectEvidenceInput,
  prospectProfile,
  safeFindings,
  SCENARIO_LABEL,
  SYNTHETIC_LEAD_ID,
} from '../../fixtures/competitor-email-validation/synthetic-dental-scenario.js';

const MAX_AGE_DAYS = 30;
const SYNTHETIC_OPERATOR = 'synthetic-operator-7a4a';
const NAME_TOKEN_MIN = 4;

/** Stable competitor identity used across capture + pattern build (opaque label; keeps hashes stable). */
function candId(normalizedDomain: string): string {
  return `cand-${normalizedDomain}`;
}

function identityTokens(names: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    for (const tok of name.toLowerCase().split(/[^a-z0-9äöüß]+/i)) {
      if (tok.trim().length >= NAME_TOKEN_MIN) set.add(tok.trim());
    }
  }
  return [...set].sort();
}

/** A rendered artifact (subject + body) plus its evidence mode + schema shape, for either email. */
export interface RenderedArtifact {
  subject: string;
  body: string;
  competitorEvidenceUsed: EmailWriterParsed['competitor_evidence_used'];
  schemaVersion: string;
  schemaOk: boolean;
  rendered: RenderedEmail;
}

export type HarnessStage =
  | 'research'
  | 'capture'
  | 'pattern'
  | 'approval'
  | 'revalidation'
  | 'plan'
  | 'compose';

export interface HarnessFailure {
  ok: false;
  failureStage: HarnessStage;
  reason: string;
}

export interface HarnessSuccess {
  ok: true;
  scenarioLabel: string;
  leadId: string;
  /** Real pipeline provenance. */
  researchOutcome: string;
  acceptedCompetitors: number;
  captureOutcome: string;
  evidenceCount: number;
  package: CompetitorPatternPackage;
  enrichmentPackage: EnrichmentPackage;
  approvedBy: string;
  revalidationHashMatched: boolean;
  revalidationFreshnessFailures: string[];
  plan: EnrichmentPlan;
  /** BASELINE (prospect-only, mode NONE) and ENRICHED artifacts. */
  baseline: RenderedArtifact;
  baselineValidation: EmailValidationResult;
  enriched: ComposedEnrichedEmail;
  emailInputs: EmailInputs;
}

export type HarnessOutcome = HarnessSuccess | HarnessFailure;

function fail(stage: HarnessStage, reason: string): HarnessFailure {
  return { ok: false, failureStage: stage, reason };
}

/** Map a captured competitor evidence item onto the flat pattern-evidence shape (positive presence). */
function toPatternEvidenceItem(
  id: string,
  e: {
    captureRunId: string;
    competitorCandidateId: string;
    evidenceCategory: EvidenceCategory;
    observationKind: string;
    confidence: PatternConfidence;
    freshnessStatus: string;
    safeForOutreach: boolean;
    active: boolean;
    sourcePageUrl: string;
    numericValue: number | null;
    capturedAt: Date;
  },
): PatternEvidenceItem {
  return {
    id,
    captureRunId: e.captureRunId,
    competitorCandidateId: e.competitorCandidateId,
    evidenceCategory: e.evidenceCategory,
    observationKind: e.observationKind,
    confidence: e.confidence,
    storedFreshness: e.freshnessStatus,
    safeForOutreach: e.safeForOutreach,
    active: e.active,
    sourcePageUrl: e.sourcePageUrl,
    numericValue: e.numericValue,
    capturedAt: e.capturedAt,
    polarity: 'PRESENT',
    inspectionScope: null,
  };
}

/**
 * Run the complete offline pipeline. Every stage uses the real service; a prerequisite that cannot be
 * met returns a typed failure (never a silent prospect-only "success").
 */
export async function runValidationHarness(): Promise<HarnessOutcome> {
  const now = FIXTURE_NOW;

  // --- Stage 1: real Phase 7A1 selection (persisted to the in-memory research store). ---
  const researchStore = new InMemoryResearchStore();
  const research = await new CompetitorResearchService(researchStore).run(
    prospectProfile,
    competitorCandidates,
    { provider: 'fixture', apply: true },
  );
  if (!research.runRecordId) return fail('research', 'research run did not persist');
  const acceptedRows = researchStore.getCandidates(research.runRecordId).filter((c) => c.disposition === 'ACCEPTED');
  if (acceptedRows.length < 2) {
    return fail('research', `only ${String(acceptedRows.length)} competitor(s) accepted; need at least two comparable competitors`);
  }

  // --- Stage 2: real Phase 7A2 capture + deterministic evidence rules (fixture pages, no network). ---
  const captureStore = new InMemoryCaptureStore();
  const selected: SelectedCompetitorInput[] = acceptedRows.map((c) => ({
    competitorCandidateId: candId(c.normalizedDomain ?? ''),
    disposition: 'ACCEPTED',
    normalizedDomain: c.normalizedDomain,
  }));
  const capture = await new CompetitorCaptureService({
    provider: new MockCaptureProvider(competitorPages()),
    uow: captureStore,
    config: {
      maxPages: 2, maxDepth: 1, navigationTimeoutMs: 15_000, totalTimeoutMs: 30_000,
      maxScreenshotBytes: 2_000_000, fullPageMaxHeightPx: 8_000, blockTrackers: true, blockMedia: true,
      maxAgeDays: MAX_AGE_DAYS,
    },
    now: () => now,
  }).run({
    leadId: SYNTHETIC_LEAD_ID,
    researchRunId: research.runRecordId,
    prospectNormalizedDomain: PROSPECT_NORMALIZED_DOMAIN,
    competitors: selected,
    method: 'FIXTURE',
    provider: 'fixture',
    liveEnabled: false,
    liveConfirmed: false,
    apply: true,
  });
  if (!capture.runRecordId) return fail('capture', 'capture run did not persist');
  const rawEvidence = captureStore.getEvidence(capture.runRecordId);
  if (rawEvidence.length === 0) return fail('capture', 'capture produced no competitor evidence');
  const okPageCandidates = new Set(captureStore.getPages(capture.runRecordId).filter((p) => p.ok).map((p) => p.competitorCandidateId));

  // Deterministic evidence ids (content-ordered) so packageHash + composed hash are stable across runs.
  const orderedEvidence = [...rawEvidence].sort((a, b) =>
    a.competitorCandidateId.localeCompare(b.competitorCandidateId) ||
    a.evidenceCategory.localeCompare(b.evidenceCategory) ||
    a.profile.localeCompare(b.profile) ||
    a.sourcePageUrl.localeCompare(b.sourcePageUrl),
  );
  const evidenceById = new Map<string, PatternEvidenceItem>();
  const evidenceByCandidate = new Map<string, PatternEvidenceItem[]>();
  orderedEvidence.forEach((e, i) => {
    const stableId = `evi-${String(i + 1).padStart(4, '0')}`;
    const item = toPatternEvidenceItem(stableId, {
      captureRunId: e.captureRunId,
      competitorCandidateId: e.competitorCandidateId,
      evidenceCategory: e.evidenceCategory,
      observationKind: e.observationKind,
      confidence: e.confidence as PatternConfidence,
      freshnessStatus: e.freshnessStatus,
      safeForOutreach: e.safeForOutreach,
      active: e.active,
      sourcePageUrl: e.sourcePageUrl,
      numericValue: e.numericValue,
      capturedAt: e.capturedAt,
    });
    evidenceById.set(stableId, item);
    const list = evidenceByCandidate.get(e.competitorCandidateId) ?? [];
    list.push(item);
    evidenceByCandidate.set(e.competitorCandidateId, list);
  });

  // --- Stage 3: real Phase 7A3A pattern generation (persisted DRAFT). ---
  const competitors: PatternCompetitorInput[] = acceptedRows.map((c) => {
    const id = candId(c.normalizedDomain ?? '');
    return {
      competitorCandidateId: id,
      brandKey: c.brandKey,
      businessName: c.businessName,
      parentBrand: c.parentBrand,
      selected: true,
      captureActive: true,
      capturedOk: okPageCandidates.has(id),
      evidence: evidenceByCandidate.get(id) ?? [],
    };
  });
  const buildInput: PatternBuildInput = {
    leadId: SYNTHETIC_LEAD_ID,
    researchRunId: research.runRecordId,
    captureRunIds: [capture.runRecordId],
    competitors,
    prospect: prospectEvidenceInput(),
    now,
    maxAgeDays: MAX_AGE_DAYS,
  };
  const patternStore = new InMemoryPatternStore();
  const patternRun = await new CompetitorPatternService({ uow: patternStore }).run(buildInput, true);
  if (!patternRun.packageRecordId) return fail('pattern', 'pattern package did not persist');
  const pkg = patternRun.package;
  const competitorNames = competitors.flatMap((c) => [c.businessName, c.parentBrand]);

  // --- Stage 4: explicit synthetic operator approval (real gates, then DRAFT → APPROVED). ---
  const validation = validatePackage(pkg, competitorNames);
  const approvalGates: string[] = [];
  if (!validation.ok) approvalGates.push(...validation.errors.map((e) => `validation:${e}`));
  if (!isApprovableConfidence(pkg.confidence)) approvalGates.push(`confidence_${pkg.confidence}_not_approvable`);
  if (pkg.prohibitedClaims.length > 0) approvalGates.push(`prohibited_claims:${pkg.prohibitedClaims.join(',')}`);
  const freshnessFailures = recheckFreshness(pkg, evidenceById, buildInput.prospect, now);
  approvalGates.push(...freshnessFailures.map((f) => `freshness:${f}`));
  if (approvalGates.length > 0) return fail('approval', `package not approvable: ${approvalGates.join('; ')}`);
  const approved = patternStore.approvePackage(patternRun.packageRecordId, SYNTHETIC_OPERATOR, now);
  if (!approved) return fail('approval', 'in-memory approval transition failed');

  // --- Stage 5: composition-time revalidation (recompute the package + compare hash + re-check freshness). ---
  const dummyUow = { transaction: async <T>(): Promise<T> => { throw new Error('revalidation must not persist'); } };
  const recomputed = new CompetitorPatternService({ uow: dummyUow }).build({ ...buildInput, now });
  const hashMatched = recomputed.package.packageHash === pkg.packageHash;
  const revalFreshness = recheckFreshness(pkg, evidenceById, buildInput.prospect, now);
  if (!hashMatched) return fail('revalidation', 'recomputed package hash does not match the approved hash');
  if (revalFreshness.length > 0) return fail('revalidation', `supporting evidence no longer valid: ${revalFreshness.join('; ')}`);

  // --- Map the approved package onto the enrichment contract (deterministic ids; real hash + status). ---
  const enrichmentPackage: EnrichmentPackage = {
    packageId: `pkg-${SCENARIO_LABEL}`,
    version: patternRun.version ?? 1,
    packageHash: pkg.packageHash,
    status: 'APPROVED',
    leadId: SYNTHETIC_LEAD_ID,
    patterns: pkg.patterns.map((p) => ({
      patternId: `pat-${p.category}`,
      category: p.category,
      result: p.result,
      presentCount: p.presentCount,
      usableDenominator: p.usableDenominator,
      confidence: p.confidence,
      wordingForm: p.wordingForm,
      wordingText: p.wordingText,
      consequenceLabel: p.consequenceLabel,
      isDepth: p.isDepth,
      evidenceItemIds: [...p.evidenceItemIds],
    })),
    contrasts: pkg.contrasts.map((c) => ({
      contrastId: `con-${c.category}`,
      category: c.category,
      consequenceLabel: c.consequenceLabel as ConsequenceLabel,
      prospectEvidenceRef: c.prospectEvidenceRef,
      confidence: c.confidence,
    })),
    identityTokens: identityTokens(competitorNames),
  };

  // --- Stage 6: baseline + enriched composition (both from the SAME pinned base draft). ---
  const emailInputs: EmailInputs = { facts: leadFacts, findings: safeFindings, demo: null };
  const validationCtx = buildEmailContext(emailInputs);

  const baselineParsed = emailWriterSchema.safeParse(baseEmailDraft);
  const baselineRendered = renderEmail(baseEmailDraft, emailInputs);
  const baselineValidation = validateEmail(baseEmailDraft, validationCtx);
  const baseline: RenderedArtifact = {
    subject: baselineRendered.subject,
    body: baselineRendered.body,
    competitorEvidenceUsed: baseEmailDraft.competitor_evidence_used,
    schemaVersion: EMAIL_SCHEMA_VERSION,
    schemaOk: baselineParsed.success,
    rendered: baselineRendered,
  };

  const enrichmentFindings: EnrichmentProspectFinding[] = safeFindings.map((f) => ({
    evidenceId: f.id,
    findingRef: f.findingRef,
    category: f.category as AuditCategory,
  }));
  const outcome = planEnrichment({
    leadId: SYNTHETIC_LEAD_ID,
    language: validationCtx.language,
    package: enrichmentPackage,
    safeFindings: enrichmentFindings,
    requestedPatternId: null,
  });
  if (!outcome.ok) return fail('plan', `enrichment planning failed closed: ${outcome.reason}`);

  const enriched = composeEnrichedEmail({
    prospectDraft: baseEmailDraft,
    emailInputs,
    validationCtx,
    plan: outcome.plan,
    pkg: enrichmentPackage,
  });

  return {
    ok: true,
    scenarioLabel: SCENARIO_LABEL,
    leadId: SYNTHETIC_LEAD_ID,
    researchOutcome: research.selection.outcome,
    acceptedCompetitors: acceptedRows.length,
    captureOutcome: capture.outcome,
    evidenceCount: rawEvidence.length,
    package: pkg,
    enrichmentPackage,
    approvedBy: SYNTHETIC_OPERATOR,
    revalidationHashMatched: hashMatched,
    revalidationFreshnessFailures: revalFreshness,
    plan: outcome.plan,
    baseline,
    baselineValidation,
    enriched,
    emailInputs,
  };
}

/**
 * Re-evaluate, at `now`, every piece of evidence the package depends on — mirrors the production
 * `recheckSupportingEvidence` but over in-memory rows, reusing the SAME pure rule functions.
 */
function recheckFreshness(
  pkg: CompetitorPatternPackage,
  evidenceById: Map<string, PatternEvidenceItem>,
  prospect: PatternBuildInput['prospect'],
  now: Date,
): string[] {
  const failures: string[] = [];
  for (const ref of pkg.evidenceRefs) {
    if (ref.kind !== 'COMPETITOR') continue;
    const item = evidenceById.get(ref.evidenceItemId);
    if (!item) {
      failures.push(`competitor evidence ${ref.evidenceItemId} no longer exists`);
      continue;
    }
    const failure = supportingEvidenceFailure(
      { evidenceItemId: item.id, active: item.active, safeForOutreach: item.safeForOutreach, capturedAt: item.capturedAt, captureActive: true },
      now,
      MAX_AGE_DAYS,
    );
    if (failure) failures.push(failure);
  }
  if (pkg.contrasts.length > 0) {
    if (!prospect.captureRunId || !prospect.capturedOk) {
      failures.push('prospect capture backing the contrast(s) is no longer available');
    } else if (prospect.capturedAt && evaluateFreshness(prospect.capturedAt, now, MAX_AGE_DAYS) !== 'FRESH') {
      failures.push('prospect capture backing the contrast(s) is now stale');
    }
  }
  return failures;
}
