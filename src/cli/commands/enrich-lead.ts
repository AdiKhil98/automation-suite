import { readFile } from 'node:fs/promises';
import { enrichLeads, type EnrichBatchItem } from '../../pipeline/enrich-leads.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildEnrichmentService } from './enrichment-build.js';
import { type CliContext } from '../context.js';

export interface EnrichLeadCliOptions {
  lead?: string;
  candidate?: string;
  csv?: string;
}

interface ManualRow {
  leadId: string;
  candidateUrl: string;
}

async function parseCsv(path: string): Promise<ManualRow[]> {
  const text = await readFile(path, 'utf8');
  const rows: ManualRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [leadId, candidateUrl] = trimmed.split(',').map((s) => s.trim());
    if (!leadId || !candidateUrl || leadId.toLowerCase() === 'leadid') continue; // skip header/blank
    rows.push({ leadId, candidateUrl });
  }
  return rows;
}

/** Manual production path: verify operator-supplied candidate URLs (no Google/paid API). */
export async function enrichLeadCommand(ctx: CliContext, cliOpts: EnrichLeadCliOptions): Promise<void> {
  const rows: ManualRow[] = [];
  if (cliOpts.csv) rows.push(...(await parseCsv(cliOpts.csv)));
  if (cliOpts.lead && cliOpts.candidate) rows.push({ leadId: cliOpts.lead, candidateUrl: cliOpts.candidate });
  if (rows.length === 0) {
    console.error('Provide --lead <id> --candidate <url>, or --csv <path> (leadId,candidateUrl).');
    process.exitCode = 1;
    return;
  }

  const factsRepo = new LeadFactsRepository(ctx.db);
  const items: EnrichBatchItem[] = [];
  for (const row of rows) {
    const lead = await ctx.leads.getById(row.leadId);
    if (!lead) {
      console.error(`Lead not found: ${row.leadId} (skipped)`);
      continue;
    }
    items.push({
      input: {
        leadId: lead.id,
        placeId: lead.placeId,
        currentFacts: await factsRepo.listCurrentFacts(lead.id),
        manual: { candidateUrls: [row.candidateUrl] },
      },
    });
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start('enrich-lead:manual', ctx.config.DRY_RUN);
  const { service, verify } = buildEnrichmentService(ctx, true); // forceManual

  const summary = await enrichLeads({ service, logger: ctx.logger }, items, { runId, verify });
  await runs.finish(runId, 'COMPLETED', JSON.stringify(summary));

  console.log(`\nManual enrichment run ${runId}: ${items.length} lead(s)`);
  console.log(`  VERIFIED: ${summary.VERIFIED}  AMBIGUOUS: ${summary.AMBIGUOUS}  NO_VERIFIED: ${summary.NO_VERIFIED_CANDIDATE}`);
  console.log(`  POLICY_BLOCKED: ${summary.POLICY_BLOCKED}  TRANSIENT: ${summary.TRANSIENT_ERROR}  INVALID_INPUT: ${summary.INVALID_INPUT}`);
  if (summary.failed > 0) console.log(`  failed (internal): ${summary.failed}`);
}
