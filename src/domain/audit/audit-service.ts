import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  buildGeneratorMessages,
  buildReviewerMessages,
  AUDIT_RUBRIC_VERSION,
  GENERATOR_PROMPT_VERSION,
  REVIEWER_PROMPT_VERSION,
} from '../../prompts/website-audit/index.js';
import {
  type ImageDetail,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type ReasoningEffort,
} from '../../integrations/llm/provider.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { hashCanonical } from '../../utils/hash.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import {
  AUDIT_SCHEMA_VERSION,
  auditGeneratorOutputSchema,
  auditReviewOutputSchema,
  GENERATOR_JSON_SCHEMA,
  REVIEWER_JSON_SCHEMA,
} from './audit-schema.js';
import { routeAuditOutcome } from './audit-outcome.js';
import { AUDIT_DEBUG_TTL_MS, type AuditDebugStore } from '../../integrations/audit/debug-store.js';
import {
  type AcceptedFinding,
  type AuditGeneratorOutput,
  type AuditOutcome,
  type FindingReview,
  MAX_FINDINGS,
  MAX_OUTREACH_SAFE_FINDINGS,
} from './audit-types.js';
import { buildReviewerPackage, type EvidencePackage } from './evidence-package.js';
import { OPPORTUNITY_RULES, scoreOpportunity, type OpportunityResult } from './opportunity-score.js';
import { describeViolation, validateGeneratorOutput, validateReviewMapping } from './validation.js';

export interface AuditConfig {
  auditModel: string;
  reviewModel: string;
  auditEffort: ReasoningEffort;
  reviewEffort: ReasoningEffort;
  imageDetail: ImageDetail;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxCallsPerLead: number;
  maxGeneratorAttempts: number;
  maxReviewerAttempts: number;
  maxCostUsdPerLead: number | null;
  severeCaptureLimitations: boolean;
  promptCacheEnabled: boolean;
  /** Upper bound on input tokens a single call can carry (from configured limits).
   * Enables a pre-call worst-case cost projection against the per-lead cap. */
  worstCaseInputTokensPerCall: number;
}

export interface ModelCallRecord {
  id: string;
  purpose: 'website_audit' | 'audit_review';
  provider: string;
  requestedModel: string;
  resolvedModel: string | null;
  promptVersion: string;
  schemaVersion: string;
  requestId: string | null;
  responseId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  status: string;
  classification: string;
  retryNumber: number;
  imageDetail: ImageDetail | null;
  // Deterministic validation rule codes that rejected this attempt's output (null when
  // the call did not reach validation, e.g. transient/refusal). Persisted so failed
  // paid calls stay diagnosable.
  validationViolations: string[] | null;
}

export interface AuditPersist {
  auditRun: {
    id: string;
    leadId: string;
    runId: string;
    captureRunId: string;
    outcome: AuditOutcome;
    rubricVersion: string;
    generatorPromptVersion: string;
    reviewerPromptVersion: string;
    schemaVersion: string;
    opportunityRulesVersion: string;
    opportunityRulesHash: string;
    provider: string;
    requestedAuditModel: string;
    resolvedAuditModel: string | null;
    reasoningEffort: string;
    reasoningMode: string;
    imageDetail: string;
    responseStore: boolean;
    inputFingerprint: string;
    generatorResponseId: string | null;
    reviewerResponseId: string | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    startedAt: Date;
    completedAt: Date;
  };
  accepted: AcceptedFinding[];
  reviews: FindingReview[];
  opportunity: OpportunityResult | null;
  modelCalls: ModelCallRecord[];
}

export interface AuditEnvelope {
  idempotencyKey: string;
  inputFingerprint: string;
  versions: { rubric: string; generatorPrompt: string; reviewerPrompt: string; schema: string; opportunityRules: string };
  stage: 'generator_done' | 'reviewer_done' | 'scored';
  persist: AuditPersist;
  computedCostUsd: number;
}

export interface EnvelopeStore {
  save(env: AuditEnvelope): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuditRunStore {
  persist(record: AuditPersist): Promise<void>;
  /** True when an audit run with this id is already persisted (idempotent replay). */
  exists(auditRunId: string): Promise<boolean>;
}
export interface AuditTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  audit: AuditRunStore;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface AuditUnitOfWork {
  transaction<T>(fn: (repos: AuditTxRepos) => Promise<T>): Promise<T>;
}

export interface AuditServiceDeps {
  provider: LlmProvider;
  uow: AuditUnitOfWork;
  envelopes: EnvelopeStore;
  debug?: AuditDebugStore; // optional diagnostics for failed generator validation
  logger: Logger;
  config: AuditConfig;
}

export interface AuditInput {
  leadId: string;
  captureRunId: string;
  package: EvidencePackage;
  /** Per-lead capture quality flag (PARTIAL_CAPTURE / missing profile) — dampens scoring. */
  severeCaptureLimitations?: boolean;
  /** Per-lead worst-case input tokens for a single call, computed from this package's
   * actual (bounded) image dimensions + evidence count. `null` means the image-token
   * cost could not be determined → all paid calls are blocked. `undefined` falls back
   * to the config-level estimate. */
  worstCaseInputTokensPerCall?: number | null;
}

export interface AuditResult {
  leadId: string;
  outcome: AuditOutcome;
  acceptedFindings: number;
  overallScore: number | null;
  callsMade: number;
}

const clsOf = (s: LlmResult['status']): string => s;

/** Best-effort finding-ref extraction from possibly-malformed model JSON (for debug). */
function extractFindingRefs(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings
    .map((f) => (f && typeof f === 'object' ? (f as { findingRef?: unknown }).findingRef : undefined))
    .filter((r): r is string => typeof r === 'string');
}

export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async audit(input: AuditInput, runId: string): Promise<AuditResult> {
    const c = this.deps.config;
    const startedAt = new Date();
    const auditRunId = randomUUID(); // stable for the whole audit (debug + persistence)
    const modelCalls: ModelCallRecord[] = [];
    let cost = 0;
    let callsMade = 0;
    // Set when a completed real-provider call reports a cost we cannot account for
    // (unknown model price or undeterminable context tier). Blocks all further calls.
    let costUnaccountable = false;

    const inputFingerprint = hashCanonical({
      lead: input.leadId,
      capture: input.captureRunId,
      evidence: input.package.evidence.map((e) => e.id).sort(),
      images: input.package.images.map((i) => i.sha256).sort(),
      versions: [AUDIT_RUBRIC_VERSION, GENERATOR_PROMPT_VERSION, REVIEWER_PROMPT_VERSION, AUDIT_SCHEMA_VERSION, OPPORTUNITY_RULES.version],
    });

    const isRealProvider = this.deps.provider.name !== 'mock';
    // Per-lead worst-case input tokens (from actual bounded image dims) when supplied,
    // else the config-level estimate. `null` = image-token cost undeterminable.
    const perLeadInputBound =
      input.worstCaseInputTokensPerCall === undefined ? c.worstCaseInputTokensPerCall : input.worstCaseInputTokensPerCall;
    // A call is permitted only if, after it completes at its WORST case, we still
    // respect the per-lead cost cap. This makes the cap a structural guarantee
    // (cost_so_far ≤ cap always holds), not a post-hoc overshoot.
    const canCall = (model: string): boolean => {
      if (costUnaccountable) return false;
      if (callsMade >= c.maxCallsPerLead) return false;
      if (c.maxCostUsdPerLead === null) return true;
      if (!isRealProvider) return cost < c.maxCostUsdPerLead; // mock has zero cost
      if (perLeadInputBound === null) return false; // image tokens/dims undeterminable → block
      const projected = worstCaseCostUsd(model, perLeadInputBound, c.maxOutputTokens);
      if (projected === null) return false; // unknown price / tier → cannot prove budget → block
      return cost + projected <= c.maxCostUsdPerLead;
    };

    const record = (
      purpose: ModelCallRecord['purpose'],
      promptVersion: string,
      res: LlmResult,
      retryNumber: number,
    ): ModelCallRecord => {
      const rec: ModelCallRecord = {
        id: randomUUID(),
        purpose,
        provider: res.provider,
        requestedModel: res.requestedModel,
        resolvedModel: res.resolvedModel,
        promptVersion,
        schemaVersion: AUDIT_SCHEMA_VERSION,
        requestId: res.requestId,
        responseId: res.responseId,
        inputTokens: res.usage.inputTokens,
        cachedInputTokens: res.usage.cachedInputTokens,
        cacheWriteTokens: res.usage.cacheWriteTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens,
        estimatedCostUsd: res.usage.estimatedCostUsd,
        latencyMs: res.latencyMs,
        status: res.status,
        classification: clsOf(res.status),
        retryNumber,
        imageDetail: res.imageDetail,
        validationViolations: null,
      };
      modelCalls.push(rec);
      callsMade += 1;
      cost += res.usage.estimatedCostUsd ?? 0;
      // A real provider returning null cost (unknown price / undeterminable context
      // tier) means we can no longer prove the budget — stop spending immediately.
      if (res.usage.estimatedCostUsd === null && res.provider !== 'mock') {
        costUnaccountable = true;
      }
      return rec;
    };

    // Record generator-validation failures both on the attempt record (persisted) and
    // in a local debug envelope (raw structured output + violation reasons; NO API key,
    // NO reasoning/CoT, NO screenshots, NO HTML).
    const recordValidationFailure = async (
      rec: ModelCallRecord,
      res: LlmResult,
      attempt: number,
      stage: 'schema_invalid' | 'validation_failed',
      violationCodes: string[],
      rawOutput: unknown,
      findingRefs: string[],
    ): Promise<void> => {
      rec.validationViolations = violationCodes;
      const now = new Date();
      await this.deps.debug?.record({
        auditRunId,
        leadId: input.leadId,
        responseId: res.responseId,
        stage,
        attempt,
        findingRefs,
        violations: violationCodes.map((code) => ({ code, message: describeViolation(code) })),
        rawOutput,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + AUDIT_DEBUG_TTL_MS).toISOString(),
      });
    };

    const finish = async (outcome: AuditOutcome, persist: AuditPersist): Promise<AuditResult> => {
      persist.auditRun.outcome = outcome;
      persist.auditRun.completedAt = new Date();
      persist.auditRun.totalCostUsd = cost;
      persist.modelCalls = modelCalls;
      // Envelope written before persistence so a failed DB write never repeats paid calls.
      await this.deps.envelopes.save({
        idempotencyKey: persist.auditRun.id,
        inputFingerprint,
        versions: { rubric: AUDIT_RUBRIC_VERSION, generatorPrompt: GENERATOR_PROMPT_VERSION, reviewerPrompt: REVIEWER_PROMPT_VERSION, schema: AUDIT_SCHEMA_VERSION, opportunityRules: OPPORTUNITY_RULES.version },
        stage: 'scored',
        persist,
        computedCostUsd: cost,
      });
      await this.deps.uow.transaction(async (repos) => {
        const lead = await repos.leads.getById(input.leadId);
        if (lead && lead.status === 'READY_FOR_AUDIT') {
          const route = routeAuditOutcome(outcome);
          if (route === 'AUDITED_THEN_OPPORTUNITY') {
            await repos.leadService.transition(input.leadId, 'AUDITED');
            await repos.leadService.transition(input.leadId, 'OPPORTUNITY_READY');
          } else if (route === 'NEEDS_MANUAL_REVIEW') {
            await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
          }
        }
        await repos.audit.persist(persist);
        await repos.events.record({
          leadId: input.leadId,
          runId,
          type: 'NOTE',
          fromStatus: null,
          toStatus: null,
          message: `audit: ${outcome} (${persist.accepted.length} findings, score ${persist.opportunity?.scores.overall ?? 'n/a'})`,
          data: { auditRunId: persist.auditRun.id, outcome },
        });
      });
      await this.deps.envelopes.delete(persist.auditRun.id);
      // On ultimate success, archive any debug envelopes from recovered failed attempts
      // (kept only for runs that ultimately fail, so `.audit-debug` shows real problems).
      if (outcome === 'AUDITED' || outcome === 'AUDITED_NO_ACTIONABLE_FINDINGS') {
        await this.deps.debug?.archiveForRun(auditRunId);
      }
      return { leadId: input.leadId, outcome, acceptedFindings: persist.accepted.length, overallScore: persist.opportunity?.scores.overall ?? null, callsMade };
    };

    const baseRun = (): AuditPersist['auditRun'] => ({
      id: auditRunId,
      leadId: input.leadId,
      runId,
      captureRunId: input.captureRunId,
      outcome: 'MANUAL_REVIEW_REQUIRED',
      rubricVersion: AUDIT_RUBRIC_VERSION,
      generatorPromptVersion: GENERATOR_PROMPT_VERSION,
      reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      opportunityRulesVersion: OPPORTUNITY_RULES.version,
      opportunityRulesHash: hashCanonical(OPPORTUNITY_RULES),
      provider: this.deps.provider.name,
      requestedAuditModel: c.auditModel,
      resolvedAuditModel: null,
      reasoningEffort: c.auditEffort,
      reasoningMode: 'standard',
      imageDetail: c.imageDetail,
      responseStore: c.store,
      inputFingerprint,
      generatorResponseId: null,
      reviewerResponseId: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      startedAt,
      completedAt: startedAt,
    });

    const emptyPersist = (outcome: AuditOutcome): AuditPersist => ({
      auditRun: { ...baseRun(), outcome },
      accepted: [],
      reviews: [],
      opportunity: null,
      modelCalls,
    });

    // ---- Generator (up to maxGeneratorAttempts) ----
    let generatorOutput: AuditGeneratorOutput | null = null;
    let generatorResponseId: string | null = null;
    let genRepairHint: string | null = null;
    for (let attempt = 0; attempt < c.maxGeneratorAttempts; attempt += 1) {
      if (!canCall(c.auditModel)) return finish('BUDGET_BLOCKED', emptyPersist('BUDGET_BLOCKED'));
      const msgs = buildGeneratorMessages(input.package, genRepairHint);
      const res = await this.deps.provider.generate(this.req('website_audit', msgs, GENERATOR_JSON_SCHEMA, 'audit', c, input.package));
      const rec = record('website_audit', GENERATOR_PROMPT_VERSION, res, attempt);
      if (res.status === 'refusal') { if (attempt + 1 < c.maxGeneratorAttempts) continue; return finish('MODEL_REFUSAL', emptyPersist('MODEL_REFUSAL')); }
      if (res.status === 'incomplete' || res.status === 'input_too_large') { genRepairHint = 'Return a smaller, complete result.'; continue; }
      if (res.status === 'rate_limited') return finish('RATE_LIMITED', emptyPersist('RATE_LIMITED'));
      if (res.status === 'transient') return finish('TRANSIENT_PROVIDER_ERROR', emptyPersist('TRANSIENT_PROVIDER_ERROR'));
      const parsed = auditGeneratorOutputSchema.safeParse(res.rawJson);
      if (!parsed.success) {
        const codes = parsed.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`);
        const refs = extractFindingRefs(res.rawJson);
        await recordValidationFailure(rec, res, attempt, 'schema_invalid', codes.length ? codes : ['schema_invalid'], res.rawJson, refs);
        genRepairHint = 'Your previous output did not match the schema. Return valid JSON only.';
        continue;
      }
      const validation = validateGeneratorOutput(parsed.data, input.package);
      if (!validation.ok) {
        await recordValidationFailure(rec, res, attempt, 'validation_failed', validation.violations, parsed.data, parsed.data.findings.map((f) => f.findingRef));
        genRepairHint = `Fix these evidence/claim problems: ${validation.violations.slice(0, 8).join('; ')}`;
        continue;
      }
      generatorOutput = parsed.data;
      generatorResponseId = res.responseId;
      break;
    }
    if (!generatorOutput) return finish('VALIDATION_FAILED', emptyPersist('VALIDATION_FAILED'));

    // ---- Independent reviewer (fresh call, no previous_response_id) ----
    const referenced = new Set(generatorOutput.findings.flatMap((f) => f.evidenceIds));
    const reviewerPkg = buildReviewerPackage(input.package, referenced);
    let review = null as import('./audit-schema.js').AuditReviewOutputParsed | null;
    let reviewerResponseId: string | null = null;
    let revRepairHint: string | null = null;
    for (let attempt = 0; attempt < c.maxReviewerAttempts; attempt += 1) {
      if (!canCall(c.reviewModel)) return finish('BUDGET_BLOCKED', emptyPersist('BUDGET_BLOCKED'));
      const msgs = buildReviewerMessages(reviewerPkg, generatorOutput, revRepairHint);
      const res = await this.deps.provider.generate(this.req('audit_review', msgs, REVIEWER_JSON_SCHEMA, 'review', c, reviewerPkg));
      record('audit_review', REVIEWER_PROMPT_VERSION, res, attempt);
      if (res.status === 'refusal') { if (attempt + 1 < c.maxReviewerAttempts) continue; return finish('MODEL_REFUSAL', emptyPersist('MODEL_REFUSAL')); }
      if (res.status === 'rate_limited') return finish('RATE_LIMITED', emptyPersist('RATE_LIMITED'));
      if (res.status === 'transient') return finish('TRANSIENT_PROVIDER_ERROR', emptyPersist('TRANSIENT_PROVIDER_ERROR'));
      if (res.status === 'incomplete' || res.status === 'input_too_large') { revRepairHint = 'Return a smaller, complete result.'; continue; }
      const parsed = auditReviewOutputSchema.safeParse(res.rawJson);
      if (!parsed.success) { revRepairHint = 'Return valid JSON only, matching the schema.'; continue; }
      const mapping = validateReviewMapping(generatorOutput, parsed.data);
      if (!mapping.ok) { revRepairHint = `Reference only the provided finding refs: ${mapping.violations.slice(0, 6).join('; ')}`; continue; }
      review = parsed.data;
      reviewerResponseId = res.responseId;
      break;
    }
    if (!review) return finish('VALIDATION_FAILED', emptyPersist('VALIDATION_FAILED'));
    if (review.overallDecision === 'REJECT' || review.overallDecision === 'MANUAL_REVIEW') {
      const p = emptyPersist('MANUAL_REVIEW_REQUIRED');
      p.reviews = review.findings;
      return finish('MANUAL_REVIEW_REQUIRED', p);
    }

    // ---- Accept + revise, cap, score (all deterministic) ----
    const accepted = this.acceptFindings(generatorOutput, review);
    const opportunity = scoreOpportunity(accepted, {
      severeCaptureLimitations: input.severeCaptureLimitations ?? c.severeCaptureLimitations,
    });

    const run = baseRun();
    run.resolvedAuditModel = modelCalls.find((m) => m.purpose === 'website_audit')?.resolvedModel ?? null;
    run.generatorResponseId = generatorResponseId;
    run.reviewerResponseId = reviewerResponseId;
    run.totalInputTokens = modelCalls.reduce((s, m) => s + (m.inputTokens ?? 0), 0);
    run.totalOutputTokens = modelCalls.reduce((s, m) => s + (m.outputTokens ?? 0), 0);

    const outcome: AuditOutcome = accepted.length === 0 ? 'AUDITED_NO_ACTIONABLE_FINDINGS' : 'AUDITED';
    return finish(outcome, { auditRun: run, accepted, reviews: review.findings, opportunity, modelCalls });
  }

  private acceptFindings(gen: AuditGeneratorOutput, review: import('./audit-schema.js').AuditReviewOutputParsed): AcceptedFinding[] {
    const byRef = new Map(review.findings.map((r) => [r.findingRef, r]));
    const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const accepted: AcceptedFinding[] = [];
    for (const f of gen.findings) {
      const r = byRef.get(f.findingRef);
      if (!r || r.decision === 'REJECT') continue;
      accepted.push({
        id: randomUUID(),
        findingRef: f.findingRef,
        category: f.category,
        observation: r.revisedObservation ?? f.observation,
        evidenceIds: f.evidenceIds,
        affectedUrls: f.affectedUrls,
        affectedProfiles: f.affectedProfiles,
        severity: f.severity,
        confidence: f.confidence,
        businessImpact: r.revisedBusinessImpact ?? f.businessImpact,
        recommendation: r.revisedRecommendation ?? f.recommendation,
        safeForOutreach: r.safeForOutreach && f.safeForOutreach,
        outreachAngle: r.revisedOutreachAngle ?? f.outreachAngle,
        uncertainty: f.uncertainty,
        reviewDecision: r.decision,
      });
    }
    accepted.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.confidence - a.confidence);
    const top = accepted.slice(0, MAX_FINDINGS);
    // Cap outreach-safe findings to the top N.
    let safeCount = 0;
    for (const f of top) {
      if (f.safeForOutreach) {
        safeCount += 1;
        if (safeCount > MAX_OUTREACH_SAFE_FINDINGS) f.safeForOutreach = false;
      }
    }
    return top;
  }

  private req(
    task: 'website_audit' | 'audit_review',
    msgs: { system: string; user: string },
    schema: Record<string, unknown>,
    kind: 'audit' | 'review',
    c: AuditConfig,
    pkg: EvidencePackage,
  ): LlmRequest {
    const model = kind === 'audit' ? c.auditModel : c.reviewModel;
    const promptVersion = kind === 'audit' ? GENERATOR_PROMPT_VERSION : REVIEWER_PROMPT_VERSION;
    // Cache key partitioned by task|model|prompt|rubric|schema — NEVER lead-specific,
    // so the shared prompt prefix is reusable across leads (generator ≠ reviewer keys).
    const cache = c.promptCacheEnabled
      ? {
          enabled: true as const,
          mode: 'implicit' as const,
          ttl: '30m' as const,
          key: `${task}|${model}|${promptVersion}|${AUDIT_RUBRIC_VERSION}|${AUDIT_SCHEMA_VERSION}`,
        }
      : undefined;
    return {
      task,
      system: msgs.system,
      user: msgs.user,
      images: pkg.images.map((img) => ({ id: img.id, mediaType: img.mediaType, dataBase64: img.dataBase64, detail: c.imageDetail })),
      outputSchema: schema,
      schemaName: task === 'website_audit' ? 'website_audit' : 'audit_review',
      model,
      reasoningEffort: kind === 'audit' ? c.auditEffort : c.reviewEffort,
      store: c.store,
      timeoutMs: c.timeoutMs,
      maxOutputTokens: c.maxOutputTokens,
      maxRetries: c.maxRetries,
      cache,
    };
  }
}
