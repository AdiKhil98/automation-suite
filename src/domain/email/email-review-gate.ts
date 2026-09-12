import { type EmailReviewParsed } from './email-schema.js';
import { type SequenceStep } from '../outreach/sequence.js';

/**
 * The single source of truth for whether an independent adversarial email review APPROVES a draft.
 *
 * Revisions are never silently approved without being applied: the decision must be APPROVE,
 * fabricationRisk must be false, and every boolean quality dimension that applies to this email
 * must pass. The writer service, resume-review recovery, and the compose-preview reviewer all use
 * this exact conjunction so the gate can never drift between the three paths.
 *
 * Two dimensions are step-dependent:
 *
 *  - SEQUENCE JOB. Each step has a different job, so a different subset of the four sequence-job
 *    booleans is enforced (step 0 = Outreach #1, step 1 = lesson Follow-up #2, step 2 = #3,
 *    step 3 = #4). The reviewer reports all four every time; the non-applicable ones are reported
 *    as true and are simply not part of the conjunction for that step.
 *  - SUBJECT. A follow-up continues the EXISTING Gmail thread, so its subject is deterministic
 *    thread continuity ("Re: <original>") produced by code, not authored copy. Judging it for a
 *    curiosity gap would reject every correctly-threaded follow-up, so the two subject dimensions
 *    are enforced only where the model actually authors the subject. They stay fail-closed for the
 *    initial email and for any follow-up that is NOT threaded.
 */
export function isEmailReviewApprovable(
  review: EmailReviewParsed,
  opts: { sequenceStep?: SequenceStep; subjectIsThreadContinuity?: boolean } = {},
): boolean {
  const step = opts.sequenceStep ?? 0;
  const subjectAuthored = !(opts.subjectIsThreadContinuity ?? false);
  return review.decision === 'APPROVE'
    && !review.fabricationRisk
    && (!subjectAuthored || (review.subjectSpecific && review.subjectCuriosityGap))
    && review.openingSpecific
    && review.businessRelevanceClear
    && review.urgencySupported
    && review.competitorClaimsSupported
    && review.humanStylePass
    && review.punctuationPass
    && review.singlePrimaryCta
    && review.sufficientlyPersonalized
    && review.evidenceSupported
    && review.demoAligned
    && review.persuasive
    && review.singleObservation
    && review.buyerLanguageOnly
    && review.conversationNotAudit
    && review.confidentObservation
    && sequenceJobSatisfied(review, step);
}

/**
 * The sequence-job conjunction for one step. Fail-closed: a message that violates the required job
 * for its position in the sequence is never approvable, regardless of how good the copy reads.
 *
 *  - step 0 (Outreach #1): no sequence-job boolean applies; the generic quality gate governs.
 *  - step 1 (Follow-up #2): must ADD CLARITY — not restart the pitch, not expand, not pressure.
 *  - step 2 (Follow-up #3): must COMPRESS and REDUCE PRESSURE, without restarting the pitch.
 *  - step 3 (Follow-up #4): must be a BINARY, low-friction close with no scheduling pressure and
 *    no further persuasion.
 */
export function sequenceJobSatisfied(review: EmailReviewParsed, step: SequenceStep): boolean {
  switch (step) {
    case 0:
      return true;
    case 1:
      return review.addsClarityNotRestart && review.compressedNotExpanded && review.pressureReduced;
    case 2:
      return review.compressedNotExpanded && review.pressureReduced && review.addsClarityNotRestart;
    case 3:
      return review.binaryReplyClose && review.pressureReduced && review.compressedNotExpanded
        && review.addsClarityNotRestart;
  }
}
