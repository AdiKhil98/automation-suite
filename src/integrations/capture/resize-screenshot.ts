import sharp from 'sharp';
import { boundedDimensions, MAX_UPLOAD_DIMENSION } from '../llm/image-tokens.js';

export interface ResizedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mediaType: 'image/png';
}

/**
 * Resize a screenshot PNG to a bounded box (longest side ≤ MAX_UPLOAD_DIMENSION,
 * aspect preserved) BEFORE upload, so the maximum vision-token cost is deterministic
 * and small (see image-tokens.ts). Re-encodes PNG and returns the exact output
 * dimensions. Throws if the input cannot be decoded — the caller must block the paid
 * call rather than upload an image of unknown size.
 */
export async function resizeForUpload(png: Buffer, maxDim = MAX_UPLOAD_DIMENSION): Promise<ResizedImage> {
  const meta = await sharp(png).metadata();
  if (!meta.width || !meta.height) throw new Error('screenshot dimensions undeterminable');
  const target = boundedDimensions(meta.width, meta.height, maxDim);
  const out = await sharp(png)
    .resize(target.width, target.height, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer: out, width: target.width, height: target.height, mediaType: 'image/png' };
}
