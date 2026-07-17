import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  buildComposerGeneratorMessages,
  buildComposerReviewerMessages,
  type ComposerBrief,
  COMPOSER_GENERATOR_PROMPT_VERSION,
  COMPOSER_REVIEWER_PROMPT_VERSION,
  COMPOSER_RUBRIC_VERSION,
} from '../../../prompts/demo-composer/index.js';
import { type LlmProvider, type LlmResult, type ReasoningEffort } from '../../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../../integrations/llm/pricing.js';
import { COMPOSER_DEBUG_TTL_MS, type ComposerDebugStore } from '../../../integrations/demo/composer-debug-store.js';
import { type LeadFact } from '../../lead-facts/lead-fact.js';
import { type LeadService, type LeadStore } from '../../leads/lead-service.js';
import { type NewPipelineEvent } from '../../pipeline/pipeline-event.js';
import { type DemoOutputWriter } from '../demo-service.js';
import { type DemoStatus } from '../demo-types.js';
import {
  buildSpecContext,
  composeDemo,
  COMPOSER_TEMPLATE_ID,
  COMPOSER_TEMPLATE_VERSION,
  type ComposerFinding,
} from './compose.js';
import {
  COMPOSER_SCHEMA_VERSION,
  DESIGN_REVIEW_JSON_SCHEMA,
  DESIGN_SPEC_JSON_SCHEMA,
  designReviewSchema,
  designSpecSchema,
} from './composer-schema.js';
import { DESIGN_SPEC_VERSION } from './design-spec.js';
import { validateDesignSpec } from './spec-validation.js';

/** Accepted (Phase 6) finding with the text the composer needs to design around. */
export interface ComposerAcceptedFinding extends ComposerFinding {
  observation: string;
  recommendation: string;
}

export type ComposerOutcome =
  | 'DEMO_COMPOSED'
  | 'SPEC_INVALID'
  | 'RENDER_INVALID'
  | 'REVIEW_REJECTED'
  | 'SCHEMA_INVALID'
  | 'BUDGET_BLOCKED'
  | 'MODEL_REFUSAL'
  | 'RATE_LIMITED'
  | 'TRANSIENT_PROVIDER_ERROR';

export interface ComposerConfig {
  generatorModel: string;
  reviewerModel: string;
  generatorEffort: ReasoningEffort;
  reviewerEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxCallsPerDemo: number;
  maxCostUsdPerDemo: number | null;
  /** Worst-case input tokens for a single composer call (text-only). */
  worstCaseInputTokensPerCall: number;
  templateId: string;
  templateVersion: string;
}

export interface ComposerModelCall {
  id: string;
  purpose: 'demo_design' | 'demo_design_review';
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
  retryNumber: number;
  validationViolations: string[] | null;
}

export interface ComposerPersist {
  decision: {
    id: string;
    leadId: string;
    runId: string;
    decision: 'BUILD_DEMO';
    outcome: ComposerOutcome;
    reason: string;
    opportunityScore: number | null;
    minOpportunity: number;
    justifiedByScore: boolean;
    justifiedByFinding: boolean;
    briefRulesVersion: string;
  };
  demo: {
    id: string;
    leadId: string;
    demoDecisionId: string;
    templateId: string;
    templateVersion: string;
    path: string;
    status: DemoStatus;
    noindexVerified: boolean;
    disclosurePresent: boolean;
    contentHash: string | null;
    ctaKind: string | null;
    factsUsed: unknown;
    findingRefs: unknown;
  } | null;
  designSpec: {
    id: string;
    demoId: string;
    leadId: string;
    specVersion: string;
    schemaVersion: string;
    rubricVersion: string;
    generatorPromptVersion: string;
    reviewerPromptVersion: string;
    visualDirection: string;
    heroStrategy: string;
    headerVariant: string;
    footerVariant: string;
    primaryCtaIntent: string;
    primaryCtaLabelKey: string;
    componentIds: unknown;
    reviewerDecision: string;
    fabricationRisk: boolean;
    evidenceConsistent: boolean;
    ctaHonest: boolean;
    reviewerProblems: unknown;
    spec: unknown;
    provider: string;
    requestedGeneratorModel: string;
    requestedReviewerModel: string;
    generatorResponseId: string | null;
    reviewerResponseId: string | null;
    totalCostUsd: number;
  } | null;
  factInputs: Array<{ id: string; demoId: string; leadFactId: string; field: string }>;
  findingInputs: Array<{ id: string; demoId: string; auditFindingId: string; directive: string }>;
  modelCalls: ComposerModelCall[];
}

export interface ComposerRunStore {
  persist(record: ComposerPersist): Promise<void>;
}
export interface ComposerTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  composer: ComposerRunStore;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface ComposerUnitOfWork {
  transaction<T>(fn: (repos: ComposerTxRepos) => Promise<T>): Promise<T>;
}

export interface ComposerServiceDeps {
  provider: LlmProvider;
  uow: ComposerUnitOfWork;
  writer: DemoOutputWriter;
  logger: Logger;
  config: ComposerConfig;
  /** Optional diagnostics store: records every run's spec + reviewer verdict (git-ignored). */
  debug?: ComposerDebugStore;
}

export interface ComposerInput {
  leadId: string;
  facts: LeadFact[];
  opportunityScore: number | null;
  findings: ComposerAcceptedFinding[];
}

export interface ComposerResult {
  leadId: string;
  outcome: ComposerOutcome;
  demoPath: string | null;
  costUsd: number;
  callsMade: number;
}

/**
 * Phase 8B AI Demo Composer orchestration. The model produces a STRUCTURED DemoDesignSpec
 * (never markup); the spec is deterministically validated against verified facts + accepted
 * findings; an independent adversarial reviewer checks it; then a deterministic renderer
 * assembles vetted components and the shared security checks run. Generation is SEPARATE from
 * approval — a composed demo is GENERATED_PENDING_REVIEW and reaches DEMO_READY; nothing is
 * published. Cost is bounded by a pre-call worst-case projection against the per-demo cap.
 */
export class DemoComposerService {
  constructor(private readonly deps: ComposerServiceDeps) {}

  async compose(input: ComposerInput, runId: string): Promise<ComposerResult> {
    const c = this.deps.config;
    const modelCalls: ComposerModelCall[] = [];
    let cost = 0;
    let callsMade = 0;
    let costUnaccountable = false;
    const isRealProvider = this.deps.provider.name !== 'mock';

    const safeFindings = input.findings.filter((f) => f.safeForOutreach);
    const brief = this.brief(input, safeFindings);
    const specCtx = buildSpecContext(input.facts, safeFindings.map((f) => f.findingRef));

    // A call is permitted only if, at its worst case, the per-demo cap still holds.
    const canCall = (model: string): boolean => {
      if (costUnaccountable) return false;
      if (callsMade >= c.maxCallsPerDemo) return false;
      if (c.maxCostUsdPerDemo === null) return true;
      if (!isRealProvider) return cost < c.maxCostUsdPerDemo;
      const projected = worstCaseCostUsd(model, c.worstCaseInputTokensPerCall, c.maxOutputTokens);
      if (projected === null) return false;
      return cost + projected <= c.maxCostUsdPerDemo;
    };

    const record = (
      purpose: ComposerModelCall['purpose'],
      promptVersion: string,
      res: LlmResult,
      retryNumber: number,
    ): ComposerModelCall => {
      const rec: ComposerModelCall = {
        id: randomUUID(),
        purpose,
        provider: res.provider,
        requestedModel: res.requestedModel,
        resolvedModel: res.resolvedModel,
        promptVersion,
        schemaVersion: COMPOSER_SCHEMA_VERSION,
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
        retryNumber,
        validationViolations: null,
      };
      modelCalls.push(rec);
      callsMade += 1;
      cost += res.usage.estimatedCostUsd ?? 0;
      if (res.usage.estimatedCostUsd === null && res.provider !== 'mock') costUnaccountable = true;
      return rec;
    };

    const finish = async (outcome: ComposerOutcome, persist: ComposerPersist): Promise<ComposerResult> => {
      persist.modelCalls = modelCalls;
      const reachedReady = outcome === 'DEMO_COMPOSED' && persist.demo !== null;
      await this.deps.uow.transaction(async (repos) => {
        const lead = await repos.leads.getById(input.leadId);
        if (lead && lead.status === 'OPPORTUNITY_READY' && reachedReady) {
          await repos.leadService.transition(input.leadId, 'DEMO_DECIDED');
          await repos.leadService.transition(input.leadId, 'DEMO_READY');
        }
        await repos.composer.persist(persist);
        await repos.events.record({
          leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null,
          message: `compose: ${outcome}${persist.demo?.path ? ` (${persist.demo.path})` : ''}`,
          data: { demoDecisionId: persist.decision.id, outcome, costUsd: cost },
        });
      });
      return { leadId: input.leadId, outcome, demoPath: persist.demo?.path ?? null, costUsd: cost, callsMade };
    };

    const decisionId = randomUUID();
    const baseDecision = (outcome: ComposerOutcome): ComposerPersist['decision'] => ({
      id: decisionId, leadId: input.leadId, runId, decision: 'BUILD_DEMO', outcome,
      reason: `composer ${outcome}`, opportunityScore: input.opportunityScore, minOpportunity: 0,
      justifiedByScore: input.opportunityScore !== null, justifiedByFinding: safeFindings.length > 0,
      briefRulesVersion: DESIGN_SPEC_VERSION,
    });
    const failPersist = (outcome: ComposerOutcome): ComposerPersist => ({
      decision: baseDecision(outcome), demo: null, designSpec: null, factInputs: [], findingInputs: [], modelCalls,
    });

    // Diagnostics: record every run's spec + reviewer verdict (git-ignored), so composed,
    // rejected, AND failed runs are all inspectable. No API key / reasoning / HTML.
    const recordDebug = async (outcome: ComposerOutcome, spec: unknown | null, review: unknown | null, violations: string[]): Promise<void> => {
      const now = new Date();
      await this.deps.debug?.record({
        leadId: input.leadId, runId, outcome, spec, review, violations, costUsd: cost, callsMade,
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + COMPOSER_DEBUG_TTL_MS).toISOString(),
      });
    };

    // ---- Generator: produce a DemoDesignSpec ----
    if (!canCall(c.generatorModel)) return finish('BUDGET_BLOCKED', failPersist('BUDGET_BLOCKED'));
    const genMsgs = buildComposerGeneratorMessages(brief, null);
    const genRes = await this.deps.provider.generate({
      task: 'demo_design', system: genMsgs.system, user: genMsgs.user, images: [],
      outputSchema: DESIGN_SPEC_JSON_SCHEMA, schemaName: 'demo_design', model: c.generatorModel,
      reasoningEffort: c.generatorEffort, store: c.store, timeoutMs: c.timeoutMs,
      maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    const genRec = record('demo_design', COMPOSER_GENERATOR_PROMPT_VERSION, genRes, 0);
    if (genRes.status === 'refusal') return finish('MODEL_REFUSAL', failPersist('MODEL_REFUSAL'));
    if (genRes.status === 'rate_limited') return finish('RATE_LIMITED', failPersist('RATE_LIMITED'));
    if (genRes.status === 'transient' || genRes.status === 'incomplete' || genRes.status === 'input_too_large') {
      return finish('TRANSIENT_PROVIDER_ERROR', failPersist('TRANSIENT_PROVIDER_ERROR'));
    }
    const parsedSpec = designSpecSchema.safeParse(genRes.rawJson);
    if (!parsedSpec.success) {
      genRec.validationViolations = parsedSpec.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`);
      return finish('SCHEMA_INVALID', failPersist('SCHEMA_INVALID'));
    }
    const spec = parsedSpec.data;

    // ---- Deterministic spec validation (before spending on the reviewer) ----
    const specCheck = validateDesignSpec(spec, specCtx);
    if (!specCheck.ok) {
      genRec.validationViolations = specCheck.violations;
      await recordDebug('SPEC_INVALID', spec, null, specCheck.violations);
      return finish('SPEC_INVALID', failPersist('SPEC_INVALID'));
    }

    // ---- Independent adversarial reviewer ----
    if (!canCall(c.reviewerModel)) return finish('BUDGET_BLOCKED', failPersist('BUDGET_BLOCKED'));
    const revMsgs = buildComposerReviewerMessages(brief, spec);
    const revRes = await this.deps.provider.generate({
      task: 'demo_design_review', system: revMsgs.system, user: revMsgs.user, images: [],
      outputSchema: DESIGN_REVIEW_JSON_SCHEMA, schemaName: 'demo_design_review', model: c.reviewerModel,
      reasoningEffort: c.reviewerEffort, store: c.store, timeoutMs: c.timeoutMs,
      maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    record('demo_design_review', COMPOSER_REVIEWER_PROMPT_VERSION, revRes, 0);
    if (revRes.status === 'refusal') return finish('MODEL_REFUSAL', failPersist('MODEL_REFUSAL'));
    if (revRes.status === 'rate_limited') return finish('RATE_LIMITED', failPersist('RATE_LIMITED'));
    if (revRes.status === 'transient' || revRes.status === 'incomplete' || revRes.status === 'input_too_large') {
      return finish('TRANSIENT_PROVIDER_ERROR', failPersist('TRANSIENT_PROVIDER_ERROR'));
    }
    const parsedReview = designReviewSchema.safeParse(revRes.rawJson);
    if (!parsedReview.success) {
      await recordDebug('SCHEMA_INVALID', spec, null, ['reviewer_schema_invalid']);
      return finish('SCHEMA_INVALID', failPersist('SCHEMA_INVALID'));
    }
    const review = parsedReview.data;

    // Approval gate (rules per operator):
    //   REJECT  if decision === REJECT, OR fabricationRisk, OR deterministic validation fails.
    //   APPROVE if decision === APPROVE, OR (decision === REVISE AND every requested revision
    //           is deterministically applicable — needs no new fact, no new claim, no CTA
    //           destination change). evidenceConsistent/ctaHonest are recorded as signals but
    //           are already guaranteed by the deterministic layer, so they don't independently
    //           veto (that caused false rejections).
    // A rejected spec has no demo row to FK a design-spec record to; the rejection is captured
    // in the decision outcome, the pipeline event, the model_calls, and the diagnostics store.
    const reviseApplicable = review.decision === 'REVISE'
      && !review.revisionRequiresNewFacts && !review.revisionRequiresNewClaims && !review.revisionRequiresCtaChange;
    const approvable = review.decision === 'APPROVE' || reviseApplicable;
    if (!approvable || review.fabricationRisk) {
      await recordDebug('REVIEW_REJECTED', spec, review, []);
      return finish('REVIEW_REJECTED', failPersist('REVIEW_REJECTED'));
    }

    // ---- Deterministic render (validates spec again + security checks) ----
    const composed = composeDemo(spec, { facts: input.facts, findings: safeFindings });
    if (composed.outcome !== 'DEMO_COMPOSED' || !composed.built) {
      const outcome = composed.outcome === 'RENDER_INVALID' ? 'RENDER_INVALID' : 'SPEC_INVALID';
      await recordDebug(outcome, spec, review, composed.violations);
      return finish(outcome, failPersist(outcome));
    }
    const built = composed.built;

    // ---- Write files (outside tx) + build the full persist record ----
    const path = await this.deps.writer.write(input.leadId, { 'index.html': built.html, 'netlify.toml': built.netlifyToml });
    const demoId = randomUUID();
    const persist: ComposerPersist = {
      decision: baseDecision('DEMO_COMPOSED'),
      demo: {
        id: demoId, leadId: input.leadId, demoDecisionId: decisionId, templateId: c.templateId, templateVersion: c.templateVersion,
        path, status: 'GENERATED_PENDING_REVIEW', noindexVerified: true, disclosurePresent: true,
        contentHash: built.contentHash, ctaKind: built.ctaKind,
        factsUsed: built.factInputs.map((fi) => ({ factType: fi.factType, field: fi.field })),
        findingRefs: built.findingInputs.map((f) => f.findingRef),
      },
      designSpec: {
        id: randomUUID(), demoId, leadId: input.leadId, specVersion: DESIGN_SPEC_VERSION, schemaVersion: COMPOSER_SCHEMA_VERSION,
        rubricVersion: COMPOSER_RUBRIC_VERSION, generatorPromptVersion: COMPOSER_GENERATOR_PROMPT_VERSION,
        reviewerPromptVersion: COMPOSER_REVIEWER_PROMPT_VERSION, visualDirection: spec.visualDirection, heroStrategy: spec.heroStrategy,
        headerVariant: spec.headerVariant, footerVariant: spec.footerVariant, primaryCtaIntent: spec.primaryCtaIntent,
        primaryCtaLabelKey: spec.primaryCtaLabelKey, componentIds: built.componentIds, reviewerDecision: review.decision,
        fabricationRisk: review.fabricationRisk, evidenceConsistent: review.evidenceConsistent, ctaHonest: review.ctaHonest,
        reviewerProblems: review.problems, spec, provider: this.deps.provider.name, requestedGeneratorModel: c.generatorModel,
        requestedReviewerModel: c.reviewerModel, generatorResponseId: genRes.responseId, reviewerResponseId: revRes.responseId,
        totalCostUsd: cost,
      },
      factInputs: built.factInputs.map((fi) => ({ id: randomUUID(), demoId, leadFactId: fi.factId, field: fi.field })),
      findingInputs: built.findingInputs.map((f) => ({ id: randomUUID(), demoId, auditFindingId: f.findingId, directive: f.directive })),
      modelCalls,
    };
    await recordDebug('DEMO_COMPOSED', spec, review, []);
    return finish('DEMO_COMPOSED', persist);
  }

  private brief(input: ComposerInput, safeFindings: ComposerAcceptedFinding[]): ComposerBrief {
    const ctx = buildSpecContext(input.facts, safeFindings.map((f) => f.findingRef));
    const val = (t: string): string | null => {
      const f = input.facts.find((x) => x.factType === t && x.isCurrent && x.value.trim() !== '');
      return f ? f.value.trim() : null;
    };
    const servicesFact = val('services');
    const services = servicesFact ? servicesFact.split('|').map((s) => s.trim()).filter((s) => s !== '').slice(0, 8) : [];
    return {
      businessName: val('business_name'),
      city: val('city'),
      services,
      availableFactKeys: [...ctx.availableFactKeys],
      achievableCtaIntents: [...ctx.achievableCtaIntents],
      findings: safeFindings.map((f) => ({ findingRef: f.findingRef, category: f.category, observation: f.observation, recommendation: f.recommendation })),
    };
  }
}

export { COMPOSER_TEMPLATE_ID, COMPOSER_TEMPLATE_VERSION };
