import { getCampaign } from '../../config/campaigns.js';
import { mockBusinesses } from '../../fixtures/mock-businesses.js';
import { GooglePlacesProvider } from '../../integrations/lead-source/google-places/client.js';
import { MockLeadSource } from '../../integrations/lead-source/mock-lead-source.js';
import { type LeadSourceProvider } from '../../integrations/lead-source/provider.js';
import { collectLeads } from '../../pipeline/collect-leads.js';
import { DrizzleUnitOfWork } from '../../persistence/unit-of-work.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { SourceRequestsRepository } from '../../persistence/repositories/source.repo.js';
import { RateLimiter } from '../../utils/rate-limiter.js';
import { type CliContext } from '../context.js';

export interface CollectLeadsCliOptions {
  campaign: string;
  source?: 'mock' | 'google_places';
  dryRun?: boolean;
  limit?: string;
}

export async function collectLeadsCommand(
  ctx: CliContext,
  cliOpts: CollectLeadsCliOptions,
): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const provider = cliOpts.source ?? campaign.provider;
  const dryRun = ctx.config.DRY_RUN || Boolean(cliOpts.dryRun);
  const maxLeads = cliOpts.limit ? Number.parseInt(cliOpts.limit, 10) : ctx.config.MAX_LEADS_PER_RUN;

  let leadSource: LeadSourceProvider;
  if (provider === 'google_places') {
    if (!ctx.config.GOOGLE_PLACES_API_KEY) {
      console.error('LEAD_SOURCE=google_places requires GOOGLE_PLACES_API_KEY. Aborting.');
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      console.log(
        'Dry-run is on: skipping the paid Google Places API call. Set DRY_RUN=false to collect for real.',
      );
      return;
    }
    leadSource = new GooglePlacesProvider({
      apiKey: ctx.config.GOOGLE_PLACES_API_KEY,
      timeoutMs: ctx.config.PLACES_TIMEOUT_MS,
      maxRetries: ctx.config.PLACES_MAX_RETRIES,
      rateLimiter: new RateLimiter(ctx.config.PLACES_RATE_LIMIT_RPS),
      logger: ctx.logger,
    });
  } else {
    leadSource = new MockLeadSource(mockBusinesses);
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`collect-leads:${campaign.name}`, dryRun);

  const summary = await collectLeads(
    {
      provider: leadSource,
      requests: new SourceRequestsRepository(ctx.db),
      uow: new DrizzleUnitOfWork(ctx.db),
      logger: ctx.logger,
    },
    {
      runId,
      campaign: campaign.name,
      query: campaign.query,
      caps: {
        maxLeads,
        pageSize: ctx.config.PLACES_PAGE_SIZE,
        maxPages: ctx.config.PLACES_MAX_PAGES,
      },
      nearMeters: ctx.config.DEDUP_NEAR_ADDRESS_METERS,
      factsSource: provider === 'mock' ? 'mock' : 'manual',
    },
  );

  await runs.finish(runId, summary.interrupted ? 'FAILED' : 'COMPLETED', JSON.stringify(summary));

  console.log(`\nCollection run ${runId} (${provider}, ${dryRun ? 'dry-run' : 'live'}):`);
  console.log(`  created:    ${summary.created}`);
  console.log(`  duplicates: ${summary.duplicates}`);
  console.log(`  refreshed:  ${summary.refreshed}`);
  console.log(`  branches:   ${summary.branches}`);
  console.log(`  ambiguous:  ${summary.ambiguous}`);
  console.log(`  rejected:   ${summary.rejected}`);
  console.log(`  failed:     ${summary.failed}`);
  console.log(`  requests:   ${summary.requests} over ${summary.pages} page(s)`);
  if (summary.stoppedAtCap) console.log(`  (stopped at cap: ${maxLeads})`);
  if (summary.interrupted) console.log('  (interrupted — safe to rerun from page 1)');
}
