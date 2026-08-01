import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type AppConfig } from '../../config/env.js';
import { type CompetitorCaptureConfig } from '../../domain/competitor/capture-service.js';
import { type SelectedCompetitorInput } from '../../domain/competitor/capture-eligibility.js';
import { MockCaptureProvider, type MockPageSpec } from '../../integrations/capture/mock-capture.js';
import { PlaywrightCaptureProvider } from '../../integrations/capture/playwright-capture.js';
import { type BrowserCaptureProvider } from '../../integrations/capture/provider.js';
import { CompetitorResearchRepository } from '../../persistence/repositories/competitor-research.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { type CliContext } from '../context.js';

export interface ResolvedResearchRun {
  runId: string;
  version: number;
  outcome: string;
  competitors: SelectedCompetitorInput[];
}

/**
 * Resolve the Phase 7A1 research run to capture from: the explicit run id if given, else the latest
 * DRAFT (non-superseded) run for the lead. Returns ONLY selected (ACCEPTED) competitors — capture can
 * never target a rejected/superseded candidate.
 */
export async function resolveResearchRun(
  ctx: CliContext,
  leadId: string,
  researchRunId?: string,
): Promise<ResolvedResearchRun | null> {
  const repo = new CompetitorResearchRepository(ctx.db);
  const runs = await repo.listRunsForLead(leadId);
  const run = researchRunId ? runs.find((r) => r.id === researchRunId) : runs.find((r) => r.status === 'DRAFT');
  if (!run) return null;
  const candidates = await repo.getCandidates(run.id);
  const competitors: SelectedCompetitorInput[] = candidates
    .filter((c) => c.disposition === 'ACCEPTED')
    .map((c) => ({ competitorCandidateId: c.id, disposition: c.disposition, normalizedDomain: c.normalizedDomain }));
  return { runId: run.id, version: run.version, outcome: run.outcome, competitors };
}

/** The prospect's verified official domain (never a competitor origin), used for self-exclusion. */
export async function getProspectDomain(ctx: CliContext, leadId: string): Promise<string | null> {
  const facts = new LeadFactsRepository(ctx.db);
  const fact = await facts.getCurrentFact(leadId, 'official_domain');
  return fact?.normalizedValue ?? fact?.value ?? null;
}

/** Build the deterministic, env-bounded capture config. Env may lower, never silently exceed, caps. */
export function buildCaptureConfig(config: AppConfig): CompetitorCaptureConfig {
  return {
    maxPages: config.COMPETITOR_CAPTURE_MAX_PAGES,
    maxDepth: config.COMPETITOR_CAPTURE_MAX_DEPTH,
    navigationTimeoutMs: config.COMPETITOR_CAPTURE_TIMEOUT_MS,
    totalTimeoutMs: config.CAPTURE_TOTAL_TIMEOUT_MS,
    maxScreenshotBytes: config.CAPTURE_MAX_SCREENSHOT_BYTES,
    fullPageMaxHeightPx: config.CAPTURE_FULLPAGE_MAX_HEIGHT_PX,
    blockTrackers: config.CAPTURE_BLOCK_TRACKERS,
    blockMedia: config.CAPTURE_BLOCK_MEDIA,
    maxAgeDays: config.COMPETITOR_EVIDENCE_MAX_AGE_DAYS,
  };
}

const fixtureSchema = z.object({
  pages: z.record(
    z.string(),
    z.object({
      html: z.string(),
      ok: z.boolean().optional(),
      httpStatus: z.number().int().optional(),
      finalUrl: z.string().optional(),
      canonicalUrl: z.string().nullable().optional(),
      desktopOverflow: z.boolean().optional(),
      mobileOverflow: z.boolean().optional(),
      primaryError: z.string().optional(),
    }),
  ),
});

/** Load a local HTML fixture map into a MockCaptureProvider (offline; zero network). */
export async function buildFixtureProvider(fixturePath: string): Promise<BrowserCaptureProvider> {
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = fixtureSchema.parse(JSON.parse(raw));
  const map = new Map<string, MockPageSpec>();
  for (const [url, spec] of Object.entries(parsed.pages)) {
    map.set(url, spec as MockPageSpec);
  }
  return new MockCaptureProvider(map);
}

/** Construct the guarded live browser provider. Only reached when live guards already passed. */
export function buildLiveProvider(ctx: CliContext): BrowserCaptureProvider {
  return new PlaywrightCaptureProvider({
    logger: ctx.logger,
    dockerImageTag: null,
    allowLoopback: ctx.config.CAPTURE_ALLOW_LOOPBACK,
    chromiumSandbox: ctx.config.CAPTURE_CHROMIUM_SANDBOX,
  });
}
