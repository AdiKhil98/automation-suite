import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildVisualReviewInput, visualReviewInputFingerprint, visualReviewScreenshotRefs,
  VISUAL_REVIEW_OUTPUT_JSON_SCHEMA,
} from '../../src/domain/demo-v2/render/visual-review-input.js';
import {
  MockDemoV2VisualReviewProvider, visualReviewOutputHash, assertReviewCannotAutoApprove,
  DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION,
} from '../../src/domain/demo-v2/render/visual-review.js';
import {
  projectVisualReviewCost, evaluateDemoV2Budget, assertWithinDemoV2Budget, VisualReviewCache,
} from '../../src/domain/demo-v2/render/visual-review-cost.js';
import { OpenAiDemoV2VisualReviewProvider } from '../../src/integrations/llm/demo-v2-visual-reviewer.js';
import { type LlmProvider, type LlmRequest, type LlmResult } from '../../src/integrations/llm/provider.js';
import { buildFixtureReviewPackage, fixtureReviewPackageHash } from '../fixtures/demo-v2/visual-review-fixture.js';

const provenance = {
  contentClaimClasses: ['VERBATIM_FACT'], contentSourceIds: ['fact.hero'], assetSelectionIds: ['asset-hero'],
  assetRecordHashes: ['a'.repeat(64)], humanApprovedAssetReuse: false,
};

function prepared() {
  const pkg = buildFixtureReviewPackage();
  const pkgHash = fixtureReviewPackageHash(pkg);
  const input = buildVisualReviewInput({ reviewPackage: pkg, reviewPackageHash: pkgHash, provenance });
  return { pkg, pkgHash, input, fingerprint: visualReviewInputFingerprint(input) };
}

/** Configurable fake provider. Records every call so "no retries / one call" can be asserted. */
class FakeLlmProvider implements LlmProvider {
  readonly name = 'openai';
  calls = 0;
  constructor(private readonly make: () => LlmResult) {}
  async generate(_req: LlmRequest): Promise<LlmResult> {
    this.calls += 1;
    return this.make();
  }
}

function okBody(refs: string[]) {
  return {
    overallScore: 72,
    scores: Object.fromEntries([
      'composition', 'hierarchy', 'typography', 'spacing', 'imagery', 'nicheFit', 'credibility',
      'copy', 'conversion', 'mobile', 'multilingual', 'accessibility', 'faqInteraction', 'materialImprovement',
    ].map((c) => [c, 72])),
    blockers: [],
    findings: [{ code: 'weak_hierarchy', detail: 'competes', screenshotRef: refs[0] }],
    screenshotRefs: refs,
    permittedRevisionOperations: ['TYPOGRAPHY_SCALE'],
    decision: 'REVISE',
  };
}

function llmResult(over: Partial<LlmResult> & Pick<LlmResult, 'status' | 'rawJson'>): LlmResult {
  return {
    refusal: null, incompleteReason: null, provider: 'openai', requestedModel: 'gpt-5.6-sol',
    resolvedModel: 'gpt-5.6-sol', requestId: 'req-1', responseId: 'resp-1',
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 400, reasoningTokens: 100, estimatedCostUsd: 0.02 },
    latencyMs: 10, imageDetail: 'high', ...over,
  };
}

const images = [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'AAAA', detail: 'high' as const }];
const liveDeps = {
  model: 'gpt-5.6-sol', reasoningEffort: 'high' as const, timeoutMs: 1000, maxOutputTokens: 4000,
  maxRetries: 0, store: false, imageDetail: 'high' as const,
};

describe('3B2B1 reviewer input + fingerprint', () => {
  it('assembles only the permitted evidence and is deterministic', () => {
    const a = prepared();
    const b = prepared();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.input.baselineScreenshots).toHaveLength(3);
    expect(a.input.finalScreenshots).toHaveLength(3);
    // No repository / source leakage: only the declared keys are present.
    expect(Object.keys(a.input).sort()).toEqual([
      'artifactId', 'auditFindings', 'baselineScreenshots', 'creativeBrief', 'deterministicValidation',
      'experiencePlan', 'finalScreenshots', 'hashes', 'inputVersion', 'primaryLanguage', 'provenance',
      'referenceFamily', 'rubric', 'supportedLanguages',
    ]);
  });

  it('fails closed when the screenshot-set hash does not match the screenshots', () => {
    const pkg = buildFixtureReviewPackage();
    const tampered = { ...pkg, hashes: { ...pkg.hashes, screenshotSet: 'f'.repeat(64) } };
    expect(() => buildVisualReviewInput({ reviewPackage: tampered as never, reviewPackageHash: 'a'.repeat(64), provenance }))
      .toThrow('demo_v2_visual_review_input_screenshot_set_mismatch');
  });

  it('changes the fingerprint when any bound hash changes (stale review)', () => {
    const base = prepared();
    const pkg2 = buildFixtureReviewPackage({ hashes: { ...buildFixtureReviewPackage().hashes, render: 'e'.repeat(64) } as never });
    const input2 = buildVisualReviewInput({ reviewPackage: pkg2, reviewPackageHash: fixtureReviewPackageHash(pkg2), provenance });
    expect(visualReviewInputFingerprint(input2)).not.toBe(base.fingerprint);
  });

  it('exposes a strict output json_schema with additionalProperties false', () => {
    expect(VISUAL_REVIEW_OUTPUT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect((VISUAL_REVIEW_OUTPUT_JSON_SCHEMA.properties as Record<string, unknown>).decision).toBeDefined();
  });
});

describe('3B2B1 mock reviewer defaults', () => {
  it('is the default provider, costs $0, and can never record an automatic pass', async () => {
    const p = prepared();
    const provider = new MockDemoV2VisualReviewProvider('strong-premium-dental');
    const result = await provider.review({
      screenshotRefs: visualReviewScreenshotRefs(p.input), referenceFamily: p.input.referenceFamily,
      renderHash: p.input.hashes.render, screenshotSetHash: p.input.hashes.screenshotSet,
      reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    });
    expect(result.provider).toBe('mock');
    expect(result.costUsd).toBe(0);
    expect(result.schemaVersion).toBe(DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION);
    assertReviewCannotAutoApprove(result);
    expect(visualReviewOutputHash(result)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('3B2B1 live reviewer (fake provider — no real network)', () => {
  it('maps a clean response into a structured verdict with cost + usage, making exactly one call', async () => {
    const p = prepared();
    const refs = visualReviewScreenshotRefs(p.input);
    const fake = new FakeLlmProvider(() => llmResult({ status: 'ok', rawJson: okBody(refs) }));
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    const result = await reviewer.review({
      screenshotRefs: refs, referenceFamily: p.input.referenceFamily, renderHash: p.input.hashes.render,
      screenshotSetHash: p.input.hashes.screenshotSet, reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    });
    expect(result.provider).toBe('openai');
    expect(result.decision).toBe('REVISE');
    expect(result.costUsd).toBeCloseTo(0.02);
    expect(result.usage.outputTokens).toBe(400);
    expect(fake.calls).toBe(1); // no retries
  });

  it.each([
    ['refusal', llmResult({ status: 'refusal', rawJson: null, refusal: 'no' })],
    ['incomplete/truncated', llmResult({ status: 'incomplete', rawJson: null, incompleteReason: 'max_output_tokens' })],
    ['schema_invalid', llmResult({ status: 'schema_invalid', rawJson: null })],
    ['rate_limited', llmResult({ status: 'rate_limited', rawJson: null })],
  ])('fails closed on a %s response and never retries', async (_name, res) => {
    const p = prepared();
    const fake = new FakeLlmProvider(() => res);
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    await expect(reviewer.review({
      screenshotRefs: visualReviewScreenshotRefs(p.input), referenceFamily: p.input.referenceFamily,
      renderHash: p.input.hashes.render, screenshotSetHash: p.input.hashes.screenshotSet,
      reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    })).rejects.toThrow(/demo_v2_visual_review_failed/);
    expect(fake.calls).toBe(1);
  });

  it('blocks unaccountable spend (null cost)', async () => {
    const p = prepared();
    const refs = visualReviewScreenshotRefs(p.input);
    const fake = new FakeLlmProvider(() => llmResult({
      status: 'ok', rawJson: okBody(refs),
      usage: { inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, estimatedCostUsd: null },
    }));
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    await expect(reviewer.review({
      screenshotRefs: refs, referenceFamily: p.input.referenceFamily, renderHash: p.input.hashes.render,
      screenshotSetHash: p.input.hashes.screenshotSet, reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    })).rejects.toThrow('demo_v2_visual_review_cost_unaccountable');
  });

  it('rejects a silent model substitution', async () => {
    const p = prepared();
    const refs = visualReviewScreenshotRefs(p.input);
    const fake = new FakeLlmProvider(() => llmResult({ status: 'ok', rawJson: okBody(refs), resolvedModel: 'gpt-4o-mini' }));
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    await expect(reviewer.review({
      screenshotRefs: refs, referenceFamily: p.input.referenceFamily, renderHash: p.input.hashes.render,
      screenshotSetHash: p.input.hashes.screenshotSet, reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    })).rejects.toThrow('demo_v2_visual_review_model_substituted');
  });

  it('rejects a verdict citing a screenshot outside the bound input', async () => {
    const p = prepared();
    const fake = new FakeLlmProvider(() => llmResult({ status: 'ok', rawJson: okBody(['invented-shot.png']) }));
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    await expect(reviewer.review({
      screenshotRefs: visualReviewScreenshotRefs(p.input), referenceFamily: p.input.referenceFamily,
      renderHash: p.input.hashes.render, screenshotSetHash: p.input.hashes.screenshotSet,
      reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    })).rejects.toThrow('demo_v2_visual_review_unknown_screenshot_ref');
  });

  it('rejects a request whose fingerprint or bound hashes do not match the input', async () => {
    const p = prepared();
    const fake = new FakeLlmProvider(() => llmResult({ status: 'ok', rawJson: okBody(visualReviewScreenshotRefs(p.input)) }));
    const reviewer = new OpenAiDemoV2VisualReviewProvider({ ...liveDeps, provider: fake }, p.input, images);
    await expect(reviewer.review({
      screenshotRefs: visualReviewScreenshotRefs(p.input), referenceFamily: p.input.referenceFamily,
      renderHash: p.input.hashes.render, screenshotSetHash: p.input.hashes.screenshotSet,
      reviewPackageHash: p.pkgHash, inputFingerprint: 'f'.repeat(64),
    })).rejects.toThrow('demo_v2_visual_review_input_fingerprint_mismatch');
    expect(fake.calls).toBe(0);
  });
});

describe('3B2B1 pre-call cost enforcement', () => {
  const dims = [{ width: 1440, height: 3200 }, { width: 390, height: 4200 }];

  it('projects a worst-case cost and allows a call within the $3 ceiling', () => {
    const p = prepared();
    const projection = projectVisualReviewCost({ model: 'gpt-5.6-sol', input: p.input, maxOutputTokens: 4000, imageDetail: 'high', screenshotDimensions: dims });
    expect(projection.projectedUsd).not.toBeNull();
    const decision = evaluateDemoV2Budget({ projection, priorSpendUsd: 0, ceilingUsd: 3 });
    expect(decision.allowed).toBe(true);
    expect(() => assertWithinDemoV2Budget(decision)).not.toThrow();
  });

  it('rejects when prior spend + projection would exceed $3', () => {
    const p = prepared();
    const projection = projectVisualReviewCost({ model: 'gpt-5.6-sol', input: p.input, maxOutputTokens: 4000, imageDetail: 'high', screenshotDimensions: dims });
    const decision = evaluateDemoV2Budget({ projection, priorSpendUsd: 2.999, ceilingUsd: 3 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('budget_ceiling_exceeded');
    expect(() => assertWithinDemoV2Budget(decision)).toThrow('demo_v2_visual_review_budget_blocked:budget_ceiling_exceeded');
  });

  it('blocks a call for a model with no verified price (unaccountable)', () => {
    const p = prepared();
    const projection = projectVisualReviewCost({ model: 'mystery-model', input: p.input, maxOutputTokens: 4000, imageDetail: 'high', screenshotDimensions: dims });
    expect(projection.projectedUsd).toBeNull();
    const decision = evaluateDemoV2Budget({ projection, priorSpendUsd: 0, ceilingUsd: 3 });
    expect(decision.reason).toBe('cost_unaccountable');
  });
});

describe('3B2B1 exact-fingerprint cache', () => {
  it('returns a cached verdict for a byte-identical input and misses on any change', async () => {
    const p = prepared();
    const cache = new VisualReviewCache();
    expect(cache.getForInput(p.input)).toBeNull();
    const provider = new MockDemoV2VisualReviewProvider('weak-hierarchy');
    const result = await provider.review({
      screenshotRefs: visualReviewScreenshotRefs(p.input), referenceFamily: p.input.referenceFamily,
      renderHash: p.input.hashes.render, screenshotSetHash: p.input.hashes.screenshotSet,
      reviewPackageHash: p.pkgHash, inputFingerprint: p.fingerprint,
    });
    cache.set(p.fingerprint, result);
    expect(cache.getForInput(p.input)).toBe(result);
    // A different render → different fingerprint → cache miss.
    const pkg2 = buildFixtureReviewPackage({ hashes: { ...buildFixtureReviewPackage().hashes, render: 'e'.repeat(64) } as never });
    const input2 = buildVisualReviewInput({ reviewPackage: pkg2, reviewPackageHash: fixtureReviewPackageHash(pkg2), provenance });
    expect(cache.getForInput(input2)).toBeNull();
  });
});

describe('3B2B1 side-effect safety', () => {
  it('keeps the visual-review contract free of any network/model client', () => {
    const src = readFileSync('src/domain/demo-v2/render/visual-review.ts', 'utf8');
    expect(src).not.toMatch(/from ['"]openai['"]|new OpenAI\(|integrations\/llm|apiKey/);
    expect(src).not.toMatch(/from ['"]node:(?:http|https|net|tls)['"]|globalThis\.fetch|axios|undici/);
  });

  it('has no deployment, Gmail, email, or scheduling path in the 3B2B1 modules', () => {
    const files = [
      'src/domain/demo-v2/render/visual-review-input.ts',
      'src/domain/demo-v2/render/visual-review-cost.ts',
      'src/domain/demo-v2/render/visual-review-loop.ts',
      'src/domain/demo-v2/render/revision-executor.ts',
      'src/integrations/llm/demo-v2-visual-reviewer.ts',
      'src/cli/commands/demo-v2-review.ts',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(files).not.toMatch(/integrations\/(?:netlify|gmail|send)|schedule-service|nodemailer|drafts\.(?:create|send)/i);
    // No code PATH may SET an automatic pass / human approval / deployment eligibility.
    expect(files).not.toMatch(/status:\s*'(?:AUTO_REVIEW_PASSED|HUMAN_APPROVED)'/);
    expect(files).not.toMatch(/advanceArtifact\([^)]*(?:AUTO_REVIEW_PASSED|HUMAN_APPROVED)/);
    expect(files).not.toMatch(/=\s*'(?:AUTO_REVIEW_PASSED|HUMAN_APPROVED)'/);
    expect(files).not.toMatch(/deploymentEligible:\s*true/);
  });
});
