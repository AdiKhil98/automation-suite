import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { approvedEnvelopeHash } from '../../domain/send/envelope.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { SendInputRepository } from '../../persistence/repositories/send-input.repo.js';
import { buildSendProvider, buildSendService } from './send-build.js';
import { type CliContext } from '../context.js';

export interface SendScheduledOptions { lead: string }
function maskEmail(email: string | null): string {
  if (!email) return '(none)';
  const [user, domain] = email.split('@');
  return domain ? `${(user ?? '').slice(0, 2)}***@${domain}` : '***';
}

/** Evaluate exactly one named lead. Dry-run performs local reads only and never calls a provider. */
export async function sendScheduledCommand(ctx: CliContext, opts: SendScheduledOptions): Promise<void> {
  const c = ctx.config;
  const lead = await ctx.leads.getById(opts.lead);
  const data = lead ? await new SendInputRepository(ctx.db).latest(opts.lead) : null;
  if (!lead || !data?.schedule) { console.log('No active scheduled candidate. Nothing was sent.'); return; }
  const envelopeHash = approvedEnvelopeHash({ gmailAccount: c.GMAIL_ACCOUNT_EMAIL ?? 'mock@example.com',
    recipientEmail: data.currentRecipientEmail ?? '', subject: data.subject ?? '',
    finalizedContentHash: data.currentFinalizedContentHash ?? '', scheduleId: data.schedule.id,
    scheduledAtUtcMs: data.schedule.scheduledAtUtcMs });

  if (c.DRY_RUN) {
    console.log('Controlled-send dry run (local read only; no provider call or database write):');
    console.log(`  lead status: ${lead.status}`);
    console.log(`  recipient: ${maskEmail(data.currentRecipientEmail)}`);
    console.log(`  scheduled UTC: ${new Date(data.schedule.scheduledAtUtcMs).toISOString()}`);
    console.log(`  approved envelope hash: ${envelopeHash}`);
    console.log('  evaluated candidates: 1');
    return;
  }
  if (!c.SENDING_ENABLED || !c.OUTBOUND_ACTIONS_ENABLED) { console.log('Sending gates are disabled. Nothing was sent.'); return; }

  const provider = buildSendProvider(ctx);
  if (!provider.live) { console.log('No live Gmail send provider is wired. Nothing was sent.'); return; }
  if (!stdin.isTTY || !stdout.isTTY) { console.log('Interactive TTY confirmation is required. Nothing was sent.'); return; }

  const service = buildSendService(ctx, provider);
  const baseInput = { leadId: opts.lead, leadStatus: lead.status, schedule: data.schedule,
    currentGmailDraft: data.currentGmailDraft, finalization: data.finalization,
    currentFinalizedContentHash: data.currentFinalizedContentHash, currentRecipientEmail: data.currentRecipientEmail,
    subject: data.subject, confirmation: null, preflightProof: null };
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
