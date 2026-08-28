import { type EmailReviewParsed } from './email-schema.js';

/**
 * The single source of truth for whether an independent adversarial email review APPROVES a draft.
 *
 * Revisions are never silently approved without being applied: the decision must be APPROVE,
 * fabricationRisk must be false, and every boolean quality dimension (persuasion, evidence,
 * punctuation, CTA, competitor, demo-alignment, and the single-observation / buyer-language gate)
 * must pass. The writer service, resume-review recovery, and the compose-preview reviewer all use
 * this exact conjunction so the gate can never drift between the three paths.
 */
export function isEmailReviewApprovable(review: EmailReviewParsed): boolean {
  return review.decision === 'APPROVE'
    && !review.fabricationRisk
    && review.subjectSpecific
    && review.subjectCuriosityGap
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
    && review.confidentObservation;
}
