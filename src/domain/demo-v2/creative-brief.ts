import { z } from 'zod';
import { SHA256_PATTERN } from './hash.js';

export const creativeBriefSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  clinicIntelligencePackageId: z.string().min(1),
  primaryContentPackageId: z.string().min(1),
  assetCatalogId: z.string().min(1),
  version: z.number().int().positive(),
  schemaVersion: z.string().min(1),
  status: z.enum(['DRAFT', 'VALIDATED', 'STALE', 'REJECTED']),
  brief: z.record(z.string(), z.unknown()),
  inputFingerprint: z.string().regex(SHA256_PATTERN),
  briefHash: z.string().regex(SHA256_PATTERN),
});
