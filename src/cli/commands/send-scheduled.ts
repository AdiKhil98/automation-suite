import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { MockSendProvider } from '../../integrations/send/mock-send.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { SendInputRepository } from '../../persistence/repositories/send-input.repo.js';
import { buildSendProvider, buildSendService } from './send-build.js';
import { type CliContext } from '../context.js';

export interface SendScheduledOptions { lead: string }
/** Evaluate exactly one named lead. Dry-run performs local reads only and never calls a provider. */
export async function sendScheduledCommand(ctx: CliContext, opts: SendScheduledOptions): Promise<void> {
  const c = ctx.config;
  const lead = await ctx.leads.getById(opts.lead);
  const data = lead ? await new SendInputRepository(ctx.db).latest(opts.lead) : null;
  if (!lead || !data?.schedule) { console.log('No active scheduled candidate. Nothing was sent.'); return; }
  const baseInput = { leadId: opts.lead, leadStatus: lead.status, schedule: data.schedule,
    currentGmailDraft: data.currentGmailDraft, finalization: data.finalization,
    currentFinalizedContentHash: data.currentFinalizedContentHash, currentRecipientEmail: data.currentRecipientEmail,
    subject: data.subject, normalizedDomain: data.normalizedDomain, normalizedPhone: data.normalizedPhone,
    placeId: data.placeId, confirmation: null, preflightProof: null };

  if (c.DRY_RUN) {
    const report = await buildSendService(ctx, new MockSendProvider()).localReadiness(baseInput);
    console.log('Controlled-send dry run (local read only; no provider call or database write):');
    console.log(`  lead status: ${report.leadStatus}`);
    console.log(`  schedule: ${report.scheduleStatus}; timing=${report.timing}`);
    console.log(`  recipient fact present: ${report.recipientFactPresent}`);
    console.log(`  finalized approved: ${report.finalizedApproved}`);
    console.log(`  schedule fingerprint matches: ${report.fingerprints.scheduleMatches}`);
    console.log(`  approved envelope hash: ${report.fingerprints.approvedEnvelopeHash}`);
    console.log(`  send fingerprint: ${report.fingerprints.sendFingerprint ?? '(unavailable)'}`);
    console.log(`  database linkage: schedule/draft=${report.databaseLinkage.scheduleToDraft}; draft/finalization=${report.databaseLinkage.draftToFinalization}`);
    console.log(`  readiness: present=${report.readiness.present}; valid=${report.readiness.valid}`);
    console.log(`  suppression scopes matched: ${report.suppressionScopes.length}`);
    console.log(`  account cap: ${report.accountCap.confirmedToday}/${report.accountCap.dailyCap}; available=${report.accountCap.available}`);
    console.log(`  configured provider: ${c.SENDING_PROVIDER}; local inspector: ${report.provider.name}`);
    console.log(`  flags: sending=${report.flags.sendingEnabled}; outbound=${report.flags.outboundActionsEnabled}; dryRun=${report.flags.dryRun}`);
    console.log(`  local outcome: ${report.outcome}; external Gmail verification required: ${report.externalVerificationRequired}`);
    console.log(`  evaluated candidates: ${report.evaluatedCandidates}`);
    return;
  }
  if (!c.SENDING_ENABLED || !c.OUTBOUND_ACTIONS_ENABLED) { console.log('Sending gates are disabled. Nothing was sent.'); return; }

  const provider = buildSendProvider(ctx);
  if (!provider.live) { console.log('No live Gmail send provider is wired. Nothing was sent.'); return; }
  if (!stdin.isTTY || !stdout.isTTY) { console.log('Interactive TTY confirmation is required. Nothing was sent.'); return; }

  const service = buildSendService(ctx, provider);
  const preflight = await service.preflight(baseInput);
  if (preflight.outcome !== 'READY' || !preflight.preflightProof) { console.log(`Preflight blocked: ${preflight.outcome}. Nothing was sent.`); return; }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const by = (await rl.question('Operator name: ')).trim();
    const phrase = `SEND ${opts.lead} ${preflight.preflightProof.sendFingerprint}`;
    const observed = await rl.question(`Type exactly: ${phrase}\n> `);
    if (!by || observed !== phrase) { console.log('Confirmation did not match. Nothing was sent.'); return; }
    const runId = await new PipelineRunsRepository(ctx.db).start('send:scheduled', false);
    const result = await service.send({ ...baseInput, preflightProof: preflight.preflightProof,
      confirmation: { observedSendFingerprint: preflight.preflightProof.sendFingerprint, confirmedBy: by, confirmedAtMs: Date.now() } }, runId);
    await new PipelineRunsRepository(ctx.db).finish(runId, 'COMPLETED', result.outcome);
    console.log(`Controlled send result: ${result.outcome}.`);
  } finally { rl.close(); }
}
