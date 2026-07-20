import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SendAdminService, type ReconciliationSelection } from '../../domain/send/send-admin-service.js';
import { SendAdminRepository } from '../../persistence/repositories/send-admin.repo.js';
import { type CliContext } from '../context.js';

function service(ctx: CliContext): SendAdminService {
  return new SendAdminService(new SendAdminRepository(ctx.db), {
    gmailAccount: ctx.config.GMAIL_ACCOUNT_EMAIL ?? null, policyVersion: ctx.config.SENDING_POLICY_VERSION,
  });
}

export async function approveSendingReadinessCommand(ctx: CliContext, opts: { by: string; minutes: string }): Promise<void> {
  const minutes = Number(opts.minutes);
  const row = await service(ctx).createReadiness({ approvedBy: opts.by, expiresInMinutes: minutes });
  console.log(`Sending readiness created: ${row.id}`);
  console.log(`Expires: ${row.expiresAt.toISOString()}`);
  console.log('No email was sent.');
}

export async function revokeSendingReadinessCommand(ctx: CliContext, opts: { id: string; by: string; reason: string }): Promise<void> {
  const revoked = await service(ctx).revokeReadiness({ id: opts.id, revokedBy: opts.by, reason: opts.reason });
  console.log(revoked ? 'Sending readiness revoked.' : 'No active readiness matched.');
  console.log('No email was sent.');
}

export async function sendingReadinessStatusCommand(ctx: CliContext): Promise<void> {
  const row = await service(ctx).status();
  if (!row) { console.log('No sending readiness exists for the configured account and policy.'); return; }
  const now = Date.now();
  const state = row.revokedAt ? 'REVOKED' : row.expiresAt.getTime() <= now ? 'EXPIRED' : 'ACTIVE';
  console.log(`Readiness: ${row.id}`);
  console.log(`State: ${state}`);
  console.log(`Policy: ${row.policyVersion}`);
  console.log(`Expires: ${row.expiresAt.toISOString()}`);
}

export async function sendAttemptStatusCommand(ctx: CliContext, opts: { lead?: string }): Promise<void> {
  const rows = await service(ctx).attempts(opts.lead);
  if (rows.length === 0) { console.log('No send attempts matched.'); return; }
  for (const row of rows) console.log(`${row.id}  lead=${row.leadId}  status=${row.status}  reconciled=${row.reconciledOutcome ?? 'no'}`);
}

export async function reconcileSendAttemptCommand(ctx: CliContext, opts: { attempt: string; outcome: string; by: string; note: string }): Promise<void> {
  const map: Record<string, ReconciliationSelection> = { 'confirmed-sent': 'CONFIRMED_SENT',
    'confirmed-not-sent': 'CONFIRMED_NOT_SENT', unresolved: 'UNRESOLVED' };
  const outcome = map[opts.outcome];
  if (!outcome) throw new Error('Outcome must be confirmed-sent, confirmed-not-sent, or unresolved.');
  if (!stdin.isTTY || !stdout.isTTY) { console.log('Interactive TTY confirmation is required. Reconciliation was not changed.'); return; }
  const admin = service(ctx);
  const phrase = admin.reconciliationPhrase(opts.attempt, outcome);
  const rl = createInterface({ input: stdin, output: stdout });
  let observed: string;
  try { observed = await rl.question(`Type exactly: ${phrase}\n> `); } finally { rl.close(); }
  if (observed !== phrase) { console.log('Confirmation did not match. Reconciliation was not changed.'); return; }
  const status = await admin.reconcile({ attemptId: opts.attempt, outcome, reconciledBy: opts.by,
    note: opts.note, observedPhrase: observed });
  console.log(`Send attempt reconciled to ${status}.`);
  console.log('This command made no Gmail call and sent no email.');
}
