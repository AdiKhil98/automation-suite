import { type GmailOutcome } from '../../domain/gmail/gmail-service.js';
import { GmailInputRepository } from '../../persistence/repositories/gmail-input.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildGmailService } from './gmail-build.js';
import { type CliContext } from '../context.js';

export interface CreateGmailDraftsOptions {
  limit?: string;
}

export async function createGmailDraftsCommand(ctx: CliContext, cliOpts: CreateGmailDraftsOptions): Promise<void> {
  const c = ctx.config;
  if (!c.GMAIL_DRAFTS_ENABLED) {
    console.log('Gmail draft creation is disabled (GMAIL_DRAFTS_ENABLED=false).');
    return;
  }
  if (!c.GMAIL_DRAFT_ACTIONS_ENABLED) {
    console.log('Gmail draft creation is blocked (GMAIL_DRAFT_ACTIONS_ENABLED=false).');
    return;
  }
  const { service, providerName, live } = buildGmailService(ctx);
  const inputRepo = new GmailInputRepository(ctx.db);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'HUMAN_APPROVED');
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
  leads = leads.slice(0, c.GMAIL_MAX_DRAFTS_PER_RUN);

  console.log(`\nGmail draft run (provider=${providerName}, live=${String(live)}):`);
  console.log(`  eligible HUMAN_APPROVED leads: ${leads.length} (per-run cap ${String(c.GMAIL_MAX_DRAFTS_PER_RUN)})`);
  if (!live) console.log('  NOTE: mock provider — no real Gmail draft is created.');

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start('gmail:drafts', c.DRY_RUN);
  const counts = new Map<GmailOutcome, number>();
  for (const lead of leads) {
    const data = await inputRepo.latest(lead.id);
    const r = await service.createDraft({ leadId: lead.id, leadStatus: lead.status, finalization: data.finalization, subject: data.subject, recipientEmail: data.recipientEmail }, runId);
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  }
  await runs.finish(runId, 'COMPLETED', JSON.stringify(Object.fromEntries(counts)));

  console.log(`\nGmail draft run ${runId} complete:`);
  for (const [outcome, n] of counts) console.log(`  ${outcome.padEnd(22)} ${String(n)}`);
  console.log('\n  Drafts are created in Gmail but NEVER sent. No scheduling, no follow-ups, no inbox access.');
}
