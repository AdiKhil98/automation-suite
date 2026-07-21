import { ReadOnlyGmailPreflightService } from '../../domain/send/read-only-gmail-preflight.js';
import { SendInputRepository } from '../../persistence/repositories/send-input.repo.js';
import { type CliContext } from '../context.js';
import { buildReadOnlyGmailVerifier } from './send-build.js';

/** One known-draft read-only Gmail verification. No state changes and no send capability. */
export async function gmailSendPreflightCommand(ctx: CliContext, opts: { lead: string }): Promise<void> {
  if (!ctx.config.GMAIL_SEND_PREFLIGHT_ENABLED) {
    console.log('Read-only Gmail preflight is disabled. No Gmail call was made.'); return;
  }
  const lead = await ctx.leads.getById(opts.lead);
  const data = lead ? await new SendInputRepository(ctx.db).latest(opts.lead) : null;
  if (!lead || !data) { console.log('No eligible local record. No Gmail call was made.'); return; }
  const input = { leadId: opts.lead, leadStatus: lead.status, ...data, confirmation: null, preflightProof: null };
  const service = new ReadOnlyGmailPreflightService(buildReadOnlyGmailVerifier(ctx), {
    gmailAccount: ctx.config.GMAIL_ACCOUNT_EMAIL ?? '', senderName: ctx.config.GMAIL_SENDER_NAME ?? null });
  const result = await service.verify(input);
  console.log(`Read-only Gmail preflight: ${result.outcome}.`);
  console.log(`  account and known approved envelope verified: ${result.ok}`);
  console.log('  database writes: 0; send capability: unavailable');
}
