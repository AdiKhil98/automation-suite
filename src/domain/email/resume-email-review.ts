import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  buildEmailReviewerMessages,
  EMAIL_REVIEWER_PROMPT_VERSION,
  type PriorSequenceMessage,
} from '../../prompts/email/index.js';
import { type LlmProvider, type LlmResult, type ReasoningEffort } from '../../integrations/llm/provider.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import {
  EMAIL_DEBUG_TTL_MS,
  type EmailDebugReader,
  type EmailDebugStore,
} from '../../integrations/email/email-debug-store.js';
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
import {
  type EmailModelCall,
  type EmailPersist,
  type EmailReviewOutcomeUpdate,
} from './email-writer-service.js';
import { type EmailSequencePosition } from './email-types.js';
import { validateEmail } from './email-validation.js';
import { isEmailReviewApprovable } from './email-review-gate.js';
import { type SequenceStep } from '../outreach/sequence.js';

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
  /** Sequence provenance carried verbatim from the source draft (0 = INITIAL / Outreach #1). */
  sequenceStep: SequenceStep;
  outreachRecordId: string | null;
  /** The thread subject the source draft continued, when it was a threaded follow-up. */
  threadSubject: string | null;
  /** Spend already recorded on this draft (the writer attempt). Resume adds the reviewer call. */
  totalCostUsd: number;
}

/**
 * The authoritative thread a follow-up continues, read from `outreach_messages` — the SAME source
 * the preparation path uses. Never reconstructed from the failed draft: the draft is the email the
 * reviewer must judge, not evidence of what was already sent.
 */
export interface ResumeThreadContext {
  threadSubject: string | null;
  priorMessages: readonly PriorSequenceMessage[];
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
  | 'RENDER_MISMATCH'
  /** A follow-up draft carries no outreach record, so its thread cannot be resolved. */
  | 'FOLLOWUP_OUTREACH_RECORD_MISSING'
  /** The outreach record resolved to no thread: no original subject, or nothing sent yet. */
  | 'FOLLOWUP_THREAD_CONTEXT_MISSING';

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
  /** Set only when a NEW row was appended (unbound drafts). Null for in-place recovery. */
  newDraftId: string | null;
  /** The draft that now carries the reviewer outcome — the new row, or the recovered source row. */
  resultDraftId: string | null;
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
  /**
   * The authoritative thread context for a follow-up's outreach record. Called ONLY for steps 1-3,
   * and before the reviewer: a follow-up whose thread cannot be resolved aborts rather than being
   * judged against an empty history.
   */
  loadThreadContext(outreachRecordId: string): Promise<ResumeThreadContext | null>;
}

/**
 * How the reviewer outcome reaches the database. Which one applies is decided by the SLOT the draft
 * occupies, not by preference:
 *
 *  - `APPEND` — the draft is not bound to an outreach record (a first email / pre-sequence draft).
 *    Nothing constrains it, so the historic behaviour stands: a NEW row is appended and the original
 *    REVIEW_FAILED row is preserved untouched.
 *
 *  - `RECOVER_IN_PLACE` — the draft IS bound to (outreach record, sequence step). Migration 0044
 *    declares at most ONE live draft per slot, so that row is the canonical draft for it and a
 *    second row would be a duplicate competing for the same send slot (and would violate
 *    `email_drafts_outreach_sequence_uk`). The reviewer outcome is therefore written ONTO that row.
 *    The writer was not re-run, so every writer column, the subject, the body, the evidence
 *    bindings, and the row id are unchanged; `human_decision` is untouched, because no human has
 *    decided anything and forging a REJECTED decision to slip past the index would corrupt the
 *    review trail.
 */
export type ResumeDraftWrite =
  | { kind: 'APPEND'; persist: EmailPersist; newDraftId: string }
  | { kind: 'RECOVER_IN_PLACE'; draftId: string; update: EmailReviewOutcomeUpdate; modelCalls: EmailModelCall[] }
  /**
   * A PAID reviewer call that produced no usable verdict (refusal, provider error, or output the
   * local schema rejects). The attempt must not vanish from the books, but it must also change
   * nothing about the draft's state: the row keeps its REVIEW_FAILED status, its writer copy and
   * provenance, its evidence bindings, and its NULL `human_decision`, so the SAME draft stays
   * resumable for another reviewer-only attempt once the cause is fixed. Only the model_call, the
   * added spend, and a bounded diagnostic are written.
   */
  | {
      kind: 'ACCOUNT_FAILED_ATTEMPT';
      draftId: string;
      addCostUsd: number;
      modelCalls: EmailModelCall[];
      diagnostic: ResumeFailureDiagnostic;
    };

/**
 * What a failed reviewer attempt leaves behind for a human to diagnose. Bounded by construction and
 * carrying model output only — never credentials, prompts, or environment. The Zod issues are the
 * exact reason the response was rejected, which is what makes a schema mismatch fixable instead of
 * merely repeatable.
 */
export interface ResumeFailureDiagnostic {
  outcome: ResumeOutcome;
  providerStatus: string;
  requestId: string | null;
  responseId: string | null;
  /** Sanitized Zod issues (schema-invalid only): where, which rule, and what it said. */
  issues: Array<{ path: string; code: string; message: string }>;
  /** A bounded excerpt of the raw reviewer JSON, for reproducing the exact failure. */
  rawExcerpt: string | null;
  rawTruncated: boolean;
}

/** Bounds for the diagnostic, so one bad response can never bloat an event row or a debug file. */
const MAX_DIAGNOSTIC_ISSUES = 20;
const MAX_ISSUE_PATH_CHARS = 120;
const MAX_ISSUE_MESSAGE_CHARS = 200;
const MAX_RAW_EXCERPT_CHARS = 2_000;

/** Atomic commit of the review outcome: supported lead-state transitions + the draft write above
 * + the single model_call + an immutable audit NOTE. Provided by the CLI (real UoW) or a test spy. */
export interface ResumeCommitPlan {
  leadId: string;
  approved: boolean;
  route: LeadStatus;
  /** How the outcome is written: a new row, or recovery of the canonical sequence draft. */
  write: ResumeDraftWrite;
  sourceDraftId: string;
  reviewerDecision: string;
  costUsd: number;
  runId: string;
}
export type ResumeCommit = (plan: ResumeCommitPlan) => Promise<void>;

export interface ResumeReviewDeps {
  provider: LlmProvider;
  debug: EmailDebugReader;
  /**
   * Diagnostic sink for a failed reviewer attempt — the same store the writer records to. Optional
   * so a caller with no diagnostics configured still gets the DURABLE accounting (model_call, cost,
   * pipeline event); this only adds the fuller raw payload.
   */
  debugWriter?: EmailDebugStore;
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
/** JSON for a diagnostic excerpt; never throws on an exotic payload. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular or otherwise unserialisable payload still deserves a recorded shape.
    return `[unserializable ${typeof value}]`;
  }
}

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

    // ---- Authoritative thread context for a follow-up (steps 1-3) ----
    // The reviewer's rubric for a follow-up is about CONTINUITY: add clarity without restarting
    // (step 1), compress without re-explaining (step 2), close without reopening (step 3). None of
    // that can be judged against "(none)" prior messages, so the real thread is loaded from
    // `outreach_messages` — the same source the preparation path uses — and a follow-up whose
    // thread cannot be resolved aborts BEFORE the paid reviewer call rather than being judged blind.
    const isFollowup = draftRow.sequenceStep > 0;
    let thread: ResumeThreadContext = { threadSubject: null, priorMessages: [] };
    if (isFollowup) {
      if (draftRow.outreachRecordId === null) {
        throw new ResumeReviewAbort(
          'FOLLOWUP_OUTREACH_RECORD_MISSING',
          `Draft ${draftId} is sequence step ${String(draftRow.sequenceStep)} but carries no outreach record; its thread cannot be resolved.`,
        );
      }
      const loaded = await this.deps.ports.loadThreadContext(draftRow.outreachRecordId);
      if (!loaded || loaded.threadSubject === null || loaded.threadSubject.trim() === '' || loaded.priorMessages.length === 0) {
        throw new ResumeReviewAbort(
          'FOLLOWUP_THREAD_CONTEXT_MISSING',
          `No thread context for outreach record ${draftRow.outreachRecordId}; refusing to review a follow-up against an empty thread.`,
        );
      }
      thread = loaded;
    }

    const inputs = await this.deps.ports.loadInputs(leadId);
    // Sequence provenance carried from the persisted row. Without it a threaded follow-up would be
    // re-rendered with a NEW model-authored subject (failing the integrity gate below) and
    // re-validated under the first-email subject rules — the same initial-vs-follow-up assumption
    // that rejected correctly-threaded follow-ups in the writer.
    //
    // The thread subject comes from the AUTHORITATIVE thread for a follow-up (the original sent
    // subject), and from the stored row only for an unbound draft. `replySubject` is idempotent, so
    // the raw subject and the stored `Re: `-prefixed one render and compare identically — and the
    // integrity gate below still proves the re-render matches the persisted row byte for byte.
    const position: EmailSequencePosition = {
      step: draftRow.sequenceStep,
      threadSubject: isFollowup ? thread.threadSubject : draftRow.threadSubject,
      // Re-validating with the CURRENT validator means the anti-repetition gate runs here too, so a
      // resumed follow-up is judged against the same thread the preparation path would have used.
      priorMessageBodies: thread.priorMessages.map((m) => m.body),
    };
    const emailInputs: EmailInputs = {
      facts: inputs.facts, findings: inputs.findings, demo: inputs.demo,
      threadSubject: position.threadSubject,
    };
    const ctx = buildEmailContext(emailInputs, position);

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

    // Budget guard for the single real reviewer call (mock is free, as everywhere else).
    //
    // CUMULATIVE, not per-call. The draft already carries what has been spent on it — the writer
    // attempt, plus every failed reviewer attempt this path now deliberately accounts for. Admitting
    // a retry on "this ONE call fits under the cap" would let an unbounded number of retries walk
    // past a per-lead budget while each individual call looked affordable. Fail closed when the
    // projection is unknown, and make the decision BEFORE the provider is touched.
    const isReal = this.deps.provider.name !== 'mock';
    if (isReal && c.maxCostUsdPerLead !== null) {
      const projected = worstCaseCostUsd(c.reviewerModel, c.worstCaseInputTokensPerCall, c.maxOutputTokens);
      if (projected === null || draftRow.totalCostUsd + projected > c.maxCostUsdPerLead) {
        this.deps.logger.warn(
          {
            leadId, draftId, alreadySpentUsd: draftRow.totalCostUsd, projectedUsd: projected,
            capUsd: c.maxCostUsdPerLead,
          },
          'resume-email-review: reviewer refused — cumulative spend on this draft would exceed the per-lead cap',
        );
        return this.result(leadId, draftId, 'REVIEWER_BUDGET_BLOCKED', 0, 0, [], null, null, null);
      }
    }

    // Exactly one reviewer call — same reviewer contract as the writer service.
    const brief = buildEmailBrief(emailInputs);
    const rMsgs = buildEmailReviewerMessages(brief, draft, {
      step: draftRow.sequenceStep,
      threadSubject: position.threadSubject,
      // The exact messages already sent in this thread. Without them the sequence-job rubric is
      // unjudgeable; with them the resumed review sees what the preparation path's review saw.
      priorMessages: thread.priorMessages,
    });
    const rRes = await this.deps.provider.generate({
      task: 'email_review', system: rMsgs.system, user: rMsgs.user, images: [], outputSchema: EMAIL_REVIEW_JSON_SCHEMA,
      schemaName: 'email_review', model: c.reviewerModel, reasoningEffort: c.reviewerEffort, store: c.store,
      timeoutMs: c.timeoutMs, maxOutputTokens: c.maxOutputTokens, maxRetries: c.maxRetries,
    });
    const cost = rRes.usage.estimatedCostUsd ?? 0;

    // EVERY path from here on has already SPENT money. A reviewer call that yields no usable
    // verdict used to return straight to the caller, so the spend, the model_call, and the reason
    // for the failure existed only in the operator's terminal. They are now committed durably
    // BEFORE returning, without touching the draft's state or the lead's.
    if (rRes.status === 'refusal') {
      return this.accountFailedAttempt('MODEL_REFUSAL', leadId, draftRow, rRes, cost, runId, []);
    }
    if (rRes.status === 'rate_limited') {
      return this.accountFailedAttempt('RATE_LIMITED', leadId, draftRow, rRes, cost, runId, []);
    }
    if (rRes.status === 'transient' || rRes.status === 'incomplete' || rRes.status === 'input_too_large') {
      return this.accountFailedAttempt('TRANSIENT_PROVIDER_ERROR', leadId, draftRow, rRes, cost, runId, []);
    }
    const rParsed = emailReviewSchema.safeParse(rRes.rawJson);
    if (!rParsed.success) {
      // The exact issues are what turn "it failed again" into a fixable schema mismatch.
      return this.accountFailedAttempt('SCHEMA_INVALID', leadId, draftRow, rRes, cost, runId, rParsed.error.issues);
    }
    const review = rParsed.data;

    // The EXISTING approvable gate — shared with the writer service (single source of truth).
    const approvable = isEmailReviewApprovable(review, {
      sequenceStep: draftRow.sequenceStep, subjectIsThreadContinuity: position.threadSubject !== null,
    });

    const route: LeadStatus = rendered.hasDemoUrlPlaceholder ? 'WAITING_FOR_DEMO_URL' : 'READY_FOR_HUMAN_APPROVAL';
    const modelCall = this.modelCall(rRes);
    const status: EmailStatus = approvable ? 'APPROVED' : 'REVIEW_FAILED';

    // WHICH ROW receives the outcome is decided by the slot the draft occupies, never by preference.
    // A sequence-bound draft is the canonical draft for its (outreach record, sequence step) slot —
    // migration 0044 allows exactly one — so appending a second row would both violate that index
    // and create two drafts competing for one send slot. Recovery writes onto the canonical row.
    const write: ResumeDraftWrite = draftRow.outreachRecordId === null
      ? (() => {
          const newDraftId = randomUUID();
          return {
            kind: 'APPEND' as const,
            newDraftId,
            persist: this.buildPersist({ newDraftId, runId, draftRow, rendered, review, approvable, cost, modelCall, rRes }),
          };
        })()
      : {
          kind: 'RECOVER_IN_PLACE' as const,
          draftId: draftRow.id,
          update: {
            status,
            reviewerPromptVersion: EMAIL_REVIEWER_PROMPT_VERSION,
            requestedReviewerModel: c.reviewerModel,
            reviewerResponseId: rRes.responseId,
            reviewerDecision: review.decision,
            fabricationRisk: review.fabricationRisk,
            personalizationSupported: review.evidenceSupported && review.sufficientlyPersonalized,
            claimHonest: review.urgencySupported && review.competitorClaimsSupported && !review.fabricationRisk,
            reviewerProblems: [...review.problems, ...review.requiredRevisions],
            // Honest cumulative accounting: the writer attempt already on the row, plus this call.
            totalCostUsd: draftRow.totalCostUsd + cost,
          },
          modelCalls: [modelCall],
        };

    await this.deps.commit({
      leadId, approved: approvable, route, write, sourceDraftId: draftId,
      reviewerDecision: review.decision, costUsd: cost, runId,
    });

    const newLeadStatus: LeadStatus = approvable ? route : 'EMAIL_REVIEW_FAILED';
    const newDraftId = write.kind === 'APPEND' ? write.newDraftId : null;
    return this.result(
      leadId, draftId, approvable ? 'REVIEWED_APPROVED' : 'REVIEWED_REJECTED', cost, 1, [], review,
      newDraftId, newLeadStatus, write.kind === 'APPEND' ? write.newDraftId : draftRow.id,
    );
  }

  /**
   * Commit a PAID reviewer attempt that produced no usable verdict, then report it.
   *
   * What is written: the fuller raw payload to the local diagnostic sink (first, and independently,
   * so a database outage cannot erase the evidence of a paid call), then the reviewer `model_call`
   * (carrying the sanitized schema violations, exactly as the writer records its own), the added
   * spend on the draft, and an immutable pipeline event with the bounded diagnostic.
   *
   * What is NOT written: any change to the draft's status, reviewer verdict columns,
   * `human_decision`, subject, body, evidence bindings, or writer provenance, and no lead
   * transition. The draft therefore stays exactly as resumable as it was, which is what makes a
   * retry after the fix a reviewer-only retry rather than a re-composition.
   */
  private async accountFailedAttempt(
    outcome: ResumeOutcome,
    leadId: string,
    draftRow: PersistedDraftRow,
    rRes: LlmResult,
    cost: number,
    runId: string,
    issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
  ): Promise<ResumeReviewResult> {
    const violations = issues
      .slice(0, MAX_DIAGNOSTIC_ISSUES)
      .map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`);
    const modelCall = { ...this.modelCall(rRes), validationViolations: violations.length > 0 ? violations : null };
    const diagnostic = this.diagnostic(outcome, rRes, issues);

    // ORDER MATTERS, and the two sinks are independent.
    //
    // The local diagnostic is written FIRST, so that if the database is the thing that is broken,
    // the raw reviewer response and the exact reason it was rejected still survive somewhere. Its
    // failure is caught and logged: a filesystem problem must never undo, obscure, or fail a run
    // whose DB accounting then succeeds — the money was spent either way, and the durable books are
    // the DB. The commit that follows is NOT caught: if accounting itself fails, that is an
    // infrastructure failure the operator must see, and the local diagnostic written above remains.
    let diagnosticPersisted = false;
    if (this.deps.debugWriter) {
      const now = new Date();
      try {
        await this.deps.debugWriter.record({
          leadId, runId, outcome, draft: null, review: diagnostic, violations,
          costUsd: cost, callsMade: 1,
          createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + EMAIL_DEBUG_TTL_MS).toISOString(),
        });
        diagnosticPersisted = true;
      } catch (err) {
        this.deps.logger.error(
          { leadId, draftId: draftRow.id, outcome, err: err instanceof Error ? err.message : String(err) },
          'resume-email-review: local diagnostic could not be written; the paid attempt is still being accounted in the database',
        );
      }
    }

    await this.deps.commit({
      leadId,
      approved: false,
      route: 'EMAIL_REVIEW_FAILED',
      write: { kind: 'ACCOUNT_FAILED_ATTEMPT', draftId: draftRow.id, addCostUsd: cost, modelCalls: [modelCall], diagnostic },
      sourceDraftId: draftRow.id,
      reviewerDecision: outcome,
      costUsd: cost,
      runId,
    });

    // Accounting committed: the outcome is determinate and is reported as such, whether or not the
    // local diagnostic was written.
    this.deps.logger.warn(
      { leadId, draftId: draftRow.id, outcome, costUsd: cost, issues: diagnostic.issues.length, diagnosticPersisted },
      'resume-email-review: paid reviewer call produced no usable verdict; draft left resumable',
    );
    return this.result(leadId, draftRow.id, outcome, cost, 1, violations, null, null, 'EMAIL_REVIEW_FAILED', draftRow.id);
  }

  /** Bounded, model-output-only diagnostic. No credentials, prompts, or environment ever enter it. */
  private diagnostic(
    outcome: ResumeOutcome,
    rRes: LlmResult,
    issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
  ): ResumeFailureDiagnostic {
    let rawExcerpt: string | null = null;
    let rawTruncated = false;
    if (rRes.rawJson !== null && rRes.rawJson !== undefined) {
      const serialized = safeStringify(rRes.rawJson);
      rawTruncated = serialized.length > MAX_RAW_EXCERPT_CHARS;
      rawExcerpt = rawTruncated ? serialized.slice(0, MAX_RAW_EXCERPT_CHARS) : serialized;
    }
    return {
      outcome,
      providerStatus: rRes.status,
      requestId: rRes.requestId,
      responseId: rRes.responseId,
      issues: issues.slice(0, MAX_DIAGNOSTIC_ISSUES).map((i) => ({
        path: (i.path.join('.') || '(root)').slice(0, MAX_ISSUE_PATH_CHARS),
        code: i.code,
        message: i.message.slice(0, MAX_ISSUE_MESSAGE_CHARS),
      })),
      rawExcerpt,
      rawTruncated,
    };
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
        sequenceStep: draftRow.sequenceStep, outreachRecordId: draftRow.outreachRecordId,
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
    resultDraftId: string | null = null,
  ): ResumeReviewResult {
    return { leadId, sourceDraftId, outcome, costUsd, callsMade, violations, review, newDraftId, resultDraftId, newLeadStatus };
  }
}
