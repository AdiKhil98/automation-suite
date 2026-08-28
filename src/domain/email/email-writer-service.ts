import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  buildEmailReviewerMessages,
  buildEmailWriterMessages,
  type EmailBrief,
  EMAIL_REVIEWER_PROMPT_VERSION,
  EMAIL_WRITER_PROMPT_VERSION,
} from '../../prompts/email/index.js';
import { type LlmProvider, type LlmResult, type ReasoningEffort } from '../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { EMAIL_DEBUG_TTL_MS, type EmailDebugStore } from '../../integrations/email/email-debug-store.js';
import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type LeadStatus } from '../leads/status.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { EMAIL_SCHEMA_VERSION, EMAIL_REVIEW_JSON_SCHEMA, EMAIL_WRITER_JSON_SCHEMA, emailReviewSchema, emailWriterSchema } from './email-schema.js';
import { buildEmailBrief } from './email-brief.js';
import { buildEmailContext, type EmailDemoMeta, type EmailFinding, type EmailInputs, renderEmail } from './email-render.js';
import { EMAIL_WRITER_RULES_VERSION, type EmailStatus } from './email-types.js';
import { validateEmail } from './email-validation.js';

export type EmailOutcome =
  | 'APPROVED_READY'
  | 'APPROVED_WAITING_URL'
  | 'REVIEW_REJECTED'
  | 'VALIDATION_FAILED'
  | 'SCHEMA_INVALID'
  | 'BUDGET_BLOCKED'
  | 'MODEL_REFUSAL'
  | 'RATE_LIMITED'
  | 'TRANSIENT_PROVIDER_ERROR';

export interface EmailConfig {
  writerModel: string;
  reviewerModel: string;
  writerEffort: ReasoningEffort;
  reviewerEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxCallsPerLead: number;
  maxCostUsdPerLead: number | null;
  worstCaseInputTokensPerCall: number;
}

export interface EmailModelCall {
  id: string;
  purpose: 'email_write' | 'email_review';
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

export interface EmailPersist {
  leadId: string;
  email: {
    id: string;
    leadId: string;
    demoId: string | null;
    runId: string;
    subject: string;
    body: string;
    ctaKind: string;
    hasDemoUrlPlaceholder: boolean;
    status: EmailStatus;
    writerPromptVersion: string;
    reviewerPromptVersion: string;
    schemaVersion: string;
    rulesVersion: string;
    provider: string;
    requestedWriterModel: string;
    requestedReviewerModel: string;
    writerResponseId: string | null;
    reviewerResponseId: string | null;
    reviewerDecision: string | null;
    fabricationRisk: boolean | null;
    personalizationSupported: boolean | null;
    claimHonest: boolean | null;
    reviewerProblems: unknown;
    totalCostUsd: number;
  } | null;
  factInputs: Array<{ id: string; emailId: string; leadFactId: string; field: string }>;
  findingInputs: Array<{ id: string; emailId: string; auditFindingId: string; directive: string }>;
  modelCalls: EmailModelCall[];
  /** Terminal lead state for this run (routing), applied from DEMO_READY/DEMO_DECIDED/OPPORTUNITY_READY. */
  routeTo: LeadStatus;
}

export interface EmailRunStore {
  persist(record: EmailPersist): Promise<void>;
}
export interface EmailTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  emails: EmailRunStore;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface EmailUnitOfWork {
  transaction<T>(fn: (repos: EmailTxRepos) => Promise<T>): Promise<T>;
}

export interface EmailServiceDeps {
  provider: LlmProvider;
  uow: EmailUnitOfWork;
  logger: Logger;
  config: EmailConfig;
  debug?: EmailDebugStore;
}

export interface EmailWriteInput {
  leadId: string;
  facts: LeadFact[];
  findings: EmailFinding[];
  demo: EmailDemoMeta | null;
  opportunityScore: number | null;
}

export interface EmailResult {
  leadId: string;
  outcome: EmailOutcome;
  status: EmailStatus | null;
  costUsd: number;
  callsMade: number;
}

/**
 * Phase 9 email writer orchestration: writer → deterministic validation → independent
 * adversarial reviewer → gate → render → persist. One factual email per lead, human-review
 * gated. A demo_link CTA is only permitted for a human-approved demo, and its {{DEMO_URL}}
 * stays a token (Phase 11 substitutes the real URL) — such emails park at WAITING_FOR_DEMO_URL
 * and are NOT send-ready. Cost bounded by a pre-call worst-case projection. Never sends.
 */
export class EmailWriterService {
  constructor(private readonly deps: EmailServiceDeps) {}

  async write(input: EmailWriteInput, runId: string): Promise<EmailResult> {
    const c = this.deps.config;
    const modelCalls: EmailModelCall[] = [];
    let cost = 0;
    let callsMade = 0;
    let costUnaccountable = false;
    const isReal = this.deps.provider.name !== 'mock';

    const safeFindings = input.findings.filter((f) => f.safeForOutreach);
    const emailInputs: EmailInputs = { facts: input.facts, findings: safeFindings, demo: input.demo };
    const ctx = buildEmailContext(emailInputs);
    const brief = this.brief(input, safeFindings);

    const canCall = (model: string): boolean => {
      if (costUnaccountable) return false;
      if (callsMade >= c.maxCallsPerLead) return false;
      if (c.maxCostUsdPerLead === null) return true;
      if (!isReal) return cost < c.maxCostUsdPerLead;
      const projected = worstCaseCostUsd(model, c.worstCaseInputTokensPerCall, c.maxOutputTokens);
      if (projected === null) return false;
      return cost + projected <= c.maxCostUsdPerLead;
    };

    const record = (purpose: EmailModelCall['purpose'], promptVersion: string, res: LlmResult): EmailModelCall => {
      const rec: EmailModelCall = {
        id: randomUUID(), purpose, provider: res.provider, requestedModel: res.requestedModel, resolvedModel: res.resolvedModel,
        promptVersion, schemaVersion: EMAIL_SCHEMA_VERSION, requestId: res.requestId, responseId: res.responseId,
        inputTokens: res.usage.inputTokens, cachedInputTokens: res.usage.cachedInputTokens, cacheWriteTokens: res.usage.cacheWriteTokens,
        outputTokens: res.usage.outputTokens, reasoningTokens: res.usage.reasoningTokens, estimatedCostUsd: res.usage.estimatedCostUsd,
        latencyMs: res.latencyMs, status: res.status, retryNumber: 0, validationViolations: null,
      };
      modelCalls.push(rec);
      callsMade += 1;
      cost += res.usage.estimatedCostUsd ?? 0;
      if (res.usage.estimatedCostUsd === null && res.provider !== 'mock') costUnaccountable = true;
      return rec;
    };

    const recordDebug = async (outcome: EmailOutcome, draft: unknown | null, review: unknown | null, violations: string[]): Promise<void> => {
      const now = new Date();
      await this.deps.debug?.record({
        leadId: input.leadId, runId, outcome, draft, review, violations, costUsd: cost, callsMade,
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + EMAIL_DEBUG_TTL_MS).toISOString(),
      });
    };

    const finish = async (outcome: EmailOutcome, persist: EmailPersist): Promise<EmailResult> => {
      persist.modelCalls = modelCalls;
      if (persist.email) persist.email.runId = runId;
      await this.deps.uow.transaction(async (repos) => {
        const lead = await repos.leads.getById(input.leadId);
        // A demo is optional: OPPORTUNITY_READY (no demo) advances the same way as the demo-bearing
        // states. All three reach EMAIL_DRAFTED via a legal edge in the state machine.
        if (lead && (lead.status === 'DEMO_READY' || lead.status === 'DEMO_DECIDED' || lead.status === 'OPPORTUNITY_READY')) {
          await repos.leadService.transition(input.leadId, 'EMAIL_DRAFTED');
          if (persist.routeTo === 'EMAIL_REVIEW_FAILED') {
            await repos.leadService.transition(input.leadId, 'EMAIL_REVIEW_FAILED');
          } else {
            await repos.leadService.transition(input.leadId, 'EMAIL_APPROVED');
            if (persist.routeTo !== 'EMAIL_APPROVED') await repos.leadService.transition(input.leadId, persist.routeTo);
          }
        }
        await repos.emails.persist(persist);
        await repos.events.record({
          leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null,
          message: `email: ${outcome}`, data: { outcome, costUsd: cost },
        });
      });
      return { leadId: input.leadId, outcome, status: persist.email?.status ?? null, costUsd: cost, callsMade };
    };

    const failPersist = (route: LeadStatus): EmailPersist => ({ leadId: input.leadId, email: null, factInputs: [], findingInputs: [], modelCalls, routeTo: route });

    // ---- Writer ----
    if (!canCall(c.writerModel)) return finish('BUDGET_BLOCKED', failPersist('EMAIL_REVIEW_FAILED'));
    const wMsgs = buildEmailWriterMessages(brief, null);
    const wRes = await this.deps.provider.generate({
      task: 'email_write', system: wMsgs.system, user: wMsgs.user, images: [], outputSchema: EMAIL_WRITER_JSON_SCHEMA,
      schemaName: 'email_write', model: c.writerModel, reasoningEffort: c.writerEffort, store: c.store, timeoutMs: c.timeoutMs,
      maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    const wRec = record('email_write', EMAIL_WRITER_PROMPT_VERSION, wRes);
    if (wRes.status === 'refusal') return finish('MODEL_REFUSAL', failPersist('EMAIL_REVIEW_FAILED'));
    if (wRes.status === 'rate_limited') return finish('RATE_LIMITED', failPersist('EMAIL_REVIEW_FAILED'));
    if (wRes.status === 'transient' || wRes.status === 'incomplete' || wRes.status === 'input_too_large') return finish('TRANSIENT_PROVIDER_ERROR', failPersist('EMAIL_REVIEW_FAILED'));
    const parsed = emailWriterSchema.safeParse(wRes.rawJson);
    if (!parsed.success) {
      wRec.validationViolations = parsed.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`);
      await recordDebug('SCHEMA_INVALID', wRes.rawJson, null, wRec.validationViolations);
      return finish('SCHEMA_INVALID', failPersist('EMAIL_REVIEW_FAILED'));
    }
    const draft = parsed.data;

    // ---- Deterministic validation (before spending on the reviewer) ----
    const check = validateEmail(draft, ctx);
    if (!check.ok) {
      wRec.validationViolations = check.violations;
      const p = this.buildPersist(input, draft, null, 'REVIEW_FAILED', 'EMAIL_REVIEW_FAILED', emailInputs, wRes, null, cost, modelCalls);
      await recordDebug('VALIDATION_FAILED', draft, null, check.violations);
      return finish('VALIDATION_FAILED', p);
    }

    // ---- Independent adversarial reviewer ----
    if (!canCall(c.reviewerModel)) return finish('BUDGET_BLOCKED', failPersist('EMAIL_REVIEW_FAILED'));
    const rMsgs = buildEmailReviewerMessages(brief, draft);
    const rRes = await this.deps.provider.generate({
      task: 'email_review', system: rMsgs.system, user: rMsgs.user, images: [], outputSchema: EMAIL_REVIEW_JSON_SCHEMA,
      schemaName: 'email_review', model: c.reviewerModel, reasoningEffort: c.reviewerEffort, store: c.store, timeoutMs: c.timeoutMs,
      maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    record('email_review', EMAIL_REVIEWER_PROMPT_VERSION, rRes);
    if (rRes.status === 'refusal') return finish('MODEL_REFUSAL', failPersist('EMAIL_REVIEW_FAILED'));
    if (rRes.status === 'rate_limited') return finish('RATE_LIMITED', failPersist('EMAIL_REVIEW_FAILED'));
    if (rRes.status === 'transient' || rRes.status === 'incomplete' || rRes.status === 'input_too_large') return finish('TRANSIENT_PROVIDER_ERROR', failPersist('EMAIL_REVIEW_FAILED'));
    const rParsed = emailReviewSchema.safeParse(rRes.rawJson);
    if (!rParsed.success) {
      await recordDebug('SCHEMA_INVALID', draft, null, ['reviewer_schema_invalid']);
      return finish('SCHEMA_INVALID', failPersist('EMAIL_REVIEW_FAILED'));
    }
    const review = rParsed.data;

    // Revisions are never silently approved without being applied. Every persuasion, evidence,
    // punctuation, CTA, competitor, and demo-alignment dimension must pass.
    const approvable = review.decision === 'APPROVE'
      && !review.fabricationRisk
      && review.subjectSpecific
      && review.subjectCuriosityGap
      && review.openingSpecific
      && review.businessRelevanceClear
      && review.urgencySupported
      && review.competitorClaimsSupported
      && review.humanStylePass
      && review.punctuationPass
      && review.singlePrimaryCta
      && review.sufficientlyPersonalized
      && review.evidenceSupported
      && review.demoAligned
      && review.persuasive
      && review.singleObservation
      && review.buyerLanguageOnly
      && review.conversationNotAudit
      && review.confidentObservation;
    if (!approvable) {
      const p = this.buildPersist(input, draft, review, 'REVIEW_FAILED', 'EMAIL_REVIEW_FAILED', emailInputs, wRes, rRes, cost, modelCalls);
      await recordDebug('REVIEW_REJECTED', draft, review, []);
      return finish('REVIEW_REJECTED', p);
    }

    // ---- Approved: render + route ----
    const rendered = renderEmail(draft, emailInputs);
    const route: LeadStatus = rendered.hasDemoUrlPlaceholder ? 'WAITING_FOR_DEMO_URL' : 'READY_FOR_HUMAN_APPROVAL';
    const outcome: EmailOutcome = rendered.hasDemoUrlPlaceholder ? 'APPROVED_WAITING_URL' : 'APPROVED_READY';
    const p = this.buildPersist(input, draft, review, 'APPROVED', route, emailInputs, wRes, rRes, cost, modelCalls, rendered);
    await recordDebug(outcome, draft, review, []);
    return finish(outcome, p);
  }

  private buildPersist(
    input: EmailWriteInput,
    draft: import('./email-schema.js').EmailWriterParsed,
    review: import('./email-schema.js').EmailReviewParsed | null,
    status: EmailStatus,
    route: LeadStatus,
    emailInputs: EmailInputs,
    wRes: LlmResult,
    rRes: LlmResult | null,
    cost: number,
    modelCalls: EmailModelCall[],
    rendered = renderEmail(draft, emailInputs),
  ): EmailPersist {
    const c = this.deps.config;
    const emailId = randomUUID();
    return {
      leadId: input.leadId,
      email: {
        id: emailId, leadId: input.leadId, demoId: input.demo?.id ?? null, runId: '', subject: rendered.subject, body: rendered.body,
        ctaKind: rendered.ctaKind, hasDemoUrlPlaceholder: rendered.hasDemoUrlPlaceholder, status,
        writerPromptVersion: EMAIL_WRITER_PROMPT_VERSION, reviewerPromptVersion: EMAIL_REVIEWER_PROMPT_VERSION,
        schemaVersion: EMAIL_SCHEMA_VERSION, rulesVersion: EMAIL_WRITER_RULES_VERSION, provider: this.deps.provider.name,
        requestedWriterModel: c.writerModel, requestedReviewerModel: c.reviewerModel, writerResponseId: wRes.responseId,
        reviewerResponseId: rRes?.responseId ?? null, reviewerDecision: review?.decision ?? null,
        fabricationRisk: review?.fabricationRisk ?? null,
        personalizationSupported: review ? review.evidenceSupported && review.sufficientlyPersonalized : null,
        claimHonest: review
          ? review.urgencySupported && review.competitorClaimsSupported && !review.fabricationRisk
          : null,
        reviewerProblems: review
          ? [...review.problems, ...review.requiredRevisions]
          : null,
        totalCostUsd: cost,
      },
      factInputs: rendered.factInputs.map((fi) => ({ id: randomUUID(), emailId, leadFactId: fi.factId, field: fi.field })),
      findingInputs: rendered.findingInputs.map((f) => ({ id: randomUUID(), emailId, auditFindingId: f.findingId, directive: f.directive })),
      modelCalls,
      routeTo: route,
    };
  }

  private brief(input: EmailWriteInput, safeFindings: EmailFinding[]): EmailBrief {
    return buildEmailBrief({ facts: input.facts, findings: safeFindings, demo: input.demo });
  }
}
