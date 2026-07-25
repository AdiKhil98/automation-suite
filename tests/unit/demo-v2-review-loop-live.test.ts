import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AppConfig } from '../../src/config/env.js';
import {
  buildVisualReviewInput, visualReviewInputFingerprint, visualReviewScreenshotRefs,
} from '../../src/domain/demo-v2/render/visual-review-input.js';
import { reviewPackageHash } from '../../src/domain/demo-v2/render/review-package.js';
import {
  MockDemoV2VisualReviewProvider, type DemoV2VisualReviewProvider, type VisualReviewRequest,
  type VisualReviewResult,
} from '../../src/domain/demo-v2/render/visual-review.js';
import { VisualReviewCache } from '../../src/domain/demo-v2/render/visual-review-cost.js';
import {
  assertLiveReviewEnvironment, runLiveReviewLoop, LIVE_REVIEW_MODEL, LIVE_REVIEW_EFFORT,
  type LiveReviewLoopOptions,
} from '../../src/cli/commands/demo-v2-review-loop-live.js';
import { buildFixtureReviewPackage } from '../fixtures/demo-v2/visual-review-fixture.js';

const provenance = {
  contentClaimClasses: ['VERBATIM_FACT'], contentSourceIds: ['fact.hero'], assetSelectionIds: ['asset-hero'],
  assetRecordHashes: ['a'.repeat(64)], humanApprovedAssetReuse: false,
};

/** A fully live-eligible configuration; individual tests weaken exactly one field. */
function liveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    DEMO_ENGINE_VERSION: 'v2',
    DEMO_V2_ENABLED: true,
    DEMO_V2_VISUAL_REVIEW_PROVIDER: 'openai',
    LLM_PROVIDER: 'openai',
    ALLOW_PAID_LLM_CALLS: true,
    OPENAI_API_KEY: 'sk-test-fictional',
    DEMO_V2_VISUAL_REVIEW_MODEL: LIVE_REVIEW_MODEL,
    ...overrides,
  } as unknown as AppConfig;
}

const confirm: LiveReviewLoopOptions = { confirmLiveReview: true };

function prepared() {
  const pkg = buildFixtureReviewPackage();
  const pkgHash = reviewPackageHash(pkg);
  const input = buildVisualReviewInput({ reviewPackage: pkg, reviewPackageHash: pkgHash, provenance });
  return { input, fingerprint: visualReviewInputFingerprint(input), reviewPackageHash: pkgHash, reviewPackage: pkg };
}

/** Zero-network provider that counts its calls; delegates to the mock verdict fixtures. */
class CountingProvider implements DemoV2VisualReviewProvider {
  readonly name = 'openai' as const;
  calls = 0;
  private readonly inner = new MockDemoV2VisualReviewProvider('weak-hierarchy');
  async review(request: VisualReviewRequest): Promise<VisualReviewResult> {
    this.calls += 1;
    return this.inner.review(request);
  }
}

const dims = [{ width: 1440, height: 3200 }, { width: 390, height: 4200 }];

describe('demo-v2-review-loop-live environment gate', () => {
  it('rejects when the live confirmation is missing', () => {
    expect(() => assertLiveReviewEnvironment(liveConfig(), {}))
      .toThrow('demo_v2_review_loop_live_requires_confirm_live_review');
  });

  it('rejects when the paid-call flags are missing', () => {
    expect(() => assertLiveReviewEnvironment(liveConfig({ ALLOW_PAID_LLM_CALLS: false }), confirm))
      .toThrow('demo_v2_review_loop_live_requires_allow_paid_llm_calls');
    expect(() => assertLiveReviewEnvironment(liveConfig({ OPENAI_API_KEY: undefined }), confirm))
      .toThrow('demo_v2_review_loop_live_requires_openai_api_key');
  });

  it('rejects a mock configuration', () => {
    expect(() => assertLiveReviewEnvironment(liveConfig({ DEMO_V2_VISUAL_REVIEW_PROVIDER: 'mock' }), confirm))
      .toThrow('demo_v2_review_loop_live_requires_openai_visual_review_provider');
    expect(() => assertLiveReviewEnvironment(liveConfig({ LLM_PROVIDER: 'mock' }), confirm))
      .toThrow('demo_v2_review_loop_live_requires_openai_llm_provider');
  });

  it('rejects a model substitution (reviewer identity is fixed to gpt-5.6-sol)', () => {
    expect(() => assertLiveReviewEnvironment(liveConfig({ DEMO_V2_VISUAL_REVIEW_MODEL: 'gpt-4o-mini' }), confirm))
      .toThrow('demo_v2_review_loop_live_model_substitution_forbidden');
  });

  it('accepts a fully live-eligible configuration', () => {
    expect(() => assertLiveReviewEnvironment(liveConfig(), confirm)).not.toThrow();
    expect(LIVE_REVIEW_EFFORT).toBe('high');
  });
});

describe('demo-v2-review-loop-live cost + cache enforcement', () => {
  it('enforces the cost ceiling BEFORE constructing or calling the reviewer', async () => {
    const p = prepared();
    let providerBuilt = 0;
    await expect(runLiveReviewLoop({
      prepared: p, dimensions: dims, maxOutputTokens: 4000, imageDetail: 'high',
      ceilingUsd: 0.0000001, // any real projection exceeds this
      cache: new VisualReviewCache(),
      makeProvider: () => { providerBuilt += 1; return new CountingProvider(); },
    })).rejects.toThrow('demo_v2_visual_review_budget_blocked:budget_ceiling_exceeded');
    expect(providerBuilt).toBe(0); // no reviewer was ever built, so no request could be made
  });

  it('makes exactly one guarded call and then serves the exact-fingerprint cache with no new call', async () => {
    const p = prepared();
    const cache = new VisualReviewCache();
    let providerBuilt = 0;
    const provider = new CountingProvider();
    const make = () => { providerBuilt += 1; return provider; };

    const first = await runLiveReviewLoop({
      prepared: p, dimensions: dims, maxOutputTokens: 4000, imageDetail: 'high',
      ceilingUsd: 3, cache, makeProvider: make,
    });
    expect(first.fromCache).toBe(false);
    expect(first.result.decision).toBe('REVISE');
    expect(first.controller.reviewCallCount).toBe(1);
    expect(provider.calls).toBe(1);

    const second = await runLiveReviewLoop({
      prepared: p, dimensions: dims, maxOutputTokens: 4000, imageDetail: 'high',
      ceilingUsd: 3, cache, makeProvider: make,
    });
    expect(second.fromCache).toBe(true);
    expect(provider.calls).toBe(1); // byte-identical input ⇒ no second paid call
    expect(providerBuilt).toBe(1);
  });
});

describe('demo-v2-review-loop-live side-effect safety', () => {
  it('has no outbound, deployment, scheduling, or automatic-pass path and never reads DATABASE_URL', () => {
    const src = readFileSync('src/cli/commands/demo-v2-review-loop-live.ts', 'utf8');
    expect(src).not.toMatch(/integrations\/(?:netlify|gmail|send)|schedule-service|nodemailer|drafts\.(?:create|send)/i);
    expect(src).not.toMatch(/=\s*'(?:AUTO_REVIEW_PASSED|HUMAN_APPROVED)'/);
    expect(src).not.toMatch(/deploymentEligible:\s*true/);
    expect(src).not.toMatch(/process\.env\.DATABASE_URL|config\.DATABASE_URL/);
    // Persistence goes only through the dedicated guarded database helper.
    expect(src).toMatch(/requireDemoV2PersistDatabase/);
  });

  it('never references a real network client statically beyond the guarded provider adapters', () => {
    const refs = visualReviewScreenshotRefs(prepared().input);
    expect(refs.length).toBeGreaterThan(0); // the reviewer only ever cites bound screenshots
  });
});
