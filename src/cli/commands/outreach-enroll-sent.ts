import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../domain/outreach/followups.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { EnrollInputRepository } from '../../persistence/repositories/enroll-input.repo.js';
import { OutreachReadRepository } from '../../persistence/repositories/outreach.repo.js';
import { type CliContext } from '../context.js';

const DEFAULT_CAMPAIGN = 'Production Outreach';

function sequencePolicy(ctx: CliContext): SequencePolicy {
  return {
    step1DelayDays: ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS,
    step2DelayDays: ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS,
    dueHourLocal: ctx.config.OUTREACH_FOLLOWUP_DUE_HOUR_LOCAL,
  };
}

/**
 * Production-send -> outreach tracking bridge (reconciliation command; NEVER sends).
 *
 * AFTER a Phase 14/15 `SendService` send reaches SENT_CONFIRMED (or an OUTCOME_UNKNOWN attempt that
 * was manually reconciled to CONFIRMED_SENT), this enrolls that exact confirmed send into the
 * `outreach_*` tracking system so reply sync, bounce reconciliation, and follow-ups can see it.
 *
 * It calls no provider and reads the subject/body/recipient from the finalized send records and the
 * Gmail ids from the confirmed `send_attempt` — nothing is re-entered on the CLI. Idempotent: a
 * re-run returns ALREADY_ENROLLED and creates no duplicate message/transition/follow-up (backed by
 * the migration-0037 partial-unique index on the Gmail message id).
 */
export async function outreachEnrollSentCommand(
  ctx: CliContext,
  opts: { lead: string; fromAttempt: string; campaign?: string; by?: string; timezone?: string },
): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }

  const refuse = (reason: string): void => console.log(`Refusing to enroll: ${reason}. No outreach record was changed.`);

  // 1. Read the confirmed send inputs (subject/body/recipient from finalized records; Gmail ids from the attempt).
  const input = await new EnrollInputRepository(ctx.db).load(opts.fromAttempt);
  if (!input) {
    refuse(`send attempt ${opts.fromAttempt} not found, or it has no finalized draft`);
    return;
  }

  // 2. Fail-closed eligibility — only a genuinely confirmed send may be enrolled.
  if (input.leadId !== opts.lead) {
    refuse(`attempt belongs to lead ${input.leadId}, not ${opts.lead}`);
    return;
  }
  const confirmed = input.status === 'SENT_CONFIRMED' || input.reconciledOutcome === 'CONFIRMED_SENT';
  if (!confirmed) {
    refuse(`attempt is not confirmed (status=${input.status}, reconciled=${input.reconciledOutcome ?? '-'})`);
    return;
  }
  if (!input.providerMessageId || !input.providerThreadId) {
    refuse('confirmed attempt is missing a Gmail message/thread id');
    return;
  }
  if (!input.sentAt) {
    refuse('confirmed attempt is missing a sent timestamp');
    return;
  }
  if (input.attemptFinalizedContentHash !== input.resolvedBodyHash) {
    refuse('finalized content hash does not match the attempt — content may have diverged');
    return;
  }

  // 3. Resolve (or create) the campaign, then find-or-create the tracked record for the real lead.
  const read = new OutreachReadRepository(ctx.db);
  const service = new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));
  const campaignName = opts.campaign ?? DEFAULT_CAMPAIGN;
  const timezone = opts.timezone ?? 'UTC';
  let campaign = await read.getCampaignByName(campaignName);
  campaign ??= await read.insertCampaign({ name: campaignName, sequencePolicy: sequencePolicy(ctx), timezone });

  const tracked = await service.track({
    campaignId: campaign.id,
    leadId: opts.lead,
    contactEmail: input.recipientEmail,
    timezone: campaign.timezone,
    owner: opts.by ?? null,
  });
  if (tracked.outcome === 'BLOCKED_DO_NOT_CONTACT' || !tracked.record) {
    refuse(`contact ${input.recipientEmail} is on do-not-contact`);
    return;
  }
  const record = tracked.record;

  // 4. Atomic enrollment: INITIAL step-0 message + INITIAL_SENT + follow-up step 1 (idempotent).
  const result = await service.enrollConfirmedSend({
    outreachRecordId: record.id,
    subject: input.subject,
    body: input.body,
    gmailMessageId: input.providerMessageId,
    gmailThreadId: input.providerThreadId,
    sentAt: input.sentAt,
    emailDraftId: input.emailDraftId,
    finalizedEmailId: input.finalizedEmailId,
    sendAttemptId: input.attemptId,
    policy: sequencePolicy(ctx),
  });

  if (result.outcome === 'ENROLLED') {
    console.log('\n✅ ENROLLED — confirmed production send is now tracked in outreach.');
    console.log(`  record:            ${result.record.id}  (lead ${opts.lead})`);
    console.log(`  campaign:          ${campaign.name} (${campaign.id})`);
    console.log(`  contact:           ${input.recipientEmail}`);
    console.log(`  message:           ${result.message?.id ?? '-'}  sha256=${result.message?.contentHash.slice(0, 12) ?? '-'}…`);
    console.log(`  gmail message id:  ${input.providerMessageId}`);
    console.log(`  gmail thread id:   ${input.providerThreadId}`);
    console.log('  record status:     INITIAL_SENT');
    console.log(`  follow-up 1 due:   ${result.followup?.dueAt.toISOString() ?? '-'} (TRACKING ONLY; never auto-sent)`);
    console.log('\nReply sync and bounce reconciliation now see this thread:');
    console.log('  pnpm cli outreach-sync-replies --confirm-gmail-read');
    console.log('  pnpm cli outreach-reconcile-delivery --confirm-gmail-read');
    return;
  }
  if (result.outcome === 'ALREADY_ENROLLED') {
    console.log(`\n↩️  ALREADY_ENROLLED — Gmail message ${input.providerMessageId} is already tracked (record ${result.record.id}). Nothing changed.`);
    return;
  }
  console.log(`\n❌ RECORD_NOT_ENROLLABLE — outreach record ${result.record.id} is in status ${result.record.status} and cannot enroll this send. Nothing changed.`);
}
