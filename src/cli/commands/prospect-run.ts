import { ProspectService, type ProspectContinuation } from '../../domain/prospect/prospect-service.js';
import { type ProspectRank } from '../../domain/prospect/types.js';
import { validateProspectInput } from '../../domain/prospect/validation.js';
import { GooglePlacesDetailsClient } from '../../integrations/enrichment/google-places-details.js';
import { GoogleLocationResolver } from '../../integrations/prospect/location-resolver.js';
import { GoogleNearbySearch } from '../../integrations/prospect/nearby-search.js';
import { FetchPlacesTransport } from '../../integrations/prospect/places-transport.js';
import { DrizzleQualificationUnitOfWork } from '../../persistence/qualification-unit-of-work.js';
import { ProspectRepository } from '../../persistence/repositories/prospect.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { ProductionProspectCandidateProcessor } from '../../pipeline/prospect-candidate-processor.js';
import { QualificationService } from '../../domain/qualification/qualification-service.js';
import { auditWebsitesCommand } from './audit-websites.js';
import { captureWebsitesCommand } from './capture-websites.js';
import { buildEnrichmentService } from './enrichment-build.js';
import { generateDemosCommand } from './generate-demos.js';
import { generateEmailsCommand } from './generate-emails.js';
import { type CliContext } from '../context.js';
import { assertControlledTestPreflight } from '../../domain/prospect/controlled-test.js';
import { ControlledTestContinuation, assertControlledProviderConfig, withControlledTestGates } from './prospect-controlled-test.js';

export interface ProspectRunCliOptions {
  niche: string; location?: string; radiusKm: string; targetQualified?: string; maxCandidates?: string;
  rank?: string; latitude?: string; longitude?: string; continuePipeline?: boolean;
  controlledTest?: boolean; testRecipientEnv?: string; autoApproveTestArtifacts?: boolean;
}

function numberOf(value: string | undefined, fallback: number): number { return value === undefined ? fallback : Number(value) }

class ExistingPipelineContinuation implements ProspectContinuation {
  constructor(private readonly ctx: CliContext) {}
  async continueFirstQualified(leadId: string): Promise<void> {
    const exact = { campaign: 'prospect-runtime', limit: '1', lead: leadId };
    await captureWebsitesCommand(this.ctx, exact);
    await auditWebsitesCommand(this.ctx, exact);
    await generateDemosCommand(this.ctx, exact);
    await generateEmailsCommand(this.ctx, exact);
    console.log('  Continuation stopped before deployment, Gmail draft creation, scheduling, or sending; existing approvals remain required.');
  }
}

export async function prospectRunCommand(ctx: CliContext, cli: ProspectRunCliOptions): Promise<void> {
  const c = ctx.config;
  const targetQualified = numberOf(cli.targetQualified, c.PROSPECT_TARGET_QUALIFIED_PER_RUN);
  if (cli.controlledTest) {
    const recipient = assertControlledTestPreflight({ controlledTest: true,
      continuePipeline: Boolean(cli.continuePipeline), autoApproveTestArtifacts: Boolean(cli.autoApproveTestArtifacts),
      recipientEnvName: cli.testRecipientEnv, recipientValue: c.TEST_RECIPIENT_EMAIL,
      targetQualified, dryRun: c.DRY_RUN, sendingEnabled: c.SENDING_ENABLED,
      outboundActionsEnabled: c.OUTBOUND_ACTIONS_ENABLED });
    assertControlledProviderConfig(c);
    return withControlledTestGates(c, () => runProspect(ctx, cli, recipient));
  }
  return runProspect(ctx, cli, null);
}

async function runProspect(ctx: CliContext, cli: ProspectRunCliOptions, controlledRecipient: string | null): Promise<void> {
  const c = ctx.config;
  if (!c.PROSPECT_DISCOVERY_ENABLED) { console.log('Prospect discovery is disabled (PROSPECT_DISCOVERY_ENABLED=false).'); return }
  if (!c.ALLOW_PAID_READS) { console.log('Prospect discovery is blocked (ALLOW_PAID_READS=false).'); return }
  if (c.DRY_RUN) { console.log('Prospect discovery is blocked (DRY_RUN=true; no live paid reads under dry-run).'); return }
  if (!c.GOOGLE_PLACES_API_KEY) { console.log('Prospect discovery requires GOOGLE_PLACES_API_KEY.'); return }
  if (cli.continuePipeline && !c.PROSPECT_CONTINUE_PIPELINE) { console.log('Pipeline continuation is disabled (PROSPECT_CONTINUE_PIPELINE=false).'); return }
  const input = validateProspectInput({
    niche: cli.niche, location: cli.location ?? '', radiusKm: numberOf(cli.radiusKm, 0),
    targetQualified: numberOf(cli.targetQualified, c.PROSPECT_TARGET_QUALIFIED_PER_RUN),
    maxCandidates: numberOf(cli.maxCandidates, c.PROSPECT_MAX_CANDIDATES_PER_RUN),
    rankPreference: (cli.rank?.toUpperCase() ?? c.PROSPECT_RANK_PREFERENCE) as ProspectRank,
    latitude: cli.latitude === undefined ? undefined : Number(cli.latitude), longitude: cli.longitude === undefined ? undefined : Number(cli.longitude),
    continuePipeline: Boolean(cli.continuePipeline),
  });
  if (input.maxCandidates > c.PROSPECT_MAX_CANDIDATES_PER_RUN || input.targetQualified > c.PROSPECT_TARGET_QUALIFIED_PER_RUN) throw new Error('requested prospect limits exceed configured caps');
  const runs = new PipelineRunsRepository(ctx.db); const pipelineRunId = await runs.start(`prospect:${input.niche}`, c.DRY_RUN);
  try {
    const transport = new FetchPlacesTransport(c.GOOGLE_PLACES_API_KEY, c.PLACES_TIMEOUT_MS);
    const store = new ProspectRepository(ctx.db);
    const builtEnrichment = buildEnrichmentService(ctx, { forceManual: true });
    const processor = new ProductionProspectCandidateProcessor({ db: ctx.db, details: new GooglePlacesDetailsClient(c.GOOGLE_PLACES_API_KEY, c.ENRICH_HTTP_TIMEOUT_MS, ctx.logger), enrichment: builtEnrichment.service, verify: builtEnrichment.verify, qualification: new QualificationService(new DrizzleQualificationUnitOfWork(ctx.db)), nearMeters: c.DEDUP_NEAR_ADDRESS_METERS, logger: ctx.logger });
    const continuation = input.continuePipeline
      ? (controlledRecipient ? new ControlledTestContinuation(ctx, controlledRecipient) : new ExistingPipelineContinuation(ctx))
      : undefined;
    const service = new ProspectService({ locationResolver: new GoogleLocationResolver(transport, store), nearby: new GoogleNearbySearch(transport), processor, store, limits: { maxDetails: c.PROSPECT_MAX_PLACE_DETAILS_PER_RUN, maxWebsiteVerifications: c.PROSPECT_MAX_WEBSITE_VERIFICATIONS_PER_RUN }, continuation });
    const summary = await service.run(input, pipelineRunId);
    await runs.finish(pipelineRunId, summary.result === 'SYSTEMIC_FAILURE' ? 'FAILED' : 'COMPLETED', JSON.stringify(summary));
    console.log(`\nProspect run ${summary.runId}:`);
    console.log(`  result: ${summary.result}`); console.log(`  discovered: ${summary.discovered}`); console.log(`  processed: ${summary.processed}`); console.log(`  qualified: ${summary.qualifiedLeadIds.length}`);
    console.log(`  calls: location=${summary.externalCalls.locationResolution}, nearby=${summary.externalCalls.nearbySearch}, details=${summary.externalCalls.placeDetails}, website=${summary.externalCalls.websiteVerification}`);
    if (summary.circuitBreakerReason) console.log(`  circuit breaker: ${summary.circuitBreakerReason}`);
    if (summary.qualifiedLeadIds.length > 0) console.log(`  qualified lead IDs: ${summary.qualifiedLeadIds.join(', ')}`);
  } catch (error) {
    await runs.finish(pipelineRunId, 'FAILED', 'prospect run failed closed'); throw error;
  }
}
