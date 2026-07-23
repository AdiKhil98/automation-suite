import { z } from 'zod';
import { demoV2Hash } from '../hash.js';

export const referenceLibrarySchema = z.object({
  version: z.string().min(1),
  references: z.array(z.object({
    id: z.string().min(1),
    category: z.string().min(1),
    notes: z.string().min(1),
    allowedUse: z.literal('INSPIRATION_ONLY'),
  })).min(1),
});

export function parseReferenceLibrary(value: unknown) {
  const manifest = referenceLibrarySchema.parse(value);
  return { manifest, hash: demoV2Hash(manifest) };
}
