import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../domain/outreach/followups.js';
import { buildAllTabs, syncSheet } from '../../domain/outreach/sheet-sync.js';
import { runReplySync } from '../../domain/outreach/reply-sync.js';
import { overdueDays } from '../../domain/outreach/followups.js';
import { MockGmailThreadReader } from '../../integrations/gmail/mock-reply-provider.js';
import { HttpGmailThreadReader, liveReplyReadGate } from '../../integrations/gmail/http-reply-provider.js';
import { type GmailThreadReader } from '../../integrations/gmail/reply-provider.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { MockSheetsProvider } from '../../integrations/google/sheets/mock-sheets.js';
import { HttpSheetsProvider } from '../../integrations/google/sheets/http-sheets.js';
import { type SheetsProvider } from '../../integrations/google/sheets/provider.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { OutreachReadRepository } from '../../persistence/repositories/outreach.repo.js';
import { isValidTimeZone } from '../../domain/schedule/timezone.js';
import { type CliContext } from '../context.js';

/** Build the operator sequence policy from validated config. */
function sequencePolicy(ctx: CliContext): SequencePolicy {
  return {
    step1DelayDays: ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS,
    step2DelayDays: ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS,
    dueHourLocal: ctx.config.OUTREACH_FOLLOWUP_DUE_HOUR_LOCAL,
  };
}

function service(ctx: CliContext): OutreachService {
  return new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));
}

function requireEnabled(ctx: CliContext): boolean {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return false;
  }
  return true;
}

/** initialize or verify outreach tracking; optionally create a campaign. */
export async function outreachInitCommand(
  ctx: CliContext,
  opts: { createCampaign?: string; timezone?: string },
): Promise<void> {
  // Verify the tracking tables exist (fails clearly if the migration is unapplied).
  const read = new OutreachReadRepository(ctx.db);
  try {
    await read.projection();
  } catch (err) {
    console.log('Outreach tracking tables not reachable — run `pnpm db:migrate` first.');
    console.log(`  detail: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.log('Outreach tracking tables present and reachable.');
  console.log(`  OUTREACH_TRACKING_ENABLED = ${String(ctx.config.OUTREACH_TRACKING_ENABLED)}`);
  console.log(`  GMAIL_REPLY_SYNC_ENABLED  = ${String(ctx.config.GMAIL_REPLY_SYNC_ENABLED)}`);
  console.log(`  GOOGLE_SHEETS_SYNC_ENABLED= ${String(ctx.config.GOOGLE_SHEETS_SYNC_ENABLED)} (provider=${ctx.config.GOOGLE_SHEETS_PROVIDER})`);
  console.log(`  sending stays disabled: SENDING_ENABLED=${String(ctx.config.SENDING_ENABLED)} OUTBOUND_ACTIONS_ENABLED=${String(ctx.config.OUTBOUND_ACTIONS_ENABLED)}`);

  if (opts.createCampaign) {
    const timezone = opts.timezone ?? 'UTC';
    if (!isValidTimeZone(timezone)) {
      console.log(`Invalid timezone: ${timezone}`);
      return;
    }
    const existing = await read.getCampaignByName(opts.createCampaign);
    if (existing) {
      console.log(`Campaign already exists: ${opts.createCampaign} (${existing.id})`);
      return;
    }
    const campaign = await read.insertCampaign({
      name: opts.createCampaign,
      sequencePolicy: sequencePolicy(ctx),
      timezone,
    });
    console.log(`Created campaign: ${campaign.name} (${campaign.id}) tz=${timezone}`);
  }
}

/** create a tracked outreach record for (campaign, lead, contact). */
export async function outreachTrackCommand(
  ctx: CliContext,
  opts: { campaign: string; lead: string; contact: string; timezone?: string; owner?: string },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  const read = new OutreachReadRepository(ctx.db);
  const campaign = await read.getCampaignByName(opts.campaign);
  if (!campaign) {
    console.log(`Campaign not found: ${opts.campaign}. Create it with outreach-init --create-campaign.`);
    return;
  }
  const timezone = opts.timezone ?? campaign.timezone;
  if (!isValidTimeZone(timezone)) {
    console.log(`Invalid timezone: ${timezone}`);
    return;
  }
  const result = await service(ctx).track({
    campaignId: campaign.id,
    leadId: opts.lead,
    contactEmail: opts.contact,
    timezone,
    owner: opts.owner ?? null,
  });
  switch (result.outcome) {
    case 'CREATED':
      console.log(`Tracked: ${result.record?.id} (${opts.contact}) status=DRAFT_READY`);
      break;
    case 'DUPLICATE_ACTIVE':
      console.log(`Duplicate active outreach already exists: ${result.record?.id}. No new record created.`);
      break;
    case 'BLOCKED_DO_NOT_CONTACT':
      console.log(`Blocked: ${opts.contact} is on do-not-contact. No record created.`);
      break;
  }
}

/** record an immutable message snapshot (exact subject + body). */
export async function outreachRecordMessageCommand(
  ctx: CliContext,
  opts: {
    record: string;
    type: string;
    step: string;
    subject: string;
    body: string;
    gmailMessageId?: string;
    gmailThreadId?: string;
    sent?: boolean;
  },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  const messageType = opts.type === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'INITIAL';
  const now = new Date();
  const msg = await service(ctx).recordMessage({
    outreachRecordId: opts.record,
    messageType,
    sequenceStep: Number(opts.step),
    subject: opts.subject,
    body: opts.body,
    gmailMessageId: opts.gmailMessageId ?? null,
    gmailThreadId: opts.gmailThreadId ?? null,
    approvedAt: now,
    sentAt: opts.sent ? now : null,
  });
  console.log(`Recorded ${messageType} message ${msg.id} sha256=${msg.contentHash.slice(0, 12)}… sent=${String(!!opts.sent)}`);
}

/** transition an outreach record's status (records + validates; never sends). */
export async function outreachTransitionCommand(
  ctx: CliContext,
  opts: { record: string; to: string; reason?: string },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  try {
    const rec = await service(ctx).transition(opts.record, opts.to as never, {
      reason: opts.reason,
      setOutcome: true,
    });
    console.log(`Transitioned ${opts.record} -> ${rec.status}`);
  } catch (err) {
    console.log(`Transition rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** schedule a follow-up due date (calculation + persistence only; never sends). */
export async function outreachScheduleFollowupCommand(
  ctx: CliContext,
  opts: { record: string; step: string },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  const step = Number(opts.step) === 2 ? 2 : 1;
  const r = await service(ctx).scheduleFollowup(opts.record, step, sequencePolicy(ctx));
  if (r.outcome === 'SCHEDULED') console.log(`Follow-up ${String(step)} due ${r.followup?.dueAt.toISOString() ?? ''}`);
  else console.log(`Follow-up not scheduled: ${r.reason ?? 'BLOCKED'}`);
}

/** cancel a pending follow-up. */
export async function outreachCancelFollowupCommand(
  ctx: CliContext,
  opts: { followup: string; record: string; reason?: string },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  await service(ctx).cancelFollowup(opts.followup, opts.record, opts.reason ?? 'operator_cancelled');
  console.log(`Cancelled follow-up ${opts.followup}`);
}

/** postpone a pending follow-up to a new explicit due instant. */
export async function outreachPostponeFollowupCommand(
  ctx: CliContext,
  opts: { followup: string; record: string; at: string; reason?: string },
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  const at = new Date(opts.at);
  if (Number.isNaN(at.getTime())) {
    console.log(`Invalid --at instant: ${opts.at}`);
    return;
  }
  await service(ctx).postponeFollowup(opts.followup, opts.record, at, opts.reason ?? 'operator_postponed');
  console.log(`Postponed follow-up ${opts.followup} to ${at.toISOString()}`);
}

/** list follow-ups due — never sends. */
export async function outreachFollowupsDueCommand(ctx: CliContext): Promise<void> {
  const read = new OutreachReadRepository(ctx.db);
  const projection = await read.projection();
  const now = Date.now();
  const due = projection.followupsDue.filter((f) => f.dueAt.getTime() <= now);
  console.log(`\nFollow-ups due: ${due.length} (read-only — Phase 17A NEVER sends)\n`);
  for (const f of due) {
    console.log(`  ${f.business ?? '(unnamed)'} <${f.contactEmail}> step ${String(f.step)}`);
    console.log(`    due ${f.dueAt.toISOString()}  overdue ${String(overdueDays(f.dueAt.getTime(), now))}d  approval=${f.humanApprovalStatus}${f.blockedReason ? `  blocked=${f.blockedReason}` : ''}`);
  }
  if (due.length === 0) console.log('  (none)');
}

/**
 * Build the guarded LIVE read-only Gmail reader. Returns a fail-closed reason instead of a
 * reader unless BOTH gates are satisfied: GMAIL_REPLY_SYNC_ENABLED=true AND --confirm-gmail-read.
 * The reader uses the SEPARATE readonly credential; a compose/send credential can never reach it.
 */
async function buildLiveReader(
  ctx: CliContext,
  confirmGmailRead: boolean,
): Promise<{ reader: HttpGmailThreadReader } | { refused: string }> {
  const gate = liveReplyReadGate({ syncEnabled: ctx.config.GMAIL_REPLY_SYNC_ENABLED, confirmed: confirmGmailRead });
  if (!gate.ok) return { refused: gate.reason ?? 'live Gmail read refused.' };
  const c = ctx.config;
  const clientCreds = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  if (!clientCreds) {
    return { refused: `no OAuth client credentials — save the Google Cloud client JSON to ${c.GMAIL_OAUTH_CLIENT_FILE} (or set GMAIL_OAUTH_CLIENT_ID/SECRET).` };
  }
  const oauth = new GoogleOAuthClient({ clientId: clientCreds.clientId, clientSecret: clientCreds.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const store = new LocalGmailTokenStore(c.GMAIL_READ_CREDENTIALS_FILE);
  const tokens = new OAuthAccessTokenProvider(oauth, store);
  const reader = new HttpGmailThreadReader({ tokens, store, logger: ctx.logger, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const check = await reader.verifyReadAccess();
  if (!check.ok) return { refused: check.reason ?? 'read-only access precondition failed.' };
  return { reader };
}

/**
 * synchronize Gmail replies — STRICTLY READ-ONLY. Mock reader by default. A LIVE read-only reader
 * runs ONLY when GMAIL_REPLY_SYNC_ENABLED=true AND --confirm-gmail-read are BOTH present; even then
 * it only ever reads the specific tracked thread ids (optionally narrowed by --record/--campaign).
 * Nothing here sends, drafts, labels, archives, or modifies Gmail.
 */
export async function outreachSyncRepliesCommand(
  ctx: CliContext,
  opts: { confirmGmailRead?: boolean; record?: string; campaign?: string } = {},
): Promise<void> {
  if (!requireEnabled(ctx)) return;
  const read = new OutreachReadRepository(ctx.db);

  // Resolve an optional campaign-name filter to its id (fail-closed if it does not exist).
  let campaignId: string | undefined;
  if (opts.campaign) {
    const campaign = await read.getCampaignByName(opts.campaign);
    if (!campaign) {
      console.log(`Campaign not found: ${opts.campaign}. No action taken.`);
      return;
    }
    campaignId = campaign.id;
  }

  // Choose the reader. Live reading is doubly gated; anything short of both gates falls back to
  // the mock reader (default-safe) and prints exactly why the live path was not taken.
  let reader: GmailThreadReader = new MockGmailThreadReader();
  const wantsLive = ctx.config.GMAIL_REPLY_SYNC_ENABLED || opts.confirmGmailRead;
  if (wantsLive) {
    const live = await buildLiveReader(ctx, opts.confirmGmailRead === true);
    if ('reader' in live) {
      reader = live.reader;
    } else {
      console.log(`Live Gmail read not enabled: ${live.refused}`);
      console.log('Falling back to the read-only mock reader (no external Gmail access).');
    }
  }

  const threads = await read.trackedThreads({ recordId: opts.record, campaignId });
  if (threads.length === 0) {
    console.log('No tracked threads match the selection (need an outbound message with a Gmail thread id). No action taken.');
    return;
  }
  const ownEmails = [ctx.config.GMAIL_ACCOUNT_EMAIL].filter((x): x is string => !!x);
  const report = await runReplySync({ reader, service: service(ctx), threads, ownEmails });
  console.log(`\nReply sync (reader=${report.reader}, external=${String(report.readExternally)}): checked ${String(report.threadsChecked)} threads, applied ${String(report.repliesApplied.length)} replies.`);
  for (const r of report.repliesApplied) {
    console.log(`  ${r.threadId}: ${r.classification} from ${r.fromEmail}`);
  }
  if (!report.readExternally) {
    console.log('Note: mock reader used — no live Gmail access occurred. Enable GMAIL_REPLY_SYNC_ENABLED=true and pass --confirm-gmail-read (after `gmail-read-auth`) for a live read-only sync.');
  }
}

function buildSheetsProvider(ctx: CliContext): SheetsProvider {
  if (ctx.config.GOOGLE_SHEETS_PROVIDER === 'http') {
    return new HttpSheetsProvider(ctx.config.GOOGLE_SHEETS_SPREADSHEET_ID);
  }
  return new MockSheetsProvider();
}

/** synchronize the Google Sheet projection. Real writes require --confirm + flag. */
export async function outreachSyncSheetCommand(ctx: CliContext, opts: { confirm?: boolean }): Promise<void> {
  const read = new OutreachReadRepository(ctx.db);
  const projection = await read.projection();
  const snapshots = buildAllTabs(projection, Date.now());

  const provider = buildSheetsProvider(ctx);
  const wantsExternal = provider.writesExternally;
  if (wantsExternal && !(ctx.config.GOOGLE_SHEETS_SYNC_ENABLED && opts.confirm)) {
    console.log('Refusing external Sheet write: requires GOOGLE_SHEETS_SYNC_ENABLED=true AND --confirm. No write performed.');
    return;
  }
  const report = await syncSheet(provider, snapshots);
  console.log(`\nSheet sync (provider=${report.provider}, external=${String(report.wroteExternally)}):`);
  for (const t of report.perTab) {
    console.log(`  ${t.tab}: +${String(t.counts.inserted)} ~${String(t.counts.updated)} =${String(t.counts.unchanged)} -${String(t.counts.deleted)}`);
  }
  console.log(`  totals: inserted=${String(report.totals.inserted)} updated=${String(report.totals.updated)} unchanged=${String(report.totals.unchanged)} deleted=${String(report.totals.deleted)}`);
}

/** show one record's (or lead's) complete outreach timeline. */
export async function outreachTimelineCommand(ctx: CliContext, opts: { record: string }): Promise<void> {
  const read = new OutreachReadRepository(ctx.db);
  const rec = await read.getRecordById(opts.record);
  if (!rec) {
    console.log(`Outreach record not found: ${opts.record}`);
    return;
  }
  console.log(`\nOutreach ${rec.id}  lead=${rec.leadId}  <${rec.contactEmail}>  status=${rec.status}  step=${String(rec.sequenceStep)}`);
  console.log(`  lastSent=${rec.lastSentAt?.toISOString() ?? '-'}  nextFollowup=${rec.nextFollowupAt?.toISOString() ?? '-'}  lastReply=${rec.lastReplyAt?.toISOString() ?? '-'}  DNC=${String(rec.doNotContact)}`);
  const events = await read.timeline(opts.record);
  console.log(`\n  Timeline (${String(events.length)} events):`);
  for (const e of events) {
    console.log(`   #${String(e.seq)} ${e.createdAt.toISOString()} ${e.type} ${e.message}`);
  }
  const messages = await read.messagesForRecord(opts.record);
  console.log(`\n  Messages (${String(messages.length)}):`);
  for (const m of messages) {
    console.log(`   ${m.messageType} step ${String(m.sequenceStep)} "${m.subject}" sha256=${m.contentHash.slice(0, 12)}… sent=${m.sentAt?.toISOString() ?? '-'} gmailMsg=${m.gmailMessageId ?? '-'}`);
  }
}

/** readiness check before the first controlled send — NEVER sends. */
export async function outreachReadinessCommand(ctx: CliContext): Promise<void> {
  const read = new OutreachReadRepository(ctx.db);
  const lines: string[] = [];
  const mark = (ok: boolean, label: string, detail = ''): void => {
    lines.push(`  [${ok ? 'PASS' : 'WARN'}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  let reachable = true;
  let projection;
  try {
    projection = await read.projection();
  } catch (err) {
    reachable = false;
    lines.push(`  [FAIL] migrations applied / database reachable — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (reachable && projection) {
    mark(true, 'migrations applied & database reachable');
    mark(ctx.config.OUTREACH_TRACKING_ENABLED, 'outreach tracking enabled', `OUTREACH_TRACKING_ENABLED=${String(ctx.config.OUTREACH_TRACKING_ENABLED)}`);
    mark(
      ctx.config.GOOGLE_SHEETS_PROVIDER === 'mock' || !!ctx.config.GOOGLE_SHEETS_SPREADSHEET_ID,
      'Google Sheet configured',
      `provider=${ctx.config.GOOGLE_SHEETS_PROVIDER}`,
    );
    mark(ctx.config.GMAIL_REPLY_SYNC_ENABLED, 'Gmail read access configured', `GMAIL_REPLY_SYNC_ENABLED=${String(ctx.config.GMAIL_REPLY_SYNC_ENABLED)} (mock reader used in 17A)`);

    // No duplicate active outreach (defensive; the partial-unique index guarantees it).
    const active = projection.outreach.filter(
      (o) => !['UNSUBSCRIBED', 'DO_NOT_CONTACT', 'CLOSED_WON', 'CLOSED_LOST'].includes(o.status),
    );
    const keys = active.map((o) => `${o.campaign}|${o.contactEmail}`);
    const dupActive = keys.length !== new Set(keys).size;
    mark(!dupActive, 'no duplicate active outreach');

    // Do-not-contact conflicts: an active record whose contact is DNC elsewhere.
    const dncContacts = new Set(projection.outreach.filter((o) => o.doNotContact).map((o) => o.contactEmail));
    const conflict = active.some((o) => dncContacts.has(o.contactEmail) && !o.doNotContact);
    mark(!conflict, 'no do-not-contact conflict');

    // Exact subject/body stored for records ready to send.
    const messageRecordIds = new Set(projection.messages.map((m) => m.contactEmail + '|' + m.campaign));
    const readyMissingBody = projection.outreach
      .filter((o) => o.status === 'APPROVED_TO_SEND')
      .filter((o) => !messageRecordIds.has(o.contactEmail + '|' + o.campaign));
    mark(readyMissingBody.length === 0, 'exact email subject/body stored for approved records', `${String(readyMissingBody.length)} missing`);

    mark(true, 'human approval represented by APPROVED_TO_SEND state (human-driven)');
    mark(
      ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS > 0 && ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS > 0,
      'follow-up policy configured',
      `step1=${String(ctx.config.OUTREACH_FOLLOWUP_1_DELAY_DAYS)}d step2=${String(ctx.config.OUTREACH_FOLLOWUP_2_DELAY_DAYS)}d`,
    );
  }

  const sendingDisabled = !ctx.config.SENDING_ENABLED && !ctx.config.OUTBOUND_ACTIONS_ENABLED && ctx.config.DRY_RUN;
  lines.push(`  [${sendingDisabled ? 'PASS' : 'FAIL'}] sending remains disabled during Phase 17A — SENDING_ENABLED=${String(ctx.config.SENDING_ENABLED)} OUTBOUND_ACTIONS_ENABLED=${String(ctx.config.OUTBOUND_ACTIONS_ENABLED)} DRY_RUN=${String(ctx.config.DRY_RUN)}`);

  console.log('\nOutreach readiness (Phase 17A — reports only; sends nothing):\n');
  for (const l of lines) console.log(l);
  console.log('\nPhase 17B (Controlled First Send Smoke Test) is NOT approved. This check performs no send.');
}
