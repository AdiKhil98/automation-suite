import { describe, expect, it } from 'vitest';
import {
  deriveSectionAnchors, executeRevision, emptyOverlay, type RevisionConstraints,
} from '../../src/domain/demo-v2/render/revision-executor.js';
import { REVISION_OPERATIONS, type RevisionOperation } from '../../src/domain/demo-v2/render/visual-review.js';
import { ReviewLoopController } from '../../src/domain/demo-v2/render/visual-review-loop.js';
import { fixtureExperiencePlan } from '../fixtures/demo-v2/visual-review-fixture.js';

const RENDER_HASH = 'a'.repeat(64);

function constraints(): RevisionConstraints {
  const plan = fixtureExperiencePlan();
  const anchors = deriveSectionAnchors(plan);
  return {
    boundRenderHash: RENDER_HASH,
    anchors,
    allowedVariants: { hero: ['editorial', 'poster'], services: ['list', 'grid'], story: ['narrative'], 'appointment-actions': ['persistent'], faq: ['accordion'] },
    approvedCopyAlternatives: { hero: ['hero-alt-1', 'hero-alt-2'] },
  };
}

function op(operation: RevisionOperation, parameters: Record<string, string | number | boolean>, anchor = 'hero') {
  return { operation, targetSectionAnchor: anchor, parameters, justification: 'fictional', boundRenderHash: RENDER_HASH };
}

/** One representative, in-bounds instance of every allowed operation. */
const ALLOWED_CASES: Array<[RevisionOperation, ReturnType<typeof op>]> = [
  ['SECTION_ORDER', op('SECTION_ORDER', { position: 3 })],
  ['COMPONENT_VARIANT', op('COMPONENT_VARIANT', { variant: 'poster' })],
  ['SPACING_DENSITY', op('SPACING_DENSITY', { density: 'SPACIOUS' })],
  ['TYPOGRAPHY_SCALE', op('TYPOGRAPHY_SCALE', { scale: 1.1 })],
  ['ASSET_CROP', op('ASSET_CROP', { aspectRatio: 1.6 })],
  ['FOCAL_POINT', op('FOCAL_POINT', { x: 0.4, y: 0.6 })],
  ['OVERLAY_STRENGTH', op('OVERLAY_STRENGTH', { strength: 0.35 })],
  ['CTA_PROMINENCE', op('CTA_PROMINENCE', { prominence: 'PROMINENT' })],
  ['LINE_LENGTH', op('LINE_LENGTH', { ch: 66 })],
  ['APPROVED_COPY_ALTERNATIVE', op('APPROVED_COPY_ALTERNATIVE', { alternativeId: 'hero-alt-1' })],
  ['GALLERY_COMPOSITION', op('GALLERY_COMPOSITION', { composition: 'MASONRY' }, 'services')],
  ['MOBILE_STACKING', op('MOBILE_STACKING', { stacking: 'PRIORITY' })],
];

describe('controlled revision executor — allowed operations', () => {
  it('covers every allowed operation in the vocabulary', () => {
    expect(ALLOWED_CASES.map(([name]) => name).sort()).toEqual([...REVISION_OPERATIONS].sort());
  });

  it.each(ALLOWED_CASES)('applies %s within bounds and re-validates the plan', (_name, operation) => {
    const plan = fixtureExperiencePlan();
    const result = executeRevision({
      plan, operations: [operation], constraints: constraints(), permittedOperations: [operation.operation],
    });
    expect(result.appliedOperations).toBe(1);
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.overlayHash).toMatch(/^[a-f0-9]{64}$/);
    // Evidence bindings (content/asset source ids) are untouched by any presentation op.
    const before = fixtureExperiencePlan().sections.flatMap((s) => [...s.selectedClaimSourceIds, ...s.proposedAssetSelectionIds]).sort();
    const after = result.plan.sections.flatMap((s) => [...s.selectedClaimSourceIds, ...s.proposedAssetSelectionIds]).sort();
    expect(after).toEqual(before);
  });
});

describe('controlled revision executor — forbidden operations', () => {
  const FORBIDDEN: Array<[string, ReturnType<typeof op>, RegExp]> = [
    ['markup in a copy parameter', op('APPROVED_COPY_ALTERNATIVE', { alternativeId: '<b>x</b>' }), /forbidden_parameter_content|rejected/],
    ['a URL in a parameter', op('SPACING_DENSITY', { density: 'https://evil.example' }), /forbidden_parameter_content|value_out_of_bounds/],
    ['a contact channel (@)', op('APPROVED_COPY_ALTERNATIVE', { alternativeId: 'ops@clinic' }), /forbidden_parameter_content/],
    ['an unsupported component variant', op('COMPONENT_VARIANT', { variant: 'saas-hero-blast' }), /unsupported_component_variant/],
    ['an unapproved copy alternative (new fact/copy)', op('APPROVED_COPY_ALTERNATIVE', { alternativeId: 'invented-copy' }), /unapproved_copy_alternative/],
    ['an unknown section anchor', op('SPACING_DENSITY', { density: 'COMPACT' }, 'ghost-section'), /unknown_section_anchor/],
    ['a typography scale out of token bounds', op('TYPOGRAPHY_SCALE', { scale: 3 }), /value_out_of_bounds/],
    ['an overlay strength out of bounds', op('OVERLAY_STRENGTH', { strength: 5 }), /value_out_of_bounds/],
    ['a line length out of bounds', op('LINE_LENGTH', { ch: 500 }), /value_out_of_bounds/],
  ];

  it.each(FORBIDDEN)('rejects %s', (_name, operation, pattern) => {
    expect(() => executeRevision({
      plan: fixtureExperiencePlan(), operations: [operation], constraints: constraints(),
      permittedOperations: [operation.operation],
    })).toThrow(pattern);
  });

  it('rejects an operation the reviewer did not permit this cycle', () => {
    expect(() => executeRevision({
      plan: fixtureExperiencePlan(), operations: [op('SPACING_DENSITY', { density: 'COMPACT' })],
      constraints: constraints(), permittedOperations: ['TYPOGRAPHY_SCALE'],
    })).toThrow('operation_not_permitted_this_cycle:SPACING_DENSITY');
  });

  it('rejects an operation bound to a stale render hash', () => {
    const stale = { ...op('SPACING_DENSITY', { density: 'COMPACT' }), boundRenderHash: 'b'.repeat(64) };
    expect(() => executeRevision({
      plan: fixtureExperiencePlan(), operations: [stale], constraints: constraints(), permittedOperations: ['SPACING_DENSITY'],
    })).toThrow('stale_render_binding');
  });

  it('rejects an empty operation batch', () => {
    expect(() => executeRevision({
      plan: fixtureExperiencePlan(), operations: [], constraints: constraints(), permittedOperations: [],
    })).toThrow('no_operations');
  });
});

describe('revision loop cycle caps', () => {
  it('permits at most three review calls and two revisions', () => {
    const c = new ReviewLoopController({ maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 0, ceilingUsd: 3 });
    const revise = { decision: 'REVISE' as const, costUsd: 0.5 } as never;
    c.recordReview(revise); c.recordRevision();
    c.recordReview(revise); c.recordRevision();
    c.recordReview(revise);
    expect(c.reviewCallCount).toBe(3);
    expect(c.revisionCount).toBe(2);
    expect(c.canReview()).toBe(false);
    expect(c.canRevise()).toBe(false);
    expect(() => c.recordReview(revise)).toThrow('demo_v2_review_loop_max_review_calls_reached');
  });

  it('accumulates spend and fails closed at the ceiling', () => {
    const c = new ReviewLoopController({ maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 2.6, ceilingUsd: 3 });
    expect(() => c.recordReview({ decision: 'REVISE', costUsd: 0.5 } as never)).toThrow('demo_v2_review_loop_budget_exceeded');
  });

  it('resolves to a human review, never an automatic pass, on approval', () => {
    const c = new ReviewLoopController({ maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 0, ceilingUsd: 3 });
    c.recordReview({ decision: 'APPROVE', costUsd: 0 } as never);
    expect(c.resolveStatus()).toBe('HUMAN_REVIEW_REQUIRED');
  });

  it('resolves to rejected on a REJECT verdict', () => {
    const c = new ReviewLoopController({ maxReviewCalls: 3, maxRevisions: 2, priorSpendUsd: 0, ceilingUsd: 3 });
    c.recordReview({ decision: 'REJECT', costUsd: 0 } as never);
    expect(c.resolveStatus()).toBe('REJECTED');
  });
});

describe('revision executor determinism', () => {
  it('produces a stable plan hash for the same operations', () => {
    const one = executeRevision({ plan: fixtureExperiencePlan(), overlay: emptyOverlay(), operations: [op('SPACING_DENSITY', { density: 'COMPACT' })], constraints: constraints(), permittedOperations: ['SPACING_DENSITY'] });
    const two = executeRevision({ plan: fixtureExperiencePlan(), overlay: emptyOverlay(), operations: [op('SPACING_DENSITY', { density: 'COMPACT' })], constraints: constraints(), permittedOperations: ['SPACING_DENSITY'] });
    expect(one.overlayHash).toBe(two.overlayHash);
  });
});
