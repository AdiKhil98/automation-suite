import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../domain/outreach/followups.js';
import { isFollowupStep, isSequenceStep, lessonEmailLabel } from '../../domain/outreach/sequence.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { EnrollInputRepository } from '../../persistence/repositories/enroll-input.repo.js';
import { OutreachReadRepository } from '../../persistence/repositories/outreach.repo.js';
import { type CliContext } from '../context.js';

const DEFAULT_CAMPAIGN = 'Production Outreach';

function sequencePolicy(ctx: CliContext): SequencePolicy {
  return {
    step1DelayDays: ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS,
    step2DelayDays: ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS,
    step3DelayDays: ctx.config.OUTREACH_FOLLOWUP_3_DELAY_DAYS,
    dueHourLocal: ctx.config.OUTREACH_FOLLOWUP_DUE_HOUR_LOCAL,
  };
}

export type EnrollFromAttemptOutcome =
  | 'ENROLLED'
  | 'ALREADY_ENROLLED'
  | 'RECORD_NOT_ENROLLABLE'
  /** Durable provenance and outreach state disagree about the sequence step; nothing was written. */
  | 'STEP_MISMATCH'
  | 'REFUSED';

export interface EnrollFromAttemptResult {
  outcome: EnrollFromAttemptOutcome;
  reason?: string;
  recordId?: string;
  campaignId?: string;
  campaignName?: string;
  contact?: string;
  messageId?: string;
  contentHash?: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  /** The next follow-up's due instant, or undefined when the sequence is finished. */
  followupDueAt?: string;
  /** What this confirmed send represented: 0 = INITIAL, 1..3 = the internal follow-up step. */
  sequenceStep?: number;
  messageType?: 'INITIAL' | 'FOLLOW_UP';
  /** The record status after enrollment (INITIAL_SENT / FOLLOW_UP_n_SENT). */
  recordStatus?: string;
}

/**
 * Reusable core of the confirmed-send -> outreach bridge (NEVER sends; makes no provider call). It
 * reads the subject/body/recipient from the finalized send records and the Gmail ids from the
 * CONFIRMED send_attempt, then tracks + enrolls idempotently. The caller is responsible for the
 * `OUTREACH_TRACKING_ENABLED` gate. Used by both the CLI command and the automated runner.
 */
export async function enrollConfirmedSendFromAttempt(
  ctx: CliContext,
  opts: { lead: string; fromAttempt: string; campaign?: string; by?: string },
): Promise<EnrollFromAttemptResult> {
  const refused = (reason: string): EnrollFromAttemptResult => ({ outcome: 'REFUSED', reason });

  const input = await new EnrollInputRepository(ctx.db).load(opts.fromAttempt);
  if (!input) return refused(`send attempt ${opts.fromAttempt} not found, or it has no finalized draft`);
  if (input.leadId !== opts.lead) return refused(`attempt belongs to lead ${input.leadId}, not ${opts.lead}`);
  const confirmed = input.status === 'SENT_CONFIRMED' || input.reconciledOutcome === 'CONFIRMED_SENT';
  if (!confirmed) return refused(`attempt is not confirmed (status=${input.status}, reconciled=${input.reconciledOutcome ?? '-'})`);
  if (!input.providerMessageId || !input.providerThreadId) return refused('confirmed attempt is missing a Gmail message/thread id');
  if (!input.sentAt) return refused('confirmed attempt is missing a sent timestamp');
  if (input.attemptFinalizedContentHash !== input.resolvedBodyHash) return refused('finalized content hash does not match the attempt — content may have diverged');

  const read = new OutreachReadRepository(ctx.db);
  const service = new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));
  const campaignName = opts.campaign ?? DEFAULT_CAMPAIGN;
  let campaign = await read.getCampaignByName(campaignName);
  campaign ??= await read.insertCampaign({ name: campaignName, sequencePolicy: sequencePolicy(ctx), timezone: 'UTC' });

  const tracked = await service.track({
    campaignId: campaign.id, leadId: opts.lead, contactEmail: input.recipientEmail,
    timezone: campaign.timezone, owner: opts.by ?? null,
  });
  if (tracked.outcome === 'BLOCKED_DO_NOT_CONTACT' || !tracked.record) {
    return refused(`contact ${input.recipientEmail} is on do-not-contact`);
  }
  const record = tracked.record;
  const common = {
    campaignId: campaign.id,
    campaignName: campaign.name,
    contact: input.recipientEmail,
    gmailMessageId: input.providerMessageId,
    gmailThreadId: input.providerThreadId,
  };

  // ---- Route on DURABLE provenance, never on a heuristic. ----
  // `email_drafts.sequence_step` was written when the copy was composed and travels with the
  // attempt's own draft chain, so a recovery run days later (or after a crash/restart) knows
  // exactly what the confirmed send was. Pre-0044 rows are 0 and therefore INITIAL, which is
  // precisely what they were.
  const step = input.sequenceStep;
  if (step === 0) {
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
    return {
      ...common,
      outcome: result.outcome,
      recordId: result.record.id,
      messageId: result.message?.id,
      contentHash: result.message?.contentHash,
      followupDueAt: result.followup?.dueAt.toISOString(),
      sequenceStep: 0,
      messageType: 'INITIAL',
      recordStatus: result.record.status,
    };
  }

  if (!isFollowupStep(step)) {
    return refused(`draft ${input.emailDraftId} records an unknown sequence step ${String(step)}`);
  }
  // A follow-up must land on the record its copy was written for; enrolling it against a different
  // record would silently attach one contact's message to another's timeline.
  if (input.outreachRecordId !== null && input.outreachRecordId !== record.id) {
    return refused(`draft ${input.emailDraftId} belongs to outreach record ${input.outreachRecordId}, but the active record for ${input.recipientEmail} is ${record.id}`);
  }

  const result = await service.enrollConfirmedFollowup({
    outreachRecordId: record.id,
    expectedStep: step,
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
  return {
    ...common,
    outcome: result.outcome,
    reason: result.reason,
    recordId: result.record.id,
    messageId: result.message?.id,
    contentHash: result.message?.contentHash,
    followupDueAt: result.nextFollowup?.dueAt.toISOString(),
    sequenceStep: step,
    messageType: 'FOLLOW_UP',
    recordStatus: result.record.status,
  };
}

/**
 * Production-send -> outreach tracking bridge (reconciliation command; NEVER sends). Idempotent: a
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

  const r = await enrollConfirmedSendFromAttempt(ctx, opts);

  if (r.outcome === 'REFUSED') {
    console.log(`Refusing to enroll: ${r.reason}. No outreach record was changed.`);
    return;
  }
  if (r.outcome === 'ENROLLED') {
    const step = r.sequenceStep ?? 0;
    const label = isSequenceStep(step) ? lessonEmailLabel(step) : 'sequence email';
    console.log(`\n✅ ENROLLED — confirmed production send is now tracked in outreach (${label}).`);
    console.log(`  record:            ${r.recordId}  (lead ${opts.lead})`);
    console.log(`  campaign:          ${r.campaignName} (${r.campaignId})`);
    console.log(`  contact:           ${r.contact}`);
    console.log(`  message:           ${r.messageId ?? '-'}  sha256=${r.contentHash?.slice(0, 12) ?? '-'}…`);
    console.log(`  message type:      ${r.messageType ?? '-'} (internal sequence step ${String(r.sequenceStep ?? 0)})`);
    console.log(`  gmail message id:  ${r.gmailMessageId}`);
    console.log(`  gmail thread id:   ${r.gmailThreadId}`);
    console.log(`  record status:     ${r.recordStatus ?? '-'}`);
    console.log(r.followupDueAt === undefined
      ? '  next follow-up:    none — the sequence is complete; nothing further is scheduled.'
      : `  next follow-up:    ${r.followupDueAt}`);
    console.log('\nReply sync and bounce reconciliation now see this thread:');
    console.log('  pnpm cli outreach-sync-replies --confirm-gmail-read');
    console.log('  pnpm cli outreach-reconcile-delivery --confirm-gmail-read');
    return;
  }
  if (r.outcome === 'ALREADY_ENROLLED') {
    console.log(`\n↩️  ALREADY_ENROLLED — Gmail message ${r.gmailMessageId} is already tracked (record ${r.recordId}). Nothing changed.`);
    return;
  }
  if (r.outcome === 'STEP_MISMATCH') {
    console.log(`\n❌ STEP_MISMATCH — ${r.reason ?? 'provenance disagrees with the outreach state'}. Nothing changed; reconcile manually.`);
    return;
  }
  console.log(`\n❌ RECORD_NOT_ENROLLABLE — outreach record ${r.recordId} cannot enroll this send${r.reason ? ` (${r.reason})` : ''}. Nothing changed.`);
}
