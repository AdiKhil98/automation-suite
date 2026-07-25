import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { type AppConfig } from '../../config/env.js';
import { createDb } from '../../persistence/db.js';
import { requireDemoV2PersistDatabase } from '../../persistence/demo-v2-persist-guard.js';
import { DemoV2VisualReviewRepository } from '../../persistence/repositories/demo-v2-visual-review.repo.js';
import {
  reviewPackageHash, reviewPackageSchema, type DemoV2ReviewPackage,
} from '../../domain/demo-v2/render/review-package.js';
import {
  MockDemoV2VisualReviewProvider, visualReviewOutputHash, assertReviewCannotAutoApprove,
  type DemoV2VisualReviewProvider, type MockReviewFixture, type VisualReviewResult,
} from '../../domain/demo-v2/render/visual-review.js';
import {
  buildVisualReviewInput, visualReviewInputFingerprint,
  DEMO_V2_VISUAL_REVIEW_INPUT_VERSION, type VisualReviewInput, type VisualReviewProvenance,
} from '../../domain/demo-v2/render/visual-review-input.js';
import { demoV2Hash } from '../../domain/demo-v2/hash.js';
import { revisionPlanSchema } from '../../domain/demo-v2/render/visual-review.js';
import {
  deriveSectionAnchors, executeRevision, type RevisionConstraints,
} from '../../domain/demo-v2/render/revision-executor.js';
import { experiencePlanDataSchema } from '../../domain/demo-v2/orchestration-types.js';
import { ReviewLoopController } from '../../domain/demo-v2/render/visual-review-loop.js';

/**
 * Safe operator commands for the Milestone 3B2B1 visual-review loop.
 *
 * Defaults: MOCK reviewer, filesystem-only, no persistence, no network. Persistence is opt-in and
 * only ever touches the dedicated, guarded `DEMO_V2_PERSIST_DATABASE_URL` (never the operational
 * database). The live reviewer requires separate explicit flags AND all paid-call + V2 capability
 * flags; these commands never deploy, email, schedule, or run a live paid review automatically.
 */

const RUBRIC_VERSION = 'demo-v2-visual-review-rubric-1';

/** Deterministic hash of the fixed rubric vocabulary (categories + operations + decisions). */
function rubricHash(input: VisualReviewInput): string {
  return demoV2Hash(input.rubric);
}

/** Derive a conservative fictional provenance summary from a review package's plan. */
function provenanceFromPackage(pkg: DemoV2ReviewPackage): VisualReviewProvenance {
  const plan = experiencePlanDataSchema.safeParse(pkg.experiencePlan);
  const sourceIds = new Set<string>();
  const assetSelectionIds = new Set<string>();
  if (plan.success) {
    for (const section of plan.data.sections) {
      for (const id of section.selectedClaimSourceIds) sourceIds.add(id);
      for (const id of section.proposedAssetSelectionIds) assetSelectionIds.add(id);
    }
  }
  return {
    contentClaimClasses: ['VERBATIM_FACT', 'EVIDENCE_BOUND_DERIVATION', 'UI_LABEL', 'LEGAL_DISCLOSURE'],
    contentSourceIds: [...sourceIds].sort(),
    assetSelectionIds: [...assetSelectionIds].sort(),
    assetRecordHashes: [...pkg.hashes.assets].sort(),
    humanApprovedAssetReuse: false,
  };
}

export interface PreparedReview {
  input: VisualReviewInput;
  fingerprint: string;
  reviewPackageHash: string;
  reviewPackage: DemoV2ReviewPackage;
}

/** Build the exact reviewer input from a review package (filesystem-only, fail-closed). */
export function prepareReviewFromPackage(pkg: DemoV2ReviewPackage): PreparedReview {
  const parsed = reviewPackageSchema.parse(pkg);
  const pkgHash = reviewPackageHash(parsed);
  const input = buildVisualReviewInput({
    reviewPackage: parsed,
    reviewPackageHash: pkgHash,
    provenance: provenanceFromPackage(parsed),
  });
  return { input, fingerprint: visualReviewInputFingerprint(input), reviewPackageHash: pkgHash, reviewPackage: parsed };
}

async function readReviewPackage(path: string): Promise<DemoV2ReviewPackage> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  // review-package.json may carry an extra top-level reviewPackageHash written by the exporter.
  delete raw.reviewPackageHash;
  return reviewPackageSchema.parse(raw);
}

function printResult(prepared: PreparedReview, result: VisualReviewResult): void {
  assertReviewCannotAutoApprove(result);
  console.log('Demo V2 visual review (advisory — never an automatic pass):');
  console.log(`  provider/model  : ${result.provider} / ${result.requestedModel} (effort ${result.reasoningEffort})`);
  console.log(`  decision        : ${result.decision}`);
  console.log(`  overall score   : ${String(result.overallScore)}`);
  console.log(`  category scores : ${Object.entries(result.scores).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
  console.log(`  blockers        : ${result.blockers.length === 0 ? '(none)' : result.blockers.map((b) => b.code).join(', ')}`);
  console.log(`  findings        : ${result.findings.length === 0 ? '(none)' : result.findings.map((f) => f.code).join(', ')}`);
  console.log(`  permitted ops   : ${result.permittedRevisionOperations.join(', ') || '(none)'}`);
  console.log(`  cost (USD)      : ${result.costUsd.toFixed(6)}`);
  console.log(`  input version   : ${DEMO_V2_VISUAL_REVIEW_INPUT_VERSION}`);
  console.log(`  input fingerprint: ${prepared.fingerprint}`);
  console.log(`  render hash     : ${prepared.input.hashes.render}`);
  console.log(`  screenshot set  : ${prepared.input.hashes.screenshotSet}`);
  console.log(`  review package  : ${prepared.reviewPackageHash}`);
  console.log(`  review output   : ${visualReviewOutputHash(result)}`);
  console.log('  AUTO_REVIEW_PASSED / HUMAN_APPROVED not recorded; nothing deployment eligible.');
}

function assertGuardedPersistAvailable(config: AppConfig, opts: { persist?: boolean }): void {
  if (!opts.persist) return;
  if (config.DEMO_ENGINE_VERSION !== 'v2' || !config.DEMO_V2_ENABLED) {
    throw new Error('demo_v2_persist_blocked:DEMO_V2_ENABLED_required');
  }
  // Validates the dedicated, guarded database (loopback, test-named) — never the operational DATABASE_URL.
  requireDemoV2PersistDatabase();
  console.log('  (a standalone review persists only within a full loop against an existing render version; use demo-v2-review-loop.)');
}

/** `demo-v2-review`: review an existing fictional review package with the mock reviewer. */
export async function demoV2ReviewCommand(config: AppConfig, opts: {
  reviewPackage?: string; fixture?: MockReviewFixture; provider?: string; live?: boolean; persist?: boolean;
}): Promise<void> {
  if (!opts.reviewPackage) throw new Error('demo_v2_review_requires_review_package_path');

  if (opts.provider === 'openai' || opts.live) {
    // The live reviewer is real, but it is never launched from here: it needs the paid-call and V2
    // capability flags AND images prepared by the loop. This command is mock-only by contract.
    throw new Error('demo_v2_review_live_requires_demo_v2_review_loop_with_explicit_live_flags');
  }

  const pkg = await readReviewPackage(opts.reviewPackage);
  const prepared = prepareReviewFromPackage(pkg);
  const provider: DemoV2VisualReviewProvider = new MockDemoV2VisualReviewProvider(opts.fixture ?? 'strong-premium-dental');
  const result = await provider.review({
    screenshotRefs: [...prepared.input.finalScreenshots, ...prepared.input.baselineScreenshots].map((s) => s.ref),
    referenceFamily: prepared.input.referenceFamily,
    renderHash: prepared.input.hashes.render,
    screenshotSetHash: prepared.input.hashes.screenshotSet,
    reviewPackageHash: prepared.reviewPackageHash,
    inputFingerprint: prepared.fingerprint,
  });
  printResult(prepared, result);
  assertGuardedPersistAvailable(config, opts);
}

/** `demo-v2-revise`: apply a permitted-revision-operations file to a review package's plan. */
export async function demoV2ReviseCommand(_config: AppConfig, opts: {
  reviewPackage?: string; operations?: string;
}): Promise<void> {
  if (!opts.reviewPackage) throw new Error('demo_v2_revise_requires_review_package_path');
  if (!opts.operations) throw new Error('demo_v2_revise_requires_operations_path');

  const pkg = await readReviewPackage(opts.reviewPackage);
  const plan = experiencePlanDataSchema.parse(pkg.experiencePlan);
  const anchors = deriveSectionAnchors(plan);

  const opsRaw = JSON.parse(await readFile(opts.operations, 'utf8')) as unknown;
  const planFile = revisionPlanSchema.parse(opsRaw);

  const constraints: RevisionConstraints = {
    boundRenderHash: pkg.hashes.render,
    anchors,
    allowedVariants: Object.fromEntries(plan.sections.map((s, i) => [anchors[i] ?? s.componentFamily, [s.componentVariant]])),
    approvedCopyAlternatives: {},
  };

  const result = executeRevision({
    plan,
    operations: planFile.operations,
    constraints,
    permittedOperations: [...new Set(planFile.operations.map((op) => op.operation))],
  });
  console.log('Demo V2 controlled revision applied (presentation only; evidence bindings preserved):');
  console.log(`  operations applied : ${String(result.appliedOperations)}`);
  console.log(`  new plan hash      : ${result.planHash}`);
  console.log(`  overlay hash       : ${result.overlayHash}`);
  console.log('  a new ExperiencePlan/render version + screenshots must be produced before re-review.');
}

/** `demo-v2-review-history`: read-only inspection of persisted reviews (guarded database only). */
export async function demoV2ReviewHistoryCommand(config: AppConfig, opts: { limit?: string }): Promise<void> {
  if (config.DEMO_ENGINE_VERSION !== 'v2' || !config.DEMO_V2_ENABLED) {
    throw new Error('demo_v2_persist_blocked:DEMO_V2_ENABLED_required');
  }
  const permit = requireDemoV2PersistDatabase();
  const { db, pool } = createDb(permit.databaseUrl);
  try {
    const repo = new DemoV2VisualReviewRepository(db);
    const reviews = await repo.recentReviews(Number.parseInt(opts.limit ?? '10', 10));
    console.log(`Demo V2 visual reviews (${new URL(permit.databaseUrl).pathname.replace(/^\/+/, '')}): ${String(reviews.length)}\n`);
    for (const review of reviews) {
      console.log(`  artifact ${review.artifactId} run ${review.reviewRunId} cycle ${String(review.cycle)} [${review.isCurrent ? 'current' : 'superseded'}${review.stale ? ' STALE' : ''}]`);
      console.log(`    provider/model : ${review.provider} / ${review.requestedModel} (effort ${review.reasoningEffort})`);
      console.log(`    decision       : ${review.decision}  overall ${String(review.overallScore)}`);
      console.log(`    blockers       : ${JSON.stringify(review.blockers)}`);
      console.log(`    cost (USD)     : ${String(review.costUsd)}  tokens in/out ${String(review.inputTokens ?? '-')}/${String(review.outputTokens ?? '-')}`);
      console.log(`    bound render   : ${review.boundRenderHash}`);
      console.log(`    output hash    : ${review.reviewOutputHash}\n`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * `demo-v2-review-loop`: run one complete fictional review loop with the MOCK reviewer over a review
 * package, honouring the 3-review / 2-revision caps. Filesystem-only; no persistence, no network.
 */
export async function demoV2ReviewLoopCommand(_config: AppConfig, opts: {
  reviewPackage?: string; sequence?: string;
}): Promise<void> {
  if (!opts.reviewPackage) throw new Error('demo_v2_review_loop_requires_review_package_path');
  // A fictional decision sequence lets an operator exercise the loop deterministically without a browser.
  const fixtures = (opts.sequence ?? 'weak-hierarchy,weak-hierarchy,strong-premium-dental')
    .split(',').map((s) => s.trim()) as MockReviewFixture[];

  const pkg = await readReviewPackage(opts.reviewPackage);
  const prepared = prepareReviewFromPackage(pkg);
  const controller = new ReviewLoopController({ maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 0, ceilingUsd: 3 });

  const runId = randomUUID();
  console.log(`Demo V2 review loop ${runId} (mock reviewer; filesystem-only):`);
  let cycle = 0;
  for (const fixture of fixtures) {
    if (!controller.canReview()) break;
    cycle += 1;
    const provider = new MockDemoV2VisualReviewProvider(fixture);
    const result = await provider.review({
      screenshotRefs: [...prepared.input.finalScreenshots, ...prepared.input.baselineScreenshots].map((s) => s.ref),
      referenceFamily: prepared.input.referenceFamily,
      renderHash: prepared.input.hashes.render,
      screenshotSetHash: prepared.input.hashes.screenshotSet,
      reviewPackageHash: prepared.reviewPackageHash,
      inputFingerprint: prepared.fingerprint,
    });
    controller.recordReview(result);
    console.log(`  cycle ${String(cycle)} review: ${result.decision} (overall ${String(result.overallScore)}, cost ${result.costUsd.toFixed(6)})`);
    if (result.decision !== 'REVISE') break;
    if (!controller.canRevise()) break;
    controller.recordRevision();
    console.log(`  cycle ${String(cycle)} revision applied (${result.permittedRevisionOperations.join(', ') || 'no ops'}) → new version required`);
  }
  console.log(`  reviews: ${String(controller.reviewCallCount)}/3  revisions: ${String(controller.revisionCount)}/2  total cost: ${controller.totalSpendUsd.toFixed(6)}`);
  console.log(`  terminal status: ${controller.resolveStatus()} (never AUTO_REVIEW_PASSED)`);
  console.log(`  rubric: ${RUBRIC_VERSION} (${rubricHash(prepared.input)})`);
}
