import { type VisualReviewResult } from './visual-review.js';

/**
 * Enforces the hard cycle limits of one Demo V2 review loop:
 *
 *   initial render → review #1 → (revision 1) → review #2 → (revision 2) → review #3
 *
 * At most THREE review calls total and at most TWO revisions. The controller also accumulates the
 * actual reviewer spend so the caller can prove the per-demo budget held across the whole loop.
 * It records no lifecycle approval and can never yield `AUTO_REVIEW_PASSED`.
 */

export interface ReviewLoopLimits {
  maxReviewCalls: number;
  maxRevisions: number;
  priorSpendUsd: number;
  ceilingUsd: number;
}

export type ReviewLoopStatus =
  | 'AUTO_REVIEW_PENDING'
  | 'REVISION_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'BLOCKED'
  | 'REJECTED';

export class ReviewLoopController {
  private reviewCalls = 0;
  private revisions = 0;
  private spendUsd: number;
  private lastDecision: VisualReviewResult['decision'] | null = null;

  constructor(private readonly limits: ReviewLoopLimits) {
    if (limits.maxReviewCalls < 1 || limits.maxReviewCalls > 3) throw new Error('demo_v2_review_loop_invalid_max_review_calls');
    if (limits.maxRevisions < 0 || limits.maxRevisions > 2) throw new Error('demo_v2_review_loop_invalid_max_revisions');
    this.spendUsd = limits.priorSpendUsd;
  }

  get reviewCallCount(): number { return this.reviewCalls; }
  get revisionCount(): number { return this.revisions; }
  get totalSpendUsd(): number { return Math.round(this.spendUsd * 1_000_000) / 1_000_000; }

  /** May another review call be made? */
  canReview(): boolean {
    return this.reviewCalls < this.limits.maxReviewCalls;
  }

  assertCanReview(): void {
    if (!this.canReview()) throw new Error('demo_v2_review_loop_max_review_calls_reached');
  }

  /** Record a completed review call and its actual cost; fails closed if the ceiling is breached. */
  recordReview(result: VisualReviewResult): void {
    this.assertCanReview();
    this.reviewCalls += 1;
    this.spendUsd += result.costUsd;
    this.lastDecision = result.decision;
    if (this.totalSpendUsd > this.limits.ceilingUsd) {
      throw new Error('demo_v2_review_loop_budget_exceeded');
    }
  }

  /** May another revision be applied? Only after a REVISE verdict, within the revision cap, and with a review call left to judge the result. */
  canRevise(): boolean {
    return this.lastDecision === 'REVISE'
      && this.revisions < this.limits.maxRevisions
      && this.reviewCalls < this.limits.maxReviewCalls;
  }

  assertCanRevise(): void {
    if (this.lastDecision !== 'REVISE') throw new Error('demo_v2_review_loop_revision_requires_revise_decision');
    if (this.revisions >= this.limits.maxRevisions) throw new Error('demo_v2_review_loop_max_revisions_reached');
    if (this.reviewCalls >= this.limits.maxReviewCalls) throw new Error('demo_v2_review_loop_max_review_calls_reached');
  }

  recordRevision(): void {
    this.assertCanRevise();
    this.revisions += 1;
  }

  /** Terminal lifecycle status this loop resolves to — never an automatic pass. */
  resolveStatus(): ReviewLoopStatus {
    if (this.lastDecision === null) return 'AUTO_REVIEW_PENDING';
    if (this.lastDecision === 'REJECT') return 'REJECTED';
    if (this.lastDecision === 'APPROVE') return 'HUMAN_REVIEW_REQUIRED';
    // Still REVISE at the end of the loop: revisions are exhausted, hand to a human.
    return this.canRevise() ? 'REVISION_REQUIRED' : 'HUMAN_REVIEW_REQUIRED';
  }
}
