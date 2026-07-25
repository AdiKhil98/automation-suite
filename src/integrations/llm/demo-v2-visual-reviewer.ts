import { type Logger } from 'pino';
import {
  visualReviewResultSchema, type DemoV2VisualReviewProvider, type VisualReviewRequest,
  type VisualReviewResult,
} from '../../domain/demo-v2/render/visual-review.js';
import {
  visualReviewInputFingerprint, visualReviewScreenshotRefs, VISUAL_REVIEW_OUTPUT_JSON_SCHEMA,
  type VisualReviewInput,
} from '../../domain/demo-v2/render/visual-review-input.js';
import { type ImageDetail, type LlmImage, type LlmProvider, type ReasoningEffort } from './provider.js';

/**
 * The LIVE OpenAI visual reviewer. It is the only reviewer that can spend money, and it does so
 * only behind the paid-call + V2 capability guards enforced by its caller. It has NO fallback model
 * and makes NO automatic retries (maxRetries comes from config, 0 at the guarded live gate).
 *
 * It fails closed: a refusal, an incomplete/truncated response, a schema-invalid body, an
 * unaccountable cost, or a citation of a screenshot outside the bound input all raise rather than
 * return a verdict. A reviewer verdict can never be recorded as an automatic pass.
 */

export interface OpenAiVisualReviewerDeps {
  provider: LlmProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  maxOutputTokens: number;
  /** No automatic retries at the live gate; the caller passes 0. */
  maxRetries: number;
  store: boolean;
  imageDetail: ImageDetail;
  logger?: Logger;
}

const REVIEWER_SYSTEM = [
  'You are Sol, a senior visual design reviewer for premium dental-clinic concept pages.',
  'You receive ONLY: original baseline screenshots, final screenshots, the Creative Brief, the',
  'ExperiencePlan, the reference family, deterministic validation results, any audit findings, a',
  'content/asset provenance summary, and the relevant hashes. Judge only what is visible and',
  'provided. Never invent facts, services, people, statistics, URLs, contact channels, or images.',
  'Every blocker and finding MUST cite a screenshotRef that exists in the provided set.',
  'Only a REVISE decision may list permittedRevisionOperations, and only from the allowed vocabulary.',
  'Your decision is APPROVE, REVISE, or REJECT. You cannot approve deployment or human sign-off.',
].join(' ');

export class OpenAiDemoV2VisualReviewProvider implements DemoV2VisualReviewProvider {
  readonly name = 'openai' as const;
  private readonly fingerprint: string;
  private readonly allowedRefs: Set<string>;

  constructor(
    private readonly deps: OpenAiVisualReviewerDeps,
    private readonly input: VisualReviewInput,
    private readonly images: readonly LlmImage[],
  ) {
    this.fingerprint = visualReviewInputFingerprint(input);
    this.allowedRefs = new Set(visualReviewScreenshotRefs(input));
    if (images.length === 0) throw new Error('demo_v2_visual_review_requires_screenshots');
  }

  async review(request: VisualReviewRequest): Promise<VisualReviewResult> {
    // Defensive binding: the request must describe the exact input this provider was built for.
    if (request.inputFingerprint !== this.fingerprint) {
      throw new Error('demo_v2_visual_review_input_fingerprint_mismatch');
    }
    if (request.renderHash !== this.input.hashes.render
      || request.screenshotSetHash !== this.input.hashes.screenshotSet
      || request.reviewPackageHash !== this.input.hashes.reviewPackage) {
      throw new Error('demo_v2_visual_review_bound_hash_mismatch');
    }

    const res = await this.deps.provider.generate({
      task: 'demo_design_review',
      system: REVIEWER_SYSTEM,
      user: JSON.stringify(this.input),
      images: [...this.images],
      outputSchema: VISUAL_REVIEW_OUTPUT_JSON_SCHEMA,
      schemaName: 'demo_v2_visual_review',
      model: this.deps.model,
      reasoningEffort: this.deps.reasoningEffort,
      store: this.deps.store,
      timeoutMs: this.deps.timeoutMs,
      maxOutputTokens: this.deps.maxOutputTokens,
      maxRetries: this.deps.maxRetries,
    });

    // Fail closed on anything that is not a clean, complete, parseable response. No fallback model,
    // no retry — the caller sees the failure and stops.
    if (res.status !== 'ok' || res.rawJson === null) {
      throw new Error(`demo_v2_visual_review_failed:${res.status}${res.incompleteReason ? `:${res.incompleteReason}` : ''}`);
    }
    // The requested model must be the one that answered — no silent model substitution.
    if (res.resolvedModel && res.resolvedModel !== this.deps.model && !res.resolvedModel.startsWith(this.deps.model)) {
      throw new Error(`demo_v2_visual_review_model_substituted:${res.resolvedModel}`);
    }
    // Unaccountable spend blocks: a null cost means we cannot prove the budget held.
    if (res.usage.estimatedCostUsd === null) {
      throw new Error('demo_v2_visual_review_cost_unaccountable');
    }

    const body = res.rawJson as Record<string, unknown>;
    // Screenshot refs the model returns must be a subset of the bound input — no invented evidence.
    const claimedRefs = Array.isArray(body.screenshotRefs) ? (body.screenshotRefs as unknown[]) : [];
    for (const ref of claimedRefs) {
      if (typeof ref !== 'string' || !this.allowedRefs.has(ref)) {
        throw new Error(`demo_v2_visual_review_unknown_screenshot_ref:${String(ref)}`);
      }
    }

    const parsed = visualReviewResultSchema.safeParse({
      ...body,
      schemaVersion: 'demo-v2-visual-review-2',
      provider: 'openai',
      requestedModel: this.deps.model,
      resolvedModel: res.resolvedModel,
      reasoningEffort: this.deps.reasoningEffort,
      responseId: res.responseId,
      usage: {
        inputTokens: res.usage.inputTokens,
        cachedInputTokens: res.usage.cachedInputTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens,
      },
      costUsd: res.usage.estimatedCostUsd,
    });
    if (!parsed.success) {
      this.deps.logger?.warn({ issues: parsed.error.issues.slice(0, 8) }, 'live visual review failed schema validation');
      throw new Error('demo_v2_visual_review_schema_invalid');
    }
    return parsed.data;
  }
}
