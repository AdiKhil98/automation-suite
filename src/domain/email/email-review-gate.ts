import { type EmailReviewParsed } from './email-schema.js';
import { type SequenceStep } from '../outreach/sequence.js';

/**
 * THE APPROVAL GATE — which reviewer dimensions must hold, for which step.
 *
 * Every email in the sequence has a different job, so a single universal conjunction was wrong in
 * both directions: it let a Follow-up #2 that restated Outreach #1 through (the sequence booleans
 * were the only step-aware part), and it would reject a CORRECT Follow-up #4 for lacking things its
 * own instructions forbid it from having — an observation, a business-relevance sentence, a
 * persuasive argument.
 *
 * Dimensions are therefore classified once, explicitly, here:
 *
 *   UNIVERSAL — safety, honesty and style. True at every position, fail-closed, never relaxed:
 *     decision=APPROVE, no fabrication risk, evidence supports every claim, urgency is supported,
 *     competitor claims are supported, human style, punctuation, exactly one primary CTA, buyer
 *     language, conversation not audit, demo alignment, and a non-generic opening.
 *
 *   STEP-DEPENDENT — copy-JOB quality. Required only where that job applies:
 *     businessRelevanceClear / persuasive        step 0 only (the first email must make the case)
 *     sufficientlyPersonalized                   steps 0-1 (a compression and a close are brief by
 *                                                design; the thread carries the personalisation)
 *     singleObservation / confidentObservation   steps 0-2 (step 3 carries NO observation, so there
 *                                                is nothing for either dimension to judge)
 *     subjectSpecific / subjectCuriosityGap      only where the model authors the subject
 *     sequence-job booleans                      exactly the subset that applies to the step
 *
 * A dimension that does not apply is NOT evidence of quality — it simply has nothing to judge, and
 * the reviewer is told so in its own rubric. Keeping the list here, as data, is what stops that
 * knowledge from scattering into exceptions.
 */

/** The copy-job dimensions, and the steps at which each is required. */
const STEP_DEPENDENT_DIMENSIONS: ReadonlyArray<{
  readonly name: keyof EmailReviewParsed;
  readonly requiredAt: readonly SequenceStep[];
  readonly why: string;
}> = [
  { name: 'businessRelevanceClear', requiredAt: [0], why: 'only the first email must state why the issue matters; a follow-up that restates it is repeating itself' },
  { name: 'persuasive', requiredAt: [0], why: 'the first email makes the case; clarifying, compressing and closing are not persuasion' },
  { name: 'sufficientlyPersonalized', requiredAt: [0, 1], why: 'a compression and a close are deliberately brief; the thread already carries the personalisation' },
  { name: 'singleObservation', requiredAt: [0, 1, 2], why: 'step 3 carries no observation at all, so the ceiling has nothing to measure' },
  { name: 'confidentObservation', requiredAt: [0, 1, 2], why: 'there is no observation to hedge in a binary close' },
];

/** Whether a step-dependent dimension applies at this step. Exported for tests and diagnostics. */
export function reviewDimensionApplies(name: keyof EmailReviewParsed, step: SequenceStep): boolean {
  const entry = STEP_DEPENDENT_DIMENSIONS.find((d) => d.name === name);
  return entry ? entry.requiredAt.includes(step) : true;
}

/** The full applicability matrix, for tests, documentation and operator tooling. */
export function reviewApplicabilityMatrix(step: SequenceStep): Record<string, boolean> {
  return Object.fromEntries(STEP_DEPENDENT_DIMENSIONS.map((d) => [d.name, d.requiredAt.includes(step)]));
}

export function isEmailReviewApprovable(
  review: EmailReviewParsed,
  opts: { sequenceStep?: SequenceStep; subjectIsThreadContinuity?: boolean } = {},
): boolean {
  const step = opts.sequenceStep ?? 0;
  const subjectAuthored = !(opts.subjectIsThreadContinuity ?? false);

  // UNIVERSAL: safety, honesty and style. Never relaxed for any step.
  const universal = review.decision === 'APPROVE'
    && !review.fabricationRisk
    && review.openingSpecific
    && review.urgencySupported
    && review.competitorClaimsSupported
    && review.humanStylePass
    && review.punctuationPass
    && review.singlePrimaryCta
    && review.evidenceSupported
    && review.demoAligned
    && review.buyerLanguageOnly
    && review.conversationNotAudit;

  // SUBJECT: enforced only where the model actually authors it (a threaded follow-up's subject is
  // deterministic thread continuity produced by code).
  const subject = !subjectAuthored || (review.subjectSpecific && review.subjectCuriosityGap);

  // COPY JOB: exactly the dimensions this step's job calls for.
  const copyJob = STEP_DEPENDENT_DIMENSIONS.every(
    (d) => !d.requiredAt.includes(step) || review[d.name] === true,
  );

  return universal && subject && copyJob && sequenceJobSatisfied(review, step);
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
