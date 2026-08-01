import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type AppConfig } from '../../config/env.js';
import { parseCompetitorCsv } from '../../domain/competitor/csv.js';
import { type SelectionConfig } from '../../domain/competitor/selection.js';
import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../domain/competitor/types.js';
import { assertAllowedProvider, type CompetitorProviderName, type CompetitorSourceResult } from '../../integrations/competitor/provider.js';

/** Deterministic selection config from validated env. */
export function buildSelectionConfig(config: AppConfig): SelectionConfig {
  return {
    primaryRadiusKm: config.COMPETITOR_PRIMARY_RADIUS_KM,
    fallbackRadiusKm: config.COMPETITOR_FALLBACK_RADIUS_KM,
    maxSelected: config.COMPETITOR_MAX_SELECTED,
  };
}

const fixtureCandidateSchema = z.object({
  providerCandidateId: z.string().nullable().default(null),
  businessName: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  primaryCategory: z.string().nullable().default(null),
  secondaryCategories: z.array(z.string()).default([]),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  address: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  market: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  businessType: z.string().nullable().default(null),
  parentBrand: z.string().nullable().default(null),
  branchId: z.string().nullable().default(null),
});

const fixtureSchema = z.object({
  prospect: z.object({
    website: z.string().nullable().default(null),
    primaryCategory: z.string().nullable().default(null),
    secondaryCategories: z.array(z.string()).default([]),
    latitude: z.number().nullable().default(null),
    longitude: z.number().nullable().default(null),
    city: z.string().nullable().default(null),
    market: z.string().nullable().default(null),
    language: z.string().nullable().default(null),
    businessType: z.string().nullable().default(null),
    parentBrand: z.string().nullable().default(null),
  }),
  candidates: z.array(fixtureCandidateSchema),
});

export interface LoadSourceOptions {
  provider: string;
  leadId: string;
  csvPath?: string;
  fixturePath?: string;
  maxInputCandidates: number;
}

/**
 * Load an operator-supplied candidate source. Fail-closed provider guard (no live fallback),
 * explicit file paths only (no arbitrary filesystem access), bounded candidate count.
 */
export async function loadCompetitorSource(opts: LoadSourceOptions): Promise<{ provider: CompetitorProviderName; result: CompetitorSourceResult }> {
  const provider = assertAllowedProvider(opts.provider); // throws on any live provider

  let result: CompetitorSourceResult;
  if (provider === 'operator_csv') {
    if (!opts.csvPath) throw new Error('operator_csv provider requires --csv <path>');
    const text = await readFile(opts.csvPath, 'utf8');
    const parsed = parseCompetitorCsv(text, opts.leadId);
    result = { prospect: parsed.prospect, candidates: parsed.candidates, errors: parsed.errors };
  } else {
    if (!opts.fixturePath) throw new Error('fixture provider requires --fixture <path.json>');
    const raw: unknown = JSON.parse(await readFile(opts.fixturePath, 'utf8'));
    const fx = fixtureSchema.parse(raw);
    const prospect: ProspectProfileInput = { leadId: opts.leadId, ...fx.prospect };
    const candidates: CompetitorInputCandidate[] = fx.candidates.map((c, i) => ({ rowIndex: i + 1, ...c }));
    result = { prospect, candidates, errors: [] };
  }

  if (result.candidates.length > opts.maxInputCandidates) {
    throw new Error(
      `input candidate count ${String(result.candidates.length)} exceeds COMPETITOR_MAX_INPUT_CANDIDATES=${String(opts.maxInputCandidates)} (bounded input; failing closed)`,
    );
  }
  return { provider, result };
}

/** Merge source-supplied prospect attributes with the lead record's identity/coordinates. */
export function resolveProspectProfile(
  sourceProspect: ProspectProfileInput,
  lead: { id: string; normalizedDomain: string | null; latitude: number | null; longitude: number | null; city: string | null },
): ProspectProfileInput {
  return {
    ...sourceProspect,
    leadId: lead.id,
    latitude: sourceProspect.latitude ?? lead.latitude,
    longitude: sourceProspect.longitude ?? lead.longitude,
    city: sourceProspect.city ?? lead.city,
  };
}
