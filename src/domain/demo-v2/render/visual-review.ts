import { z } from 'zod';
import { demoV2Hash, SHA256_PATTERN } from '../hash.js';

/**
 * Milestone 3A visual-review CONTRACT plus a mock provider. No live model is called here.
 *
 * The future configured reviewer is OpenAI `gpt-5.6-sol` at high reasoning effort; wiring it is a
 * later, separately approved step. `AUTO_REVIEW_PASSED` is never recorded from a real reviewer in
 * this milestone, and human approval remains unavailable.
 */

export const DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION = 'demo-v2-visual-review-1';

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

export const visualReviewResultSchema = z.object({
  schemaVersion: z.literal(DEMO_V2_VISUAL_REVIEW_SCHEMA_VERSION),
  provider: z.enum(['mock', 'openai']),
  requestedModel: z.string().min(1),
  reasoningEffort: z.string().min(1),
  overallScore: score,
  scores: z.object(Object.fromEntries(
    VISUAL_SCORE_CATEGORIES.map((category) => [category, score]),
  ) as Record<VisualScoreCategory, typeof score>),
  blockers: z.array(visualReviewFindingSchema),
  findings: z.array(visualReviewFindingSchema),
  screenshotRefs: z.array(z.string().min(1)).min(1),
  permittedRevisionOperations: z.array(z.enum(REVISION_OPERATIONS)),
  decision: z.enum(['APPROVE', 'REVISE', 'REJECT']),
  costUsd: z.literal(0),
}).superRefine((value, ctx) => {
  if (value.decision === 'APPROVE' && value.blockers.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'approve requires zero blockers' });
  }
  if (value.decision === 'REJECT' && value.blockers.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'reject requires at least one blocker' });
  }
  for (const finding of [...value.blockers, ...value.findings]) {
    if (!value.screenshotRefs.includes(finding.screenshotRef)) {
      ctx.addIssue({ code: 'custom', path: ['blockers'], message: `finding references unknown screenshot ${finding.screenshotRef}` });
    }
  }
});
export type VisualReviewResult = z.infer<typeof visualReviewResultSchema>;

export interface VisualReviewRequest {
  screenshotRefs: readonly string[];
  referenceFamily: string;
  renderHash: string;
  screenshotSetHash: string;
}

export interface DemoV2VisualReviewProvider {
  readonly name: 'mock';
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

const FIXTURES: Record<MockReviewFixture, (ref: string) => Omit<VisualReviewResult, 'schemaVersion' | 'provider' | 'requestedModel' | 'reasoningEffort' | 'screenshotRefs' | 'costUsd'>> = {
  'strong-premium-dental': () => ({
    overallScore: 88, scores: { ...uniform(88), materialImprovement: 90, nicheFit: 91 },
    blockers: [], findings: [], permittedRevisionOperations: ['SPACING_DENSITY', 'CTA_PROMINENCE'], decision: 'APPROVE',
  }),
  'generic-saas': (ref) => ({
    overallScore: 41, scores: { ...uniform(45), nicheFit: 22, credibility: 34, composition: 38 },
    blockers: [{ code: 'generic_saas_composition', detail: 'Reads as a generic startup landing page rather than a dental clinic.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: ['COMPONENT_VARIANT', 'SECTION_ORDER'], decision: 'REJECT',
  }),
  'weak-hierarchy': (ref) => ({
    overallScore: 58, scores: { ...uniform(62), hierarchy: 34, typography: 48 },
    blockers: [], findings: [{ code: 'weak_hierarchy', detail: 'Headline and primary action compete for attention.', screenshotRef: ref }],
    permittedRevisionOperations: ['TYPOGRAPHY_SCALE', 'SPACING_DENSITY', 'CTA_PROMINENCE'], decision: 'REVISE',
  }),
  'mobile-broken': (ref) => ({
    overallScore: 37, scores: { ...uniform(55), mobile: 12, conversion: 30 },
    blockers: [{ code: 'mobile_broken', detail: 'Primary appointment action is unreachable on mobile.', screenshotRef: ref }],
    findings: [], permittedRevisionOperations: ['MOBILE_STACKING', 'CTA_PROMINENCE'], decision: 'REJECT',
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
      reasoningEffort: 'high',
      screenshotRefs: [...request.screenshotRefs],
      costUsd: 0,
      ...FIXTURES[this.fixture](ref),
    });
  }
}

export function visualReviewSetHash(results: readonly VisualReviewResult[]): string {
  return demoV2Hash(results.map((result) => ({
    decision: result.decision, overall: result.overallScore, scores: result.scores,
    blockers: result.blockers.map((blocker) => blocker.code).sort(),
  })));
}

/**
 * Milestone 3A never records an automatic pass from a real reviewer. A mock verdict is advisory
 * only and can never authorise approval or deployment.
 */
export function assertNoAutomaticApproval(result: VisualReviewResult, providerName: string): void {
  if (providerName !== 'mock') throw new Error('demo_v2_live_visual_reviewer_not_permitted_in_milestone_3a');
  if (result.provider !== 'mock' || result.costUsd !== 0) {
    throw new Error('demo_v2_visual_review_must_be_mock_only');
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
  /** Milestone 3A stores intent only; no live revision loop executes it. */
  applied: z.literal(false),
});
export type DemoV2RevisionPlan = z.infer<typeof revisionPlanSchema>;
