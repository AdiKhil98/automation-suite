import { z } from 'zod';
import { demoV2Hash, SHA256_PATTERN } from '../hash.js';

/**
 * Milestone 3B2B1 visual-review CONTRACT plus a mock provider. This file is PURE: it never imports
 * a model client, never opens a socket, and never spends money. The live OpenAI reviewer that
 * satisfies this contract lives in a separate adapter module behind the paid-call + V2 capability
 * guards enforced by its caller.
 *
 * The configured live reviewer is OpenAI `gpt-5.6-sol` at high reasoning effort with NO fallback
 * model and NO automatic retries. A reviewer verdict is APPROVE | REVISE | REJECT only — the
 * vocabulary deliberately cannot express `AUTO_REVIEW_PASSED`, `HUMAN_APPROVED`, or deployment
 * eligibility, and this milestone never records an automatic pass.
 */

export const DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION = 'demo-v2-visual-review-2';

export const VISUAL_SCORE_CATEGORIES = [
  'composition', 'hierarchy', 'typography', 'spacing', 'imagery', 'nicheFit', 'credibility',
  'copy', 'conversion', 'mobile', 'multilingual', 'accessibility', 'faqInteraction',
  'materialImprovement',
] as const;
export type VisualScoreCategory = (typeof VISUAL_SCORE_CATEGORIES)[number];

const score = z.number().int().min(0).max(100);

export const visualReviewFindingSchema = z.object({
  code: z.string().min(1),
  detail: z.string().min(1),
  /** Must reference a screenshot that exists in the reviewed set. */
  screenshotRef: z.string().min(1),
});

export const REVISION_OPERATIONS = [
  'SECTION_ORDER', 'COMPONENT_VARIANT', 'SPACING_DENSITY', 'TYPOGRAPHY_SCALE',
  'ASSET_CROP', 'FOCAL_POINT', 'OVERLAY_STRENGTH', 'CTA_PROMINENCE',
  'LINE_LENGTH', 'APPROVED_COPY_ALTERNATIVE', 'GALLERY_COMPOSITION', 'MOBILE_STACKING',
] as const;
export type RevisionOperation = (typeof REVISION_OPERATIONS)[number];

/** Reviewer token usage. Mock reports zeros; a live reviewer reports what the provider returned
 * (a null field means the provider did not account for it and must block further paid calls). */
export const visualReviewUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
export type VisualReviewUsage = z.infer<typeof visualReviewUsageSchema>;

export const visualReviewResultSchema = z.object({
  schemaVersion: z.literal(DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION),
  provider: z.enum(['mock', 'openai']),
  requestedModel: z.string().min(1),
  resolvedModel: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1),
  responseId: z.string().min(1).nullable(),
  overallScore: score,
  scores: z.object(Object.fromEntries(
    VISUAL_SCORE_CATEGORIES.map((category) => [category, score]),
  ) as Record<VisualScoreCategory, typeof score>),
  blockers: z.array(visualReviewFindingSchema),
  findings: z.array(visualReviewFindingSchema),
  screenshotRefs: z.array(z.string().min(1)).min(1),
  permittedRevisionOperations: z.array(z.enum(REVISION_OPERATIONS)),
  decision: z.enum(['APPROVE', 'REVISE', 'REJECT']),
  usage: visualReviewUsageSchema,
  costUsd: z.number().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.provider === 'mock' && value.costUsd !== 0) {
    ctx.addIssue({ code: 'custom', path: ['costUsd'], message: 'mock reviewer must report zero cost' });
  }
  if (value.decision === 'APPROVE' && value.blockers.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'approve requires zero blockers' });
  }
  if (value.decision === 'REJECT' && value.blockers.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'reject requires at least one blocker' });
  }
  // A REVISE decision may only propose revision operations that are permitted; APPROVE/REJECT
  // decisions never carry a revision instruction.
  if (value.decision !== 'REVISE' && value.permittedRevisionOperations.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['permittedRevisionOperations'], message: 'only a REVISE decision may permit revision operations' });
  }
  for (const finding of [...value.blockers, ...value.findings]) {
    if (!value.screenshotRefs.includes(finding.screenshotRef)) {
      ctx.addIssue({ code: 'custom', path: ['blockers'], message: `finding references unknown screenshot ${finding.screenshotRef}` });
    }
  }
});
export type VisualReviewResult = z.infer<typeof visualReviewResultSchema>;

/** The bindings a reviewer verdict is pinned to. If any of these change, the verdict is stale. */
export interface VisualReviewRequest {
  screenshotRefs: readonly string[];
  referenceFamily: string;
  renderHash: string;
  screenshotSetHash: string;
  reviewPackageHash: string;
  /** Deterministic fingerprint of the exact reviewer input (see visual-review-input.ts). */
  inputFingerprint: string;
}

export interface DemoV2VisualReviewProvider {
  readonly name: 'mock' | 'openai';
  review(request: VisualReviewRequest): Promise<VisualReviewResult>;
}

export const MOCK_REVIEW_FIXTURES = [
  'strong-premium-dental', 'generic-saas', 'weak-hierarchy', 'mobile-broken',
  'mixed-language', 'poor-imagery', 'excessive-cards', 'inaccessible-faq-concierge',
] as const;
export type MockReviewFixture = (typeof MOCK_REVIEW_FIXTURES)[number];

function uniform(value: number): Record<VisualScoreCategory, number> {
  return Object.fromEntries(VISUAL_SCORE_CATEGORIES.map((category) => [category, value])) as Record<VisualScoreCategory, number>;
}

type FixtureBody = Omit<VisualReviewResult,
  'schemaVersion' | 'provider' | 'requestedModel' | 'resolvedModel' | 'reasoningEffort' |
  'responseId' | 'screenshotRefs' | 'usage' | 'costUsd'>;

const FIXTURES: Record<MockReviewFixture, (ref: string) => FixtureBody> = {
  'strong-premium-dental': () => ({
    overallScore: 88, scores: { ...uniform(88), materialImprovement: 90, nicheFit: 91 },
    blockers: [], findings: [], permittedRevisionOperations: [], decision: 'APPROVE',
  }),
  'generic-saas': (ref) => ({
    overallScore: 41, scores: { ...uniform(45), nicheFit: 22, credibility: 34, composition: 38 },
    blockers: [{ code: 'generic_saas_composition', detail: 'Reads as a generic startup landing page rather than a dental clinic.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: [], decision: 'REJECT',
  }),
  'weak-hierarchy': (ref) => ({
    overallScore: 58, scores: { ...uniform(62), hierarchy: 34, typography: 48 },
    blockers: [], findings: [{ code: 'weak_hierarchy', detail: 'Headline and primary action compete for attention.', screenshotRef: ref }],
    permittedRevisionOperations: ['TYPOGRAPHY_SCALE', 'SPACING_DENSITY', 'CTA_PROMINENCE'], decision: 'REVISE',
  }),
  'mobile-broken': (ref) => ({
    overallScore: 37, scores: { ...uniform(55), mobile: 12, conversion: 30 },
    blockers: [{ code: 'mobile_broken', detail: 'Primary appointment action is unreachable on mobile.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: [], decision: 'REJECT',
  }),
  'mixed-language': (ref) => ({
    overallScore: 33, scores: { ...uniform(52), multilingual: 8 },
    blockers: [{ code: 'mixed_language', detail: 'German and English appear on the same page.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: [], decision: 'REJECT',
  }),
  'poor-imagery': (ref) => ({
    overallScore: 54, scores: { ...uniform(60), imagery: 26 },
    blockers: [], findings: [{ code: 'poor_imagery', detail: 'Hero crop cuts the focal subject.', screenshotRef: ref }],
    permittedRevisionOperations: ['ASSET_CROP', 'FOCAL_POINT', 'OVERLAY_STRENGTH'], decision: 'REVISE',
  }),
  'excessive-cards': (ref) => ({
    overallScore: 49, scores: { ...uniform(56), composition: 30, nicheFit: 38 },
    blockers: [], findings: [{ code: 'excessive_card_repetition', detail: 'Repeated card grid dominates the page.', screenshotRef: ref }],
    permittedRevisionOperations: ['COMPONENT_VARIANT', 'GALLERY_COMPOSITION'], decision: 'REVISE',
  }),
  'inaccessible-faq-concierge': (ref) => ({
    overallScore: 44, scores: { ...uniform(58), accessibility: 18, faqInteraction: 20 },
    blockers: [{ code: 'inaccessible_faq', detail: 'Concierge cannot be closed with the keyboard.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: [], decision: 'REJECT',
  }),
};

/** Zero-network reviewer. Records $0 and can never produce a real model verdict. */
export class MockDemoV2VisualReviewProvider implements DemoV2VisualReviewProvider {
  readonly name = 'mock' as const;
  constructor(private readonly fixture: MockReviewFixture = 'strong-premium-dental') {}

  async review(request: VisualReviewRequest): Promise<VisualReviewResult> {
    const ref = request.screenshotRefs[0];
    if (!ref) throw new Error('demo_v2_visual_review_requires_screenshots');
    return visualReviewResultSchema.parse({
      schemaVersion: DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION,
      provider: 'mock',
      requestedModel: 'mock-visual-reviewer',
      resolvedModel: 'mock-visual-reviewer',
      reasoningEffort: 'high',
      responseId: `mock-review-${request.inputFingerprint.slice(0, 12)}`,
      screenshotRefs: [...request.screenshotRefs],
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      costUsd: 0,
      ...FIXTURES[this.fixture](ref),
    });
  }
}

/** Deterministic content hash of a review OUTPUT — the immutable evidence of the verdict. */
export function visualReviewOutputHash(result: VisualReviewResult): string {
  return demoV2Hash({
    schemaVersion: result.schemaVersion, provider: result.provider,
    requestedModel: result.requestedModel, resolvedModel: result.resolvedModel,
    reasoningEffort: result.reasoningEffort, decision: result.decision,
    overallScore: result.overallScore, scores: result.scores,
    blockers: [...result.blockers].map((b) => ({ code: b.code, ref: b.screenshotRef })).sort((a, b) => a.code.localeCompare(b.code)),
    findings: [...result.findings].map((f) => ({ code: f.code, ref: f.screenshotRef })).sort((a, b) => a.code.localeCompare(b.code)),
    permittedRevisionOperations: [...result.permittedRevisionOperations].sort(),
    screenshotRefs: [...result.screenshotRefs].sort(),
  });
}

export function visualReviewSetHash(results: readonly VisualReviewResult[]): string {
  return demoV2Hash(results.map((result) => ({
    decision: result.decision, overall: result.overallScore, scores: result.scores,
    blockers: result.blockers.map((blocker) => blocker.code).sort(),
  })));
}

/**
 * A reviewer verdict — mock OR live — can never authorise an automatic pass, human approval, or
 * deployment. This asserts the verdict vocabulary is intact and refuses any attempt to smuggle a
 * lifecycle-approval decision through the reviewer. It is decision-based, NOT provider-based: the
 * live reviewer is permitted in this milestone, but its output still cannot approve anything.
 */
export function assertReviewCannotAutoApprove(result: Pick<VisualReviewResult, 'decision'>): void {
  const permitted = ['APPROVE', 'REVISE', 'REJECT'];
  if (!permitted.includes(result.decision)) {
    throw new Error('demo_v2_visual_review_illegal_decision');
  }
  // A reviewer "APPROVE" is advisory only; it maps to HUMAN_REVIEW_REQUIRED, never AUTO_REVIEW_PASSED.
  const forbidden = ['AUTO_REVIEW_PASSED', 'HUMAN_APPROVED'] as const;
  if ((forbidden as readonly string[]).includes(result.decision)) {
    throw new Error('demo_v2_visual_review_cannot_record_automatic_pass');
  }
}

// ------------------------------------------------------- controlled revisions

export const revisionOperationSchema = z.object({
  operation: z.enum(REVISION_OPERATIONS),
  targetSectionAnchor: z.string().min(1),
  /** Bounded parameters only; never free-form markup or copy. */
  parameters: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])),
  justification: z.string().min(1),
  boundRenderHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  const forbidden = /<[^>]+>|https?:\/\/|@|\bfunction\b|\{|\}/;
  for (const [key, parameter] of Object.entries(value.parameters)) {
    if (typeof parameter === 'string' && forbidden.test(parameter)) {
      ctx.addIssue({ code: 'custom', path: ['parameters', key], message: 'markup, script, URLs, and contact details are prohibited in a revision parameter' });
    }
  }
});
export type DemoV2RevisionOperation = z.infer<typeof revisionOperationSchema>;

export const revisionPlanSchema = z.object({
  schemaVersion: z.literal('demo-v2-revision-1'),
  boundRenderHash: z.string().regex(SHA256_PATTERN),
  operations: z.array(revisionOperationSchema).max(12),
  applied: z.boolean(),
});
export type DemoV2RevisionPlan = z.infer<typeof revisionPlanSchema>;
