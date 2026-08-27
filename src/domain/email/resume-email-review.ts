import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { buildEmailReviewerMessages, EMAIL_REVIEWER_PROMPT_VERSION } from '../../prompts/email/index.js';
import { type LlmProvider, type LlmResult, type ReasoningEffort } from '../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { type EmailDebugReader } from '../../integrations/email/email-debug-store.js';
import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type LeadStatus } from '../leads/status.js';
import { buildEmailBrief } from './email-brief.js';
import { buildEmailContext, type EmailDemoMeta, type EmailFinding, type EmailInputs, renderEmail } from './email-render.js';
import {
  EMAIL_SCHEMA_VERSION,
  EMAIL_REVIEW_JSON_SCHEMA,
  type EmailReviewParsed,
  emailReviewSchema,
  emailWriterSchema,
} from './email-schema.js';
import { type EmailStatus } from './email-types.js';
import { type EmailModelCall, type EmailPersist } from './email-writer-service.js';
import { validateEmail } from './email-validation.js';

/** The persisted email_drafts fields the resume path needs (read-only projection). */
export interface PersistedDraftRow {
  id: string;
  leadId: string;
  runId: string | null;
  status: string;
  subject: string;
  body: string;
  demoId: string | null;
  writerPromptVersion: string;
  schemaVersion: string;
  rulesVersion: string;
  provider: string;
  requestedWriterModel: string;
  writerResponseId: string | null;
}

export interface ResumeInputs {
  facts: LeadFact[];
  findings: EmailFinding[];
  demo: EmailDemoMeta | null;
}

/** Fail-closed preconditions. Any abort makes ZERO provider calls and persists nothing. */
export type ResumeAbortCode =
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_LEAD_MISMATCH'
  | 'DRAFT_NOT_REVIEW_FAILED'
  | 'LEAD_NOT_FOUND'
  | 'LEAD_NOT_REVIEW_FAILED'
  | 'DEBUG_RECORD_MISSING'
  | 'DEBUG_DRAFT_INVALID'
  | 'RENDER_MISMATCH';

export class ResumeReviewAbort extends Error {
  constructor(public readonly code: ResumeAbortCode, message: string) {
    super(message);
    this.name = 'ResumeReviewAbort';
  }
}

export type ResumeOutcome =
  | 'REVIEWED_APPROVED'
  | 'REVIEWED_REJECTED'
  | 'VALIDATION_FAILED'
  | 'REVIEWER_BUDGET_BLOCKED'
  | 'MODEL_REFUSAL'
  | 'RATE_LIMITED'
  | 'TRANSIENT_PROVIDER_ERROR'
  | 'SCHEMA_INVALID';

export interface ResumeReviewResult {
  leadId: string;
  sourceDraftId: string;
  outcome: ResumeOutcome;
  costUsd: number;
  callsMade: number;
  violations: string[];
  review: EmailReviewParsed | null;
  newDraftId: string | null;
  newLeadStatus: LeadStatus | null;
}

export interface ResumeReviewConfig {
  reviewerModel: string;
  reviewerEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxCostUsdPerLead: number | null;
  worstCaseInputTokensPerCall: number;
}

/** Read ports (kept DB-agnostic so the orchestration is unit-testable without a database). */
export interface ResumeReviewPorts {
  loadDraft(draftId: string): Promise<PersistedDraftRow | null>;
  loadLeadStatus(leadId: string): Promise<string | null>;
  loadInputs(leadId: string): Promise<ResumeInputs>;
}

/** Atomic commit of the appended review outcome: supported lead-state transitions + a NEW
 * immutable email_drafts row (the original REVIEW_FAILED row is never mutated) + provenance
 * + the single model_call + an audit NOTE. Provided by the CLI (real UoW) or a test spy. */
export interface ResumeCommitPlan {
  leadId: string;
  approved: boolean;
  route: LeadStatus;
  persist: EmailPersist;
  sourceDraftId: string;
  reviewerDecision: string;
  costUsd: number;
  runId: string;
}
export type ResumeCommit = (plan: ResumeCommitPlan) => Promise<void>;

export interface ResumeReviewDeps {
  provider: LlmProvider;
  debug: EmailDebugReader;
  ports: ResumeReviewPorts;
  commit: ResumeCommit;
  logger: Logger;
  config: ResumeReviewConfig;
}

/**
 * Resume ONE persisted REVIEW_FAILED email draft through deterministic validation and the
 * adversarial reviewer WITHOUT calling the writer. The exact original writer output is reloaded
 * from the diagnostic debug record (the DB persists only the rendered subject/body), integrity-
 * checked against the persisted row, re-validated with the current validator, and — only if it
 * passes — sent to the reviewer exactly once. Approval appends a NEW immutable draft row and
 * advances the lead through supported transitions; the original failed row is preserved.
 */
export class ResumeEmailReviewService {
  constructor(private readonly deps: ResumeReviewDeps) {}

  async resume(params: { leadId: string; draftId: string }, runId: string): Promise<ResumeReviewResult> {
    const { leadId, draftId } = params;
    const c = this.deps.config;

    const draftRow = await this.deps.ports.loadDraft(draftId);
    if (!draftRow) throw new ResumeReviewAbort('DRAFT_NOT_FOUND', `Email draft ${draftId} not found.`);
    if (draftRow.leadId !== leadId) {
      throw new ResumeReviewAbort('DRAFT_LEAD_MISMATCH', `Draft ${draftId} belongs to lead ${draftRow.leadId}, not ${leadId}.`);
    }
    if (draftRow.status !== 'REVIEW_FAILED') {
      throw new ResumeReviewAbort('DRAFT_NOT_REVIEW_FAILED', `Draft ${draftId} is ${draftRow.status}; only a REVIEW_FAILED draft can be resumed.`);
    }

    const leadStatus = await this.deps.ports.loadLeadStatus(leadId);
    if (leadStatus === null) throw new ResumeReviewAbort('LEAD_NOT_FOUND', `Lead ${leadId} not found.`);
    if (leadStatus !== 'EMAIL_REVIEW_FAILED') {
      throw new ResumeReviewAbort('LEAD_NOT_REVIEW_FAILED', `Lead ${leadId} is ${leadStatus}; only an EMAIL_REVIEW_FAILED lead can be resumed.`);
    }

    const rec = await this.deps.debug.findByLeadAndRun(leadId, draftRow.runId);
    if (!rec || rec.draft === null) {
      throw new ResumeReviewAbort('DEBUG_RECORD_MISSING', `No debug record with the original writer output for lead ${leadId} run ${draftRow.runId ?? '(none)'}.`);
    }
    const parsed = emailWriterSchema.safeParse(rec.draft);
    if (!parsed.success) {
      throw new ResumeReviewAbort('DEBUG_DRAFT_INVALID', `Debug draft for ${draftId} does not satisfy the writer schema.`);
    }
    const draft = parsed.data;

    const inputs = await this.deps.ports.loadInputs(leadId);
    const emailInputs: EmailInputs = { facts: inputs.facts, findings: inputs.findings, demo: inputs.demo };
    const ctx = buildEmailContext(emailInputs);

    // Integrity gate: the reloaded draft must render byte-identically to the persisted row.
    const rendered = renderEmail(draft, emailInputs);
    if (rendered.subject !== draftRow.subject || rendered.body !== draftRow.body) {
      throw new ResumeReviewAbort('RENDER_MISMATCH', `Reloaded draft does not render to the persisted subject/body for ${draftId}; refusing to resume a divergent draft.`);
    }

    // Deterministic validation with the CURRENT validator. No reviewer call if it still fails.
    const check = validateEmail(draft, ctx);
    if (!check.ok) {
      return this.result(leadId, draftId, 'VALIDATION_FAILED', 0, 0, check.violations, null, null, null);
    }

    // Budget guard for the single real reviewer call (mock is free).
    const isReal = this.deps.provider.name !== 'mock';
    if (isReal && c.maxCostUsdPerLead !== null) {
      const projected = worstCaseCostUsd(c.reviewerModel, c.worstCaseInputTokensPerCall, c.maxOutputTokens);
      if (projected === null || projected > c.maxCostUsdPerLead) {
        return this.result(leadId, draftId, 'REVIEWER_BUDGET_BLOCKED', 0, 0, [], null, null, null);
      }
    }

    // Exactly one reviewer call — same reviewer contract as the writer service.
    const brief = buildEmailBrief(emailInputs);
    const rMsgs = buildEmailReviewerMessages(brief, draft);
    const rRes = await this.deps.provider.generate({
      task: 'email_review', system: rMsgs.system, user: rMsgs.user, images: [], outputSchema: EMAIL_REVIEW_JSON_SCHEMA,
      schemaName: 'email_review', model: c.reviewerModel, reasoningEffort: c.reviewerEffort, store: c.store,
      timeoutMs: c.timeoutMs, maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    const cost = rRes.usage.estimatedCostUsd ?? 0;

    if (rRes.status === 'refusal') return this.result(leadId, draftId, 'MODEL_REFUSAL', cost, 1, [], null, null, null);
    if (rRes.status === 'rate_limited') return this.result(leadId, draftId, 'RATE_LIMITED', cost, 1, [], null, null, null);
    if (rRes.status === 'transient' || rRes.status === 'incomplete' || rRes.status === 'input_too_large') {
      return this.result(leadId, draftId, 'TRANSIENT_PROVIDER_ERROR', cost, 1, [], null, null, null);
    }
    const rParsed = emailReviewSchema.safeParse(rRes.rawJson);
    if (!rParsed.success) return this.result(leadId, draftId, 'SCHEMA_INVALID', cost, 1, [], null, null, null);
    const review = rParsed.data;

    // The EXISTING approvable gate — identical conjunction to the writer service.
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
      && review.persuasive;

    const route: LeadStatus = rendered.hasDemoUrlPlaceholder ? 'WAITING_FOR_DEMO_URL' : 'READY_FOR_HUMAN_APPROVAL';
    const newDraftId = randomUUID();
    const modelCall = this.modelCall(rRes);
    const persist = this.buildPersist({ newDraftId, runId, draftRow, rendered, review, approvable, cost, modelCall, rRes });

    await this.deps.commit({
      leadId, approved: approvable, route, persist, sourceDraftId: draftId,
      reviewerDecision: review.decision, costUsd: cost, runId,
    });

    const newLeadStatus: LeadStatus = approvable ? route : 'EMAIL_REVIEW_FAILED';
    return this.result(leadId, draftId, approvable ? 'REVIEWED_APPROVED' : 'REVIEWED_REJECTED', cost, 1, [], review, newDraftId, newLeadStatus);
  }

  private modelCall(res: LlmResult): EmailModelCall {
    return {
      id: randomUUID(), purpose: 'email_review', provider: res.provider, requestedModel: res.requestedModel,
      resolvedModel: res.resolvedModel, promptVersion: EMAIL_REVIEWER_PROMPT_VERSION, schemaVersion: EMAIL_SCHEMA_VERSION,
      requestId: res.requestId, responseId: res.responseId, inputTokens: res.usage.inputTokens,
      cachedInputTokens: res.usage.cachedInputTokens, cacheWriteTokens: res.usage.cacheWriteTokens,
      outputTokens: res.usage.outputTokens, reasoningTokens: res.usage.reasoningTokens,
      estimatedCostUsd: res.usage.estimatedCostUsd, latencyMs: res.latencyMs, status: res.status,
      retryNumber: 0, validationViolations: null,
    };
  }

  private buildPersist(args: {
    newDraftId: string;
    runId: string;
    draftRow: PersistedDraftRow;
    rendered: ReturnType<typeof renderEmail>;
    review: EmailReviewParsed;
    approvable: boolean;
    cost: number;
    modelCall: EmailModelCall;
    rRes: LlmResult;
  }): EmailPersist {
    const { newDraftId, runId, draftRow, rendered, review, approvable, cost, modelCall, rRes } = args;
    const c = this.deps.config;
    const status: EmailStatus = approvable ? 'APPROVED' : 'REVIEW_FAILED';
    const route: LeadStatus = approvable
      ? (rendered.hasDemoUrlPlaceholder ? 'WAITING_FOR_DEMO_URL' : 'READY_FOR_HUMAN_APPROVAL')
      : 'EMAIL_REVIEW_FAILED';
    return {
      leadId: draftRow.leadId,
      email: {
        id: newDraftId, leadId: draftRow.leadId, demoId: draftRow.demoId, runId, subject: rendered.subject, body: rendered.body,
        ctaKind: rendered.ctaKind, hasDemoUrlPlaceholder: rendered.hasDemoUrlPlaceholder, status,
        // Provenance: the writer was NOT re-run, so the original writer columns are carried verbatim.
        writerPromptVersion: draftRow.writerPromptVersion, reviewerPromptVersion: EMAIL_REVIEWER_PROMPT_VERSION,
        schemaVersion: draftRow.schemaVersion, rulesVersion: draftRow.rulesVersion, provider: this.deps.provider.name,
        requestedWriterModel: draftRow.requestedWriterModel, requestedReviewerModel: c.reviewerModel,
        writerResponseId: draftRow.writerResponseId, reviewerResponseId: rRes.responseId, reviewerDecision: review.decision,
        fabricationRisk: review.fabricationRisk,
        personalizationSupported: review.evidenceSupported && review.sufficientlyPersonalized,
        claimHonest: review.urgencySupported && review.competitorClaimsSupported && !review.fabricationRisk,
        reviewerProblems: [...review.problems, ...review.requiredRevisions],
        totalCostUsd: cost,
      },
      factInputs: rendered.factInputs.map((fi) => ({ id: randomUUID(), emailId: newDraftId, leadFactId: fi.factId, field: fi.field })),
      findingInputs: rendered.findingInputs.map((f) => ({ id: randomUUID(), emailId: newDraftId, auditFindingId: f.findingId, directive: f.directive })),
      modelCalls: [modelCall],
      routeTo: route,
    };
  }

  private result(
    leadId: string, sourceDraftId: string, outcome: ResumeOutcome, costUsd: number, callsMade: number,
    violations: string[], review: EmailReviewParsed | null, newDraftId: string | null, newLeadStatus: LeadStatus | null,
  ): ResumeReviewResult {
    return { leadId, sourceDraftId, outcome, costUsd, callsMade, violations, review, newDraftId, newLeadStatus };
  }
}
