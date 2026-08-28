import { buildEmailReviewerMessages, type EmailBrief } from '../../prompts/email/index.js';
import { type LlmProvider, type LlmStatus, type LlmUsage, type ReasoningEffort } from '../../integrations/llm/provider.js';
import {
  EMAIL_REVIEW_JSON_SCHEMA,
  emailReviewSchema,
  type EmailReviewParsed,
  type EmailWriterParsed,
} from './email-schema.js';
import { isEmailReviewApprovable } from './email-review-gate.js';
import { validateEmail, type EmailValidationContext, type EmailValidationResult } from './email-validation.js';

/**
 * Read-only reviewer step for `outreach-compose-preview --review`.
 *
 * It takes an already-drafted, schema-valid writer output and runs the SAME sequence the
 * production writer service uses AFTER the writer call: deterministic validation → (only if that
 * passes) the exact production adversarial reviewer prompt/schema → the shared approvable gate.
 *
 * It is structurally read-only: it has no `EmailUnitOfWork`, no repositories, and no lead-service.
 * It cannot persist an email or transition a lead. It performs AT MOST one LLM call (the reviewer),
 * and only when `withReview` is true and deterministic validation passed — so a full preview stays
 * within the two-call budget (writer + reviewer).
 */

export interface PreviewReviewConfig {
  reviewerModel: string;
  reviewerEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
}

export type PreviewVerdict =
  /** Deterministic validation failed; the reviewer was NOT run. */
  | 'VALIDATION_FAILED'
  /** `withReview` was false; validation passed and the reviewer was intentionally skipped. */
  | 'PREVIEW_ONLY'
  /** Reviewer ran but returned a non-`ok` provider status or unparsable output. */
  | 'REVIEWER_ERROR'
  /** Reviewer ran and the shared approvable gate passed. */
  | 'REVIEW_APPROVABLE'
  /** Reviewer ran and the shared approvable gate did not pass. */
  | 'REVIEW_NOT_APPROVABLE';

export interface PreviewReviewerOutcome {
  status: LlmStatus;
  schemaValid: boolean;
  review: EmailReviewParsed | null;
  approvable: boolean;
}

export interface PreviewReviewResult {
  validation: EmailValidationResult;
  /** True once the reviewer LLM call was actually issued. */
  reviewRan: boolean;
  reviewer: PreviewReviewerOutcome | null;
  verdict: PreviewVerdict;
  /** Number of reviewer LLM calls issued by this function (0 or 1). */
  reviewerCalls: number;
  /** Usage/estimated cost of the reviewer call, when one was issued (else null). Display-only. */
  reviewerUsage: LlmUsage | null;
}

export interface PreviewReviewArgs {
  draft: EmailWriterParsed;
  validationCtx: EmailValidationContext;
  brief: EmailBrief;
  provider: LlmProvider;
  config: PreviewReviewConfig;
  withReview: boolean;
}

export async function previewEmailReview(args: PreviewReviewArgs): Promise<PreviewReviewResult> {
  const { draft, validationCtx, brief, provider, config, withReview } = args;

  // Deterministic validation gate — the reviewer never runs on copy that already fails the gate.
  const validation = validateEmail(draft, validationCtx);
  if (!validation.ok) {
    return { validation, reviewRan: false, reviewer: null, verdict: 'VALIDATION_FAILED', reviewerCalls: 0, reviewerUsage: null };
  }
  if (!withReview) {
    return { validation, reviewRan: false, reviewer: null, verdict: 'PREVIEW_ONLY', reviewerCalls: 0, reviewerUsage: null };
  }

  // Exact production reviewer prompt + schema.
  const rMsgs = buildEmailReviewerMessages(brief, draft);
  const rRes = await provider.generate({
    task: 'email_review', system: rMsgs.system, user: rMsgs.user, images: [],
    outputSchema: EMAIL_REVIEW_JSON_SCHEMA, schemaName: 'email_review',
    model: config.reviewerModel, reasoningEffort: config.reviewerEffort, store: config.store,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, maxRetries: config.maxRetries,
  });

  if (rRes.status !== 'ok') {
    return {
      validation, reviewRan: true, reviewerCalls: 1, verdict: 'REVIEWER_ERROR', reviewerUsage: rRes.usage,
      reviewer: { status: rRes.status, schemaValid: false, review: null, approvable: false },
    };
  }

  const parsed = emailReviewSchema.safeParse(rRes.rawJson);
  if (!parsed.success) {
    return {
      validation, reviewRan: true, reviewerCalls: 1, verdict: 'REVIEWER_ERROR', reviewerUsage: rRes.usage,
      reviewer: { status: rRes.status, schemaValid: false, review: null, approvable: false },
    };
  }

  const review = parsed.data;
  const approvable = isEmailReviewApprovable(review);
  return {
    validation, reviewRan: true, reviewerCalls: 1, reviewerUsage: rRes.usage,
    reviewer: { status: rRes.status, schemaValid: true, review, approvable },
    verdict: approvable ? 'REVIEW_APPROVABLE' : 'REVIEW_NOT_APPROVABLE',
  };
}
