import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { HttpGmailDraftProvider } from '../../integrations/gmail/http-gmail.js';
import { MockGmailDraftProvider } from '../../integrations/gmail/mock-gmail.js';
import { type GmailDraftProvider } from '../../integrations/gmail/provider.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { randomUUID } from 'node:crypto';
import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { computeFollowupDueUtc, type SequencePolicy } from '../../domain/outreach/followups.js';
import {
  normalizeEmail,
  OutreachSmokeSendService,
  reconcileCommand,
  type SmokeGuardConfig,
} from '../../domain/outreach/smoke-send.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { OutreachReadRepository } from '../../persistence/repositories/outreach.repo.js';
import { OutreachSmokeRepository } from '../../persistence/repositories/outreach-smoke.repo.js';
import { isValidTimeZone } from '../../domain/schedule/timezone.js';
import { buildSendProvider } from './send-build.js';
import { type CliContext } from '../context.js';

const CAMPAIGN_NAME = 'Phase 17B Smoke Test';
const SUGGESTED_SUBJECT = 'Automation Suite tracked-send test';
const SUGGESTED_BODY = [
  'Hi Adi,',
  '',
  'This is the controlled Automation Suite send test.',
  '',
  'It verifies that the email is sent from admin@scaleflow.it.com, stored with its exact content, connected to the correct Gmail thread, synchronized to the outreach dashboard, and prepared for read-only reply detection.',
  '',
  'No action is required unless you want to reply to test the tracking flow.',
  '',
  'Adi',
  'ScaleFlow',
].join('\n');

function sequencePolicy(ctx: CliContext): SequencePolicy {
  return {
    step1DelayDays: ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS,
    step2DelayDays: ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS,
    dueHourLocal: ctx.config.OUTREACH_FOLLOWUP_DUE_HOUR_LOCAL,
  };
}

function smokeGuardConfig(ctx: CliContext): SmokeGuardConfig {
  const c = ctx.config;
  return {
    smokeTestEnabled: c.OUTREACH_SMOKE_TEST_ENABLED,
    sendingEnabled: c.SENDING_ENABLED,
    outboundActionsEnabled: c.OUTBOUND_ACTIONS_ENABLED,
    dryRun: c.DRY_RUN,
    providerIsHttp: c.SENDING_PROVIDER === 'http',
    sender: c.GMAIL_ACCOUNT_EMAIL ?? null,
    allowedRecipient: c.OUTREACH_SMOKE_TEST_RECIPIENT ?? null,
    approvalTtlMs: c.OUTREACH_APPROVAL_TTL_MINUTES * 60_000,
  };
}

/**
 * Build the smoke-test Gmail DRAFT provider. Mock unless SENDING_PROVIDER=http; the http provider
 * reuses the EXISTING compose credential file (GMAIL_CREDENTIALS_FILE) — no new OAuth, no new scope.
 */
function buildSmokeDraftProvider(ctx: CliContext): GmailDraftProvider {
  const c = ctx.config;
  if (c.SENDING_PROVIDER !== 'http') return new MockGmailDraftProvider(c.GMAIL_ACCOUNT_EMAIL ?? 'mock@example.com');
  const client = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  const store = new LocalGmailTokenStore(c.GMAIL_CREDENTIALS_FILE);
  if (!client || !store.exists() || !c.GMAIL_ACCOUNT_EMAIL) {
    throw new Error('HTTP Gmail draft creation is not credential-ready; existing client, stored credentials, and configured account are required. OAuth authorization was not started.');
  }
  const oauth = new GoogleOAuthClient({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  return new HttpGmailDraftProvider({ tokens: new OAuthAccessTokenProvider(oauth, store), logger: ctx.logger, timeoutMs: c.GMAIL_TIMEOUT_MS });
}

function buildSmokeService(ctx: CliContext): OutreachSmokeSendService {
  return new OutreachSmokeSendService({
    draftProvider: buildSmokeDraftProvider(ctx),
    sendProvider: buildSendProvider(ctx),
    store: new OutreachSmokeRepository(ctx.db),
    config: smokeGuardConfig(ctx),
    senderName: ctx.config.GMAIL_SENDER_NAME ?? 'ScaleFlow',
    sequencePolicy: sequencePolicy(ctx),
    logger: ctx.logger,
  });
}

/**
 * Phase 17B: create the ONE synthetic, clearly-marked controlled test record — campaign, synthetic
 * internal lead, outreach record, and the immutable INITIAL step-0 message — then move it to
 * AWAITING_APPROVAL. Never sends. Idempotent-ish: refuses to duplicate an active test record.
 */
export async function outreachSmokeInitCommand(
  ctx: CliContext,
  opts: { subject?: string; body?: string; timezone?: string; owner?: string },
): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }
  const recipient = normalizeEmail(ctx.config.OUTREACH_SMOKE_TEST_RECIPIENT);
  if (!recipient) {
    console.log('OUTREACH_SMOKE_TEST_RECIPIENT is not configured. Set it to the allowlisted test inbox first.');
    return;
  }
  const timezone = opts.timezone ?? 'UTC';
  if (!isValidTimeZone(timezone)) {
    console.log(`Invalid timezone: ${timezone}`);
    return;
  }

  const read = new OutreachReadRepository(ctx.db);
  const service = new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));

  // Campaign (create once).
  let campaign = await read.getCampaignByName(CAMPAIGN_NAME);
  campaign ??= await read.insertCampaign({ name: CAMPAIGN_NAME, sequencePolicy: sequencePolicy(ctx), timezone });
  console.log(`Campaign: ${campaign.name} (${campaign.id})`);

  // Synthetic internal test lead (never a real prospect).
  const lead = await ctx.service.createLead({
    businessName: 'Phase 17B Smoke Test Lead (synthetic, internal)',
    source: 'smoke-test',
  });
  console.log(`Synthetic lead: ${lead.id}`);

  // Tracked record for (campaign, synthetic lead, allowlisted contact).
  const tracked = await service.track({ campaignId: campaign.id, leadId: lead.id, contactEmail: recipient, timezone, owner: opts.owner ?? 'operator' });
  if (tracked.outcome !== 'CREATED' || !tracked.record) {
    console.log(`Could not create tracked record: ${tracked.outcome}. No action taken.`);
    return;
  }
  const record = tracked.record;

  // Immutable INITIAL step-0 message (approval is recorded separately via outreach-smoke-approve).
  const subject = opts.subject ?? SUGGESTED_SUBJECT;
  const body = opts.body ?? SUGGESTED_BODY;
  const msg = await service.recordMessage({
    outreachRecordId: record.id,
    messageType: 'INITIAL',
    sequenceStep: 0,
    subject,
    body,
    approvedAt: null,
    sentAt: null,
  });

  // Move to AWAITING_APPROVAL (human approval is the next explicit step).
  await service.transition(record.id, 'AWAITING_APPROVAL', { reason: 'phase_17b_smoke_test' });

  console.log(`\nControlled test record created (status=AWAITING_APPROVAL):`);
  console.log(`  record:  ${record.id}`);
  console.log(`  message: ${msg.id}  sha256=${msg.contentHash}`);
  console.log(`  subject: ${subject}`);
  console.log(`  contact: ${recipient}`);
  console.log(`\nNext: pnpm cli outreach-smoke-approve --record ${record.id} --by <operator>`);
}

/** Phase 17B: record the human approval and move the record to APPROVED_TO_SEND. Never sends. */
export async function outreachSmokeApproveCommand(ctx: CliContext, opts: { record: string; by: string }): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }
  const repo = new OutreachSmokeRepository(ctx.db);
  const ctxData = await repo.load(opts.record);
  if (!ctxData) {
    console.log(`Outreach record not found: ${opts.record}`);
    return;
  }
  if (!ctxData.message) {
    console.log('No INITIAL step-0 message stored for this record. Run outreach-smoke-init first.');
    return;
  }
  try {
    await repo.approve(opts.record, ctxData.message.id, opts.by.trim());
    console.log(`Approved record ${opts.record} -> APPROVED_TO_SEND by ${opts.by}.`);
    console.log(`Human approval is valid for ${String(ctx.config.OUTREACH_APPROVAL_TTL_MINUTES)} minutes.`);
    console.log('\nThe one real send is intentionally a separate, explicitly-gated command (see docs/OPERATIONS.md).');
  } catch (err) {
    console.log(`Approval rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Phase 17B: perform EXACTLY ONE controlled, allowlisted send. Fail-closed on every guard. This is
 * the only command that can dispatch mail, and only when ALL of these hold: OUTREACH_SMOKE_TEST_ENABLED=true,
 * SENDING_ENABLED=true, OUTBOUND_ACTIONS_ENABLED=true, DRY_RUN=false, SENDING_PROVIDER=http,
 * --confirm-phase-17b, exact --sender, allowlisted --recipient, and a valid unexpired approval.
 */
export async function outreachSmokeSendCommand(
  ctx: CliContext,
  opts: { record: string; sender: string; recipient: string; provider?: string; confirmPhase17b?: boolean },
): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }
  // The provider must be explicitly named on the command line AND selected in config.
  if ((opts.provider ?? '') !== 'http') {
    console.log('Refusing: pass --provider http (and set SENDING_PROVIDER=http) to perform a real send.');
    return;
  }
  const recipient = opts.recipient.trim();
  const service = buildSmokeService(ctx);
  const result = await service.send({
    recordId: opts.record,
    confirmPhase17b: opts.confirmPhase17b === true,
    sender: opts.sender.trim(),
    recipient,
    recipients: [recipient],
    cc: [],
    bcc: [],
  });

  if (result.outcome === 'SENT') {
    console.log(`\n✅ SENT (Phase 17B controlled smoke test)`);
    console.log(`  record:            ${result.recordId}`);
    console.log(`  message:           ${result.messageId ?? '-'}`);
    console.log(`  gmail message id:  ${result.providerMessageId ?? '-'}`);
    console.log(`  gmail thread id:   ${result.providerThreadId ?? '-'}`);
    console.log('  record status:     INITIAL_SENT (follow-up armed for TRACKING ONLY; never auto-sent)');
    console.log('\nSync the operator dashboard:  pnpm cli outreach-sync-sheet --confirm-sheet-write');
    console.log('Then verify Outreach + Messages rows exist for this record.');
    return;
  }
  console.log(`\n❌ NOT SENT — outcome=${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
  if (result.outcome === 'PERSISTENCE_FAILED_AFTER_SEND') {
    console.log('\n⚠️  The provider CONFIRMED the send but the database write failed. Do NOT re-run the send.');
    console.log(`  gmail message id:  ${result.providerMessageId ?? '-'}`);
    console.log(`  gmail thread id:   ${result.providerThreadId ?? '-'}`);
    console.log('  Reconcile idempotently (records the ids WITHOUT sending):');
    console.log(`    ${result.recoveryCommand ?? ''}`);
  } else if (result.outcome === 'SEND_OUTCOME_UNKNOWN') {
    console.log('\n⚠️  The send outcome is UNKNOWN. Do NOT re-run the send. Confirm in Gmail whether it was sent.');
    console.log('  If it WAS sent, reconcile with the real ids:');
    console.log(`    ${reconcileCommand(result.recordId, null, null)}`);
  }
}

/**
 * Phase 17B recovery ONLY: attach a provider message/thread id to the record WITHOUT sending. Used
 * when the provider confirmed a send but persistence failed (or the outcome was later confirmed in
 * Gmail). Idempotent — refuses if the message already has a recorded send. Never calls Gmail.
 */
export async function outreachSmokeReconcileCommand(
  ctx: CliContext,
  opts: { record: string; gmailMessageId: string; gmailThreadId: string },
): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }
  const repo = new OutreachSmokeRepository(ctx.db);
  const data = await repo.load(opts.record);
  if (!data || !data.message) {
    console.log(`No INITIAL step-0 message for record ${opts.record}. Nothing to reconcile.`);
    return;
  }
  if (data.message.sentAt !== null || data.message.gmailMessageId !== null) {
    console.log('Message already has a recorded send. Nothing to reconcile (idempotent).');
    return;
  }
  if (data.record.status !== 'APPROVED_TO_SEND') {
    console.log(`Record status must be APPROVED_TO_SEND to reconcile (is ${data.record.status}). No action taken.`);
    return;
  }
  const sentAt = new Date();
  const dueAt = computeFollowupDueUtc({ previousSentAtMs: sentAt.getTime(), step: 1, timezone: data.record.timezone, policy: sequencePolicy(ctx) });
  try {
    await repo.recordSend({
      recordId: opts.record,
      messageId: data.message.id,
      fromStatus: 'APPROVED_TO_SEND',
      gmailMessageId: opts.gmailMessageId.trim(),
      gmailThreadId: opts.gmailThreadId.trim(),
      sentAt,
      providerMessageId: opts.gmailMessageId.trim(),
      followup: { id: randomUUID(), step: 1, dueAt, timezone: data.record.timezone },
    });
    console.log(`Reconciled record ${opts.record} -> INITIAL_SENT (no send performed).`);
  } catch (err) {
    console.log(`Reconcile rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}
