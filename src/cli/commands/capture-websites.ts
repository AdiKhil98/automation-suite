import { getCampaign } from '../../config/campaigns.js';
import { LeadService } from '../../domain/leads/lead-service.js';
import { captureWebsites, type CaptureItem } from '../../pipeline/capture-websites.js';
import { CaptureRepository } from '../../persistence/repositories/capture.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildCaptureService } from './capture-build.js';
import { type CliContext } from '../context.js';

export interface CaptureCliOptions {
  campaign: string;
  purpose?: string;
  limit?: string;
}

export async function captureWebsitesCommand(ctx: CliContext, cliOpts: CaptureCliOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const purpose = cliOpts.purpose === 'verification' ? 'VERIFICATION_CAPTURE' : 'AUDIT_CAPTURE';
  const factsRepo = new LeadFactsRepository(ctx.db);
  const captureRepo = new CaptureRepository(ctx.db);
  const leadService = new LeadService(new LeadsRepository(ctx.db), new PipelineRepository(ctx.db));

  const all = await ctx.leads.list(1000);
  const items: CaptureItem[] = [];

  if (purpose === 'AUDIT_CAPTURE') {
    let leads = all.filter((l) => l.status === 'QUALIFIED' || l.status === 'READY_FOR_CAPTURE');
    if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
    leads = leads.slice(0, ctx.config.CAPTURE_MAX_LEADS_PER_RUN);
    for (const lead of leads) {
      if (lead.status === 'QUALIFIED') await leadService.transition(lead.id, 'READY_FOR_CAPTURE');
      items.push({ input: { leadId: lead.id, purpose, facts: await factsRepo.listCurrentFacts(lead.id) } });
    }
  } else {
    let leads = all.filter((l) => l.status === 'NEEDS_MANUAL_REVIEW');
    if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
    for (const lead of leads) {
      const target = await captureRepo.getVerificationTarget(lead.id);
      if (!target) continue; // only Phase-4 BROWSER_REQUIRED leads
      await leadService.transition(lead.id, 'READY_FOR_CAPTURE');
      items.push({
        input: {
          leadId: lead.id,
          purpose,
          facts: await factsRepo.listCurrentFacts(lead.id),
          verificationTargetUrl: target.url,
          sourceEnrichmentCandidateId: target.candidateId,
        },
      });
      if (items.length >= ctx.config.CAPTURE_MAX_LEADS_PER_RUN) break;
    }
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`capture:${campaign.name}:${purpose}`, ctx.config.DRY_RUN);
  const { service } = buildCaptureService(ctx);
  const summary = await captureWebsites({ service, logger: ctx.logger }, items, { runId });
  await runs.finish(runId, 'COMPLETED', JSON.stringify(summary));

  console.log(`\nCapture run ${runId} (${campaign.name}, ${purpose}, provider=${ctx.config.CAPTURE_PROVIDER}):`);
  console.log(`  leads:              ${items.length}`);
  console.log(`  CAPTURED:           ${summary.CAPTURED}`);
  console.log(`  PARTIAL_CAPTURE:    ${summary.PARTIAL_CAPTURE}`);
  console.log(`  BROWSER_BLOCKED:    ${summary.BROWSER_BLOCKED}`);
  console.log(`  BOT_CHALLENGE:      ${summary.BOT_CHALLENGE}`);
  console.log(`  AUTH_REQUIRED:      ${summary.AUTH_REQUIRED}`);
  console.log(`  NO_RENDERABLE:      ${summary.NO_RENDERABLE_CONTENT}`);
  console.log(`  TRANSIENT_ERROR:    ${summary.TRANSIENT_ERROR}`);
  console.log(`  POLICY_BLOCKED:     ${summary.POLICY_BLOCKED}`);
  console.log(`  INVALID_TARGET:     ${summary.INVALID_TARGET}`);
  if (purpose === 'VERIFICATION_CAPTURE') console.log(`  verified:           ${summary.verified}`);
  if (summary.failed > 0) console.log(`  failed (internal):  ${summary.failed}`);
}
