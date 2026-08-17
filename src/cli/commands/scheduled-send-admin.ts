import {
  authorizationInvalidReasons,
  SCHEDULED_SEND_AUTH_MAX_DAYS,
  validateNewAuthorization,
} from '../../domain/send/scheduled-send-authorization.js';
import { ScheduledSendAuthorizationRepository } from '../../persistence/repositories/scheduled-send.repo.js';
import { type CliContext } from '../context.js';

const DAY_MS = 24 * 60 * 60_000;

function account(ctx: CliContext): string | null {
  return ctx.config.GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase() ?? null;
}

/**
 * Create the durable scheduled-send authorization (bounded ≤14 days, capped, policy-version bound).
 * This is the ONE deliberate human act that pre-authorizes AUTOMATED sending; it does not send,
 * schedule, or touch the manual send path. Superseded prior active authorization is revoked.
 */
export async function approveScheduledSendCommand(
  ctx: CliContext,
  opts: { by: string; days?: string; maxPerDay?: string; note?: string },
): Promise<void> {
  const gmailAccount = account(ctx);
  if (!gmailAccount) { console.log('GMAIL_ACCOUNT_EMAIL is not configured. No authorization created.'); return; }
  const policyVersion = ctx.config.SENDING_POLICY_VERSION;
  const days = opts.days ? Number(opts.days) : SCHEDULED_SEND_AUTH_MAX_DAYS;
  const maxPerDay = opts.maxPerDay ? Number(opts.maxPerDay) : ctx.config.SENDING_DAILY_CAP;
  if (!Number.isInteger(days) || days < 1 || days > SCHEDULED_SEND_AUTH_MAX_DAYS) {
    console.log(`--days must be an integer 1..${String(SCHEDULED_SEND_AUTH_MAX_DAYS)}. No authorization created.`); return;
  }
  const startsAtMs = Date.now();
  const expiresAtMs = startsAtMs + days * DAY_MS;
  const errors = validateNewAuthorization({ gmailAccount, policyVersion, createdBy: opts.by, startsAtMs, expiresAtMs, maxPerDay });
  if (errors.length > 0) { console.log(`Invalid authorization: ${errors.join(', ')}. No authorization created.`); return; }

  const repo = new ScheduledSendAuthorizationRepository(ctx.db);
  const row = await repo.create({
    gmailAccount, policyVersion, createdBy: opts.by.trim(),
    startsAt: new Date(startsAtMs), expiresAt: new Date(expiresAtMs),
    maxPerDay, note: opts.note?.trim() ?? null,
  });
  console.log('\n✅ Durable scheduled-send authorization created (no email sent):');
  console.log(`  id:          ${row.id}`);
  console.log(`  account:     ${row.gmailAccount}   policy: ${row.policyVersion}`);
  console.log(`  window:      ${row.startsAt.toISOString()} → ${row.expiresAt.toISOString()} (${String(days)}d)`);
  console.log(`  max/day:     ${String(row.maxPerDay)}`);
  console.log(`  created by:  ${row.createdBy}`);
  console.log('\nThe automated runner requires SCHEDULED_SEND_ENABLED=true + the global send gates + this authorization.');
  console.log(`Revoke any time: pnpm cli revoke-scheduled-send --id ${row.id} --by <op> --reason <text>`);
}

/** Revoke the durable authorization — instantly stops all automated sending. */
export async function revokeScheduledSendCommand(
  ctx: CliContext,
  opts: { id: string; by: string; reason: string },
): Promise<void> {
  const repo = new ScheduledSendAuthorizationRepository(ctx.db);
  const ok = await repo.revoke({ id: opts.id.trim(), revokedBy: opts.by.trim(), reason: opts.reason.trim(), revokedAt: new Date() });
  console.log(ok ? `Revoked scheduled-send authorization ${opts.id}. Automated sending is now blocked.` : 'No active authorization matched that id. Nothing changed.');
}

/** Show the latest authorization for the configured account/policy and whether it is usable now. */
export async function scheduledSendStatusCommand(ctx: CliContext): Promise<void> {
  const gmailAccount = account(ctx);
  if (!gmailAccount) { console.log('GMAIL_ACCOUNT_EMAIL is not configured.'); return; }
  const policyVersion = ctx.config.SENDING_POLICY_VERSION;
  const repo = new ScheduledSendAuthorizationRepository(ctx.db);
  const row = await repo.latest(gmailAccount, policyVersion);
  console.log('\nScheduled-send authorization status:');
  console.log(`  master switch:  SCHEDULED_SEND_ENABLED=${String(ctx.config.SCHEDULED_SEND_ENABLED)}`);
  console.log(`  send gates:     SENDING_ENABLED=${String(ctx.config.SENDING_ENABLED)} OUTBOUND_ACTIONS_ENABLED=${String(ctx.config.OUTBOUND_ACTIONS_ENABLED)} DRY_RUN=${String(ctx.config.DRY_RUN)} provider=${ctx.config.SENDING_PROVIDER}`);
  console.log(`  tracking:       OUTREACH_TRACKING_ENABLED=${String(ctx.config.OUTREACH_TRACKING_ENABLED)}`);
  if (!row) { console.log('  authorization:  NONE for this account/policy.'); return; }
  const now = Date.now();
  const reasons = row.revokedAt ? ['revoked'] : authorizationInvalidReasons(row, now, gmailAccount, policyVersion);
  console.log(`  authorization:  ${row.id}`);
  console.log(`    window:       ${row.startsAt.toISOString()} → ${row.expiresAt.toISOString()}`);
  console.log(`    max/day:      ${String(row.maxPerDay)}   created by: ${row.createdBy}`);
  console.log(`    usable now:   ${reasons.length === 0 ? 'YES' : `NO (${reasons.join(', ')})`}`);
}
