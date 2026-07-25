import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { type Logger } from 'pino';
import { type AppConfig } from '../../config/env.js';
import { requireDemoV2PersistDatabase } from '../../persistence/demo-v2-persist-guard.js';
import {
  reviewPackageSchema, type DemoV2ReviewPackage,
} from '../../domain/demo-v2/render/review-package.js';
import {
  assertReviewCannotAutoApprove, type DemoV2VisualReviewProvider, type VisualReviewResult,
} from '../../domain/demo-v2/render/visual-review.js';
import {
  projectVisualReviewCost, evaluateDemoV2Budget, assertWithinDemoV2Budget, VisualReviewCache,
} from '../../domain/demo-v2/render/visual-review-cost.js';
import { ReviewLoopController } from '../../domain/demo-v2/render/visual-review-loop.js';
import { OpenAiDemoV2VisualReviewProvider } from '../../integrations/llm/demo-v2-visual-reviewer.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { PRICE_VERIFIED_AT, priceKnown } from '../../integrations/llm/pricing.js';
import { type ImageDetail, type LlmImage } from '../../integrations/llm/provider.js';
import { prepareReviewFromPackage, type PreparedReview } from './demo-v2-review.js';

/**
 * `demo-v2-review-loop-live`: run ONE guarded LIVE OpenAI visual-review cycle over an existing
 * fictional review package, through the same controlled review loop the mock command uses.
 *
 * This is the ONLY command that can spend money on the Demo V2 visual reviewer, and it is fenced on
 * every side: an explicit `--confirm-live-review` acknowledgement, all paid-call + V2 capability
 * flags, a FIXED provider/model/effort (OpenAI `gpt-5.6-sol`, high effort), NO fallback model, NO
 * automatic retries, a hard cap of 3 review calls / 2 revisions, a mandatory pre-call projected-cost
 * guard against the $3 artifact ceiling, and an exact-fingerprint cache so a byte-identical input
 * never triggers a second paid call. It is filesystem-only by default; `--persist` validates ONLY
 * the dedicated, guarded `DEMO_V2_PERSIST_DATABASE_URL` (never the operational `DATABASE_URL`). It
 * never deploys, emails, schedules, or records an automatic pass / human approval.
 */

/** The reviewer identity is FIXED for this command — configuration can never substitute it. */
export const LIVE_REVIEW_MODEL = 'gpt-5.6-sol';
export const LIVE_REVIEW_EFFORT = 'high' as const;

export interface LiveReviewLoopOptions {
  reviewPackage?: string;
  persist?: boolean;
  confirmLiveReview?: boolean;
}

/**
 * Fail-closed environment gate. Every condition must hold before a paid call is even contemplated;
 * any missing piece throws a distinct, testable error and no reviewer is constructed.
 */
export function assertLiveReviewEnvironment(config: AppConfig, opts: LiveReviewLoopOptions): void {
  // The paid call is never implicit: the operator must explicitly acknowledge it.
  if (!opts.confirmLiveReview) {
    throw new Error('demo_v2_review_loop_live_requires_confirm_live_review');
  }
  if (config.DEMO_ENGINE_VERSION !== 'v2' || !config.DEMO_V2_ENABLED) {
    throw new Error('demo_v2_review_loop_live_requires_demo_v2_enabled');
  }
  // A mock configuration can never reach the live reviewer.
  if (config.DEMO_V2_VISUAL_REVIEW_PROVIDER !== 'openai') {
    throw new Error('demo_v2_review_loop_live_requires_openai_visual_review_provider');
  }
  if (config.LLM_PROVIDER !== 'openai') {
    throw new Error('demo_v2_review_loop_live_requires_openai_llm_provider');
  }
  // Paid-call kill switch + credential.
  if (!config.ALLOW_PAID_LLM_CALLS) {
    throw new Error('demo_v2_review_loop_live_requires_allow_paid_llm_calls');
  }
  if (!config.OPENAI_API_KEY) {
    throw new Error('demo_v2_review_loop_live_requires_openai_api_key');
  }
  // The model is FIXED to gpt-5.6-sol; any configured substitution is refused before a paid call.
  if (config.DEMO_V2_VISUAL_REVIEW_MODEL !== LIVE_REVIEW_MODEL) {
    throw new Error('demo_v2_review_loop_live_model_substitution_forbidden');
  }
  // No verified price ⇒ no way to prove the budget holds ⇒ no call.
  if (!PRICE_VERIFIED_AT) {
    throw new Error('demo_v2_review_loop_live_price_table_unverified');
  }
  if (!priceKnown(LIVE_REVIEW_MODEL)) {
    throw new Error('demo_v2_review_loop_live_price_unknown');
  }
}

async function readReviewPackage(path: string): Promise<DemoV2ReviewPackage> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  // review-package.json may carry an extra top-level reviewPackageHash written by the exporter.
  delete raw.reviewPackageHash;
  return reviewPackageSchema.parse(raw);
}

export interface LoadedReviewImages {
  images: LlmImage[];
  dimensions: Array<{ width: number; height: number }>;
}

/**
 * Load the exact screenshot bytes the reviewer will see, resolved relative to the review package.
 * Fails closed if any file's SHA-256 does not match the hash recorded in the package (a tampered or
 * mismatched screenshot set is never uploaded).
 */
export async function loadReviewImages(
  pkg: DemoV2ReviewPackage, packagePath: string, imageDetail: ImageDetail,
): Promise<LoadedReviewImages> {
  const baseDir = dirname(resolve(packagePath));
  const images: LlmImage[] = [];
  const dimensions: Array<{ width: number; height: number }> = [];
  for (const shot of pkg.screenshots) {
    const bytes = await readFile(resolve(baseDir, shot.path));
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    if (fileHash !== shot.fileHash) {
      throw new Error('demo_v2_review_loop_live_screenshot_hash_mismatch');
    }
    const ref = `${shot.kind.toLowerCase()}-${shot.language}-${shot.viewport.toLowerCase()}.png`;
    images.push({ id: ref, mediaType: 'image/png', dataBase64: bytes.toString('base64'), detail: imageDetail });
    dimensions.push({ width: shot.width, height: shot.height });
  }
  return { images, dimensions };
}

export interface LiveReviewLoopDeps {
  prepared: PreparedReview;
  dimensions: ReadonlyArray<{ width: number; height: number }>;
  maxOutputTokens: number;
  imageDetail: ImageDetail;
  ceilingUsd: number;
  cache: VisualReviewCache;
  /** Deferred provider construction — invoked ONLY after the projected-cost guard passes. */
  makeProvider: () => DemoV2VisualReviewProvider;
}

export interface LiveReviewLoopOutcome {
  result: VisualReviewResult;
  fromCache: boolean;
  projectedUsd: number;
  controller: ReviewLoopController;
}

/**
 * One controlled live review cycle. The exact-fingerprint cache short-circuits a repeated identical
 * input; otherwise the projected worst-case cost is checked against the $3 ceiling BEFORE the
 * reviewer is even constructed, and the controller re-checks the ceiling on actual spend. A REVISE
 * verdict cannot be auto-applied live (a new render version + screenshots are required), so the loop
 * makes at most one paid call here while still honouring the 3-review / 2-revision caps.
 */
export async function runLiveReviewLoop(deps: LiveReviewLoopDeps): Promise<LiveReviewLoopOutcome> {
  const { prepared } = deps;
  const controller = new ReviewLoopController({
    maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 0, ceilingUsd: deps.ceilingUsd,
  });

  const cached = deps.cache.get(prepared.fingerprint);
  if (cached) {
    controller.recordReview(cached);
    return { result: cached, fromCache: true, projectedUsd: 0, controller };
  }

  // Mandatory pre-call projected-cost guard. This throws BEFORE any reviewer is built or called.
  const projection = projectVisualReviewCost({
    model: LIVE_REVIEW_MODEL,
    input: prepared.input,
    maxOutputTokens: deps.maxOutputTokens,
    imageDetail: deps.imageDetail,
    screenshotDimensions: deps.dimensions,
  });
  const decision = evaluateDemoV2Budget({
    projection, priorSpendUsd: controller.totalSpendUsd, ceilingUsd: deps.ceilingUsd,
  });
  assertWithinDemoV2Budget(decision);

  controller.assertCanReview();
  const provider = deps.makeProvider();
  const result = await provider.review({
    screenshotRefs: [...prepared.input.finalScreenshots, ...prepared.input.baselineScreenshots].map((s) => s.ref),
    referenceFamily: prepared.input.referenceFamily,
    renderHash: prepared.input.hashes.render,
    screenshotSetHash: prepared.input.hashes.screenshotSet,
    reviewPackageHash: prepared.reviewPackageHash,
    inputFingerprint: prepared.fingerprint,
  });
  // A live verdict is advisory only and can never record an automatic pass or human approval.
  assertReviewCannotAutoApprove(result);
  controller.recordReview(result);
  deps.cache.set(prepared.fingerprint, result);
  return { result, fromCache: false, projectedUsd: projection.projectedUsd ?? 0, controller };
}

/** CLI entry point: assert the environment, prepare the input, then run one guarded live cycle. */
export async function demoV2ReviewLoopLiveCommand(
  config: AppConfig, logger: Logger, opts: LiveReviewLoopOptions,
): Promise<void> {
  if (!opts.reviewPackage) throw new Error('demo_v2_review_loop_live_requires_review_package_path');
  assertLiveReviewEnvironment(config, opts);
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) throw new Error('demo_v2_review_loop_live_requires_openai_api_key');

  // Persistence, when requested, is validated against the dedicated guarded database ONLY. This
  // never reads DATABASE_URL and rejects any supabase/pooler/remote/production/non-test target.
  if (opts.persist) {
    const permit = requireDemoV2PersistDatabase();
    console.log(`  persist target validated (guarded test DB only): ${new URL(permit.databaseUrl).pathname.replace(/^\/+/, '')}`);
  }

  const pkg = await readReviewPackage(opts.reviewPackage);
  const prepared = prepareReviewFromPackage(pkg);
  const { images, dimensions } = await loadReviewImages(pkg, opts.reviewPackage, config.LLM_IMAGE_DETAIL);

  const runId = randomUUID();
  console.log(`Demo V2 LIVE review loop ${runId} (OpenAI ${LIVE_REVIEW_MODEL}, effort ${LIVE_REVIEW_EFFORT}; PAID call):`);
  console.log('  no fallback model, no retries; max 3 reviews / 2 revisions; $3 ceiling enforced before calling.');

  const outcome = await runLiveReviewLoop({
    prepared,
    dimensions,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
    imageDetail: config.LLM_IMAGE_DETAIL,
    ceilingUsd: config.DEMO_V2_MAX_COST_USD_PER_DEMO,
    cache: new VisualReviewCache(),
    makeProvider: () => new OpenAiDemoV2VisualReviewProvider(
      {
        provider: new OpenAiResponsesProvider({ apiKey, logger }),
        model: LIVE_REVIEW_MODEL,
        reasoningEffort: LIVE_REVIEW_EFFORT,
        timeoutMs: config.LLM_TIMEOUT_MS,
        maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        store: config.LLM_STORE_RESPONSES,
        imageDetail: config.LLM_IMAGE_DETAIL,
        logger,
      },
      prepared.input,
      images,
    ),
  });

  const { result, controller } = outcome;
  console.log('Demo V2 live visual review (advisory — never an automatic pass):');
  console.log(`  provider/model  : ${result.provider} / ${result.requestedModel} (effort ${result.reasoningEffort})`);
  console.log(`  decision        : ${result.decision} (overall ${String(result.overallScore)})`);
  console.log(`  blockers        : ${result.blockers.map((b) => b.code).join(', ') || '(none)'}`);
  console.log(`  permitted ops   : ${result.permittedRevisionOperations.join(', ') || '(none)'}`);
  console.log(`  actual cost USD : ${result.costUsd.toFixed(6)}${outcome.fromCache ? ' (cached — no new paid call)' : ''}`);
  console.log(`  reviews/revisions: ${String(controller.reviewCallCount)}/3  ${String(controller.revisionCount)}/2  total ${controller.totalSpendUsd.toFixed(6)}`);
  console.log(`  terminal status : ${controller.resolveStatus()} (never AUTO_REVIEW_PASSED / HUMAN_APPROVED)`);
  if (result.decision === 'REVISE') {
    console.log('  REVISE: a new ExperiencePlan/render version + screenshots must be produced before any re-review.');
  }
}
