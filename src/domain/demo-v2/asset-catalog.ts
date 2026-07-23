import { z } from 'zod';
import { SHA256_PATTERN } from './hash.js';

export const assetSelectionSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  status: z.enum(['PROPOSED', 'REUSE_REVIEW_REQUIRED', 'SELECTED', 'REJECTED', 'STALE']),
  boundAssetRecordHash: z.string().regex(SHA256_PATTERN),
  selectionHash: z.string().regex(SHA256_PATTERN),
});

export const assetReuseReviewSchema = z.object({
  id: z.string().min(1),
  assetSelectionId: z.string().min(1),
  decision: z.enum(['APPROVED_CONCEPT_USE', 'NEEDS_RIGHTS_REVIEW', 'REJECTED']),
  actorType: z.enum(['MODEL', 'HUMAN', 'SYSTEM']),
  actorId: z.string().min(1),
  boundAssetRecordHash: z.string().regex(SHA256_PATTERN),
  boundSelectionHash: z.string().regex(SHA256_PATTERN),
  reviewHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  if ((value.decision === 'APPROVED_CONCEPT_USE' || value.decision === 'REJECTED')
    && value.actorType !== 'HUMAN') {
    ctx.addIssue({ code: 'custom', path: ['actorType'], message: 'final reuse decision requires a human actor' });
  }
});

export type AssetSelection = z.infer<typeof assetSelectionSchema>;
export type AssetReuseReview = z.infer<typeof assetReuseReviewSchema>;

export function isAssetUsable(
  selection: AssetSelection,
  review: AssetReuseReview | undefined,
  currentAssetRecordHash: string = selection.boundAssetRecordHash,
): boolean {
  return selection.status === 'SELECTED'
    && currentAssetRecordHash === selection.boundAssetRecordHash
    && review?.decision === 'APPROVED_CONCEPT_USE'
    && review.actorType === 'HUMAN'
    && review.assetSelectionId === selection.id
    && review.boundAssetRecordHash === selection.boundAssetRecordHash
    && review.boundSelectionHash === selection.selectionHash;
}
