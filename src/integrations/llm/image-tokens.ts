import { type ImageDetail } from './provider.js';

/**
 * Deterministic, conservative input-image token estimator for GPT-5.6 (patch-based
 * vision), verified against OpenAI's images/vision guide on 2026-07-15.
 *
 * Documented rules (developers.openai.com/api/docs/guides/images-vision):
 * - GPT-5.x models are PATCH-based: the image is divided into 32×32-pixel patches;
 *   tokens ≈ patchCount, capped at a per-model patch budget (documented range across
 *   models: 1,536–10,000), with a per-model multiplier (documented range 1.62–2.46×).
 * - GPT-5.6 additionally supports detail:"original" (no resize). Gate A forces
 *   detail:"high"; we never use auto/original for Gate A.
 *
 * The exact budget/multiplier for gpt-5.6-sol is NOT individually published, so we use
 * the CONSERVATIVE ends of the documented ranges (max multiplier 2.46, and we never
 * assume a cap lower than the raw patch count) to guarantee an OVER-estimate. To keep
 * that over-estimate small and bounded, screenshots are resized to a documented max
 * dimension before upload (see resizeForUpload); this makes the max token cost known.
 */

export const VISION_RULES_VERIFIED_AT = '2026-07-15';
export const VISION_RULES_SOURCE = 'https://developers.openai.com/api/docs/guides/images-vision (patch-based GPT-5.x; verified 2026-07-15)';

export const PATCH_PX = 32;
// Conservative multiplier: the high end of the documented per-model range (1.62–2.46).
export const CONSERVATIVE_PATCH_MULTIPLIER = 2.46;
// Bounded upload box (longest side, px). Keeps patch count small and deterministic.
export const MAX_UPLOAD_DIMENSION = 768;

export interface ImageTokenEstimate {
  widthPx: number;
  heightPx: number;
  detail: ImageDetail;
  patches: number;
  tokens: number;
}

/**
 * Conservative token estimate for a single already-bounded image, from its ACTUAL
 * pixel dimensions. Returns null when the estimate cannot be determined (missing/zero
 * dimensions, or a detail level we do not price for Gate A). A null result must block
 * the paid call upstream — never treated as zero.
 */
export function estimateImageTokens(
  widthPx: number | null,
  heightPx: number | null,
  detail: ImageDetail,
): ImageTokenEstimate | null {
  if (!widthPx || !heightPx || widthPx <= 0 || heightPx <= 0) return null;
  // Gate A is restricted to detail:'high'. 'auto'/'original' (no forced resize) make
  // the token cost depend on unbounded input dimensions → not priced here → block.
  if (detail !== 'high' && detail !== 'low') return null;
  if (detail === 'low') {
    // Patch-based low-detail is a small fixed cost; we bound it conservatively.
    return { widthPx, heightPx, detail, patches: 0, tokens: Math.ceil(CONSERVATIVE_PATCH_MULTIPLIER * 85) };
  }
  const patches = Math.ceil(widthPx / PATCH_PX) * Math.ceil(heightPx / PATCH_PX);
  const tokens = Math.ceil(patches * CONSERVATIVE_PATCH_MULTIPLIER);
  return { widthPx, heightPx, detail, patches, tokens };
}

/** Bounded target dimensions after fitting within MAX_UPLOAD_DIMENSION (aspect kept). */
export function boundedDimensions(widthPx: number, heightPx: number, maxDim = MAX_UPLOAD_DIMENSION): { width: number; height: number } {
  const longest = Math.max(widthPx, heightPx);
  if (longest <= maxDim) return { width: widthPx, height: heightPx };
  const scale = maxDim / longest;
  return { width: Math.max(1, Math.round(widthPx * scale)), height: Math.max(1, Math.round(heightPx * scale)) };
}
