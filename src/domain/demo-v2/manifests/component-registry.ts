import { z } from 'zod';
import { demoV2Hash } from '../hash.js';

export const componentRegistrySchema = z.object({
  version: z.string().min(1),
  components: z.array(z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    supportedDirections: z.array(z.enum(['LTR', 'RTL'])).min(1),
    contentSlots: z.array(z.string().min(1)),
  })).min(1),
});

export function parseComponentRegistry(value: unknown) {
  const manifest = componentRegistrySchema.parse(value);
  return { manifest, hash: demoV2Hash(manifest) };
}
