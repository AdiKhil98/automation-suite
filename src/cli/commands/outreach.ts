import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../domain/outreach/followups.js';
import { buildAllTabs, OUTREACH_TABS, syncSheet } from '../../domain/outreach/sheet-sync.js';
import { runReplySync } from '../../domain/outreach/reply-sync.js';
import { overdueDays } from '../../domain/outreach/followups.js';
import { MockGmailThreadReader } from '../../integrations/gmail/mock-reply-provider.js';
import { HttpGmailThreadReader, liveReplyReadGate, selectReplyReader } from '../../integrations/gmail/http-reply-provider.js';
import { type GmailThreadReader } from '../../integrations/gmail/reply-provider.js';
import { AppError } from '../../utils/errors.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { MockSheetsProvider } from '../../integrations/google/sheets/mock-sheets.js';
import { GOOGLE_SHEETS_SCOPE, HttpSheetsProvider } from '../../integrations/google/sheets/http-sheets.js';
import { type SheetTabSnapshot } from '../../integrations/google/sheets/provider.js';
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
 * synchronize Gmail replies — STRICTLY READ-ONLY. Nothing here sends, drafts, labels, archives, or
 * modifies Gmail.
 *
 * Reader selection is FAIL-CLOSED (Phase 17A3):
 *  - LIVE is selected whenever GMAIL_REPLY_SYNC_ENABLED=true OR --confirm-gmail-read is passed. Once
 *    live is selected, EVERY live guard (both gates, present readonly credential, exact readonly
 *    scope) must pass; if any fails the command throws (nonzero exit) — it NEVER downgrades to mock.
 *  - The mock reader runs ONLY when it is explicitly selected with --mock.
 *  - Selecting neither (or both) is refused with a nonzero exit, so nothing runs by accident.
 * A live read only ever reads the specific tracked thread ids (optionally narrowed by --record/--campaign).
 */
export async function outreachSyncRepliesCommand(
  ctx: CliContext,
  opts: { confirmGmailRead?: boolean; mock?: boolean; record?: string; campaign?: string } = {},
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

  // Deterministic reader selection. A live request that cannot satisfy every guard throws instead
  // of silently falling back to mock; mock runs only when explicitly selected.
  const selection = selectReplyReader({
    syncEnabled: ctx.config.GMAIL_REPLY_SYNC_ENABLED,
    confirmed: opts.confirmGmailRead === true,
    mock: opts.mock === true,
  });
  if (selection.kind === 'refuse') {
    throw new AppError('GMAIL_READ_REFUSED', selection.reason);
  }
  let reader: GmailThreadReader;
  if (selection.kind === 'live') {
    const live = await buildLiveReader(ctx, opts.confirmGmailRead === true);
    if ('refused' in live) {
      // Live was explicitly requested but a guard failed. Exit nonzero — never fall back to mock.
      throw new AppError('GMAIL_READ_REFUSED', `Live Gmail read refused: ${live.refused}`);
    }
    reader = live.reader;
  } else {
    reader = new MockGmailThreadReader();
    console.log('Using the OFFLINE mock reader (--mock): no external Gmail access occurs.');
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
    console.log('Note: mock reader explicitly selected — no live Gmail access occurred. Enable GMAIL_REPLY_SYNC_ENABLED=true and pass --confirm-gmail-read (after `gmail-read-auth`) for a live read-only sync.');
  }
}

/**
 * Build the REAL Google Sheets provider. Reuses the existing Google OAuth loopback pattern, but with
 * a SEPARATE 0600 credential file (GOOGLE_SHEETS_CREDENTIALS_FILE) and the minimum Sheets scope — no
 * Gmail credential is read or touched.
 */
function buildHttpSheetsProvider(ctx: CliContext): HttpSheetsProvider {
  const c = ctx.config;
  const clientCreds = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  if (!clientCreds) {
    throw new AppError('SHEETS_NO_OAUTH_CLIENT', `no OAuth client credentials — save the Google Cloud client JSON to ${c.GMAIL_OAUTH_CLIENT_FILE} (or set GMAIL_OAUTH_CLIENT_ID/SECRET).`);
  }
  const oauth = new GoogleOAuthClient({ clientId: clientCreds.clientId, clientSecret: clientCreds.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const store = new LocalGmailTokenStore(c.GOOGLE_SHEETS_CREDENTIALS_FILE);
  const tokens = new OAuthAccessTokenProvider(oauth, store);
  return new HttpSheetsProvider({ spreadsheetId: c.GOOGLE_SHEETS_SPREADSHEET_ID, tokens, store, logger: ctx.logger, timeoutMs: c.GMAIL_TIMEOUT_MS });
}

function printProjectionCounts(snapshots: SheetTabSnapshot[]): void {
  for (const s of snapshots) console.log(`    ${s.tab}: ${String(s.rows.length)} rows`);
}

/**
 * Synchronize the Google Sheet operator projection (a ONE-WAY mirror of Postgres; manual Sheet edits
 * are never imported back). Postgres stays authoritative.
 *
 *  - `--preview`            : build the projection and print row counts; write NOTHING (any provider).
 *  - `--campaign <name>`    : scope to one campaign (upsert-only; other campaigns' rows untouched).
 *  - (default)              : full sync of all outreach records (removes rows no longer in Postgres).
 *
 * A real (http) write is FAIL-CLOSED and requires ALL of: GOOGLE_SHEETS_PROVIDER=http,
 * GOOGLE_SHEETS_SYNC_ENABLED=true, --confirm-sheet-write, a configured spreadsheet id, and valid
 * credentials with exactly the Sheets scope. Missing any → nonzero exit, no mock fallback, no partial
 * write. The default provider is mock (in-memory only; no external effect).
 */
export async function outreachSyncSheetCommand(
  ctx: CliContext,
  opts: { preview?: boolean; confirmSheetWrite?: boolean; campaign?: string },
): Promise<void> {
  const read = new OutreachReadRepository(ctx.db);

  let campaignId: string | undefined;
  if (opts.campaign) {
    const campaign = await read.getCampaignByName(opts.campaign);
    if (!campaign) {
      console.log(`Campaign not found: ${opts.campaign}. No action taken.`);
      return;
    }
    campaignId = campaign.id;
  }
  const scoped = campaignId !== undefined;
  const projection = await read.projection({ campaignId });
  const snapshots = buildAllTabs(projection, Date.now());

  if (opts.preview) {
    console.log(`\nSheet projection preview${scoped ? ` (campaign="${opts.campaign ?? ''}")` : ' (all outreach)'} — NO write performed:\n`);
    printProjectionCounts(snapshots);
    console.log('\n(Preview only. Postgres is authoritative; the Sheet is a one-way projection.)');
    return;
  }

  const deleteStale = !scoped; // full sync mirrors exactly; scoped sync is upsert-only.

  if (ctx.config.GOOGLE_SHEETS_PROVIDER === 'http') {
    // LIVE write path — fail closed on any missing requirement; never fall back to mock.
    const c = ctx.config;
    const missing: string[] = [];
    if (!c.GOOGLE_SHEETS_SYNC_ENABLED) missing.push('GOOGLE_SHEETS_SYNC_ENABLED=true');
    if (!opts.confirmSheetWrite) missing.push('--confirm-sheet-write');
    if (!c.GOOGLE_SHEETS_SPREADSHEET_ID) missing.push('GOOGLE_SHEETS_SPREADSHEET_ID=<id>');
    if (missing.length > 0) {
      throw new AppError('SHEETS_WRITE_REFUSED', `Refusing external Sheet write — missing: ${missing.join(', ')}. No write performed; the mock provider is NOT used as a fallback.`);
    }
    const provider = buildHttpSheetsProvider(ctx);
    const access = await provider.verifyAccess();
    if (!access.ok) {
      throw new AppError('SHEETS_WRITE_REFUSED', `Refusing external Sheet write — ${access.reason ?? 'credential/access precondition failed'}. No write performed.`);
    }
    const report = await syncSheet(provider, snapshots, { deleteStale });
    printSheetReport(report, scoped);
    return;
  }

  // Default: the mock provider is in-memory only (no external write). Explicitly selected via
  // GOOGLE_SHEETS_PROVIDER=mock (the default).
  const provider = new MockSheetsProvider();
  const report = await syncSheet(provider, snapshots, { deleteStale });
  printSheetReport(report, scoped);
  console.log('  (mock provider: in-memory only — no external Sheet was written.)');
}

function printSheetReport(report: { provider: string; wroteExternally: boolean; perTab: { tab: string; counts: { inserted: number; updated: number; unchanged: number; deleted: number } }[]; totals: { inserted: number; updated: number; unchanged: number; deleted: number } }, scoped: boolean): void {
  console.log(`\nSheet sync (provider=${report.provider}, external=${String(report.wroteExternally)}${scoped ? ', scoped upsert-only' : ', full'}):`);
  for (const t of report.perTab) {
    console.log(`  ${t.tab}: +${String(t.counts.inserted)} ~${String(t.counts.updated)} =${String(t.counts.unchanged)} -${String(t.counts.deleted)}`);
  }
  console.log(`  totals: inserted=${String(report.totals.inserted)} updated=${String(report.totals.updated)} unchanged=${String(report.totals.unchanged)} removed/stale=${String(report.totals.deleted)}`);
  if (scoped) console.log('  (scoped campaign sync: upsert-only; rows for other campaigns were not touched, so removed/stale is not evaluated.)');
}

/**
 * Readiness/verification for the Google Sheet projection. Confirms configuration and, for the http
 * provider, credentials + spreadsheet/tab access — WITHOUT modifying any data. Prints the projection
 * that WOULD be written but writes nothing.
 */
export async function outreachSheetVerifyCommand(ctx: CliContext, opts: { campaign?: string } = {}): Promise<void> {
  const c = ctx.config;
  console.log('\nGoogle Sheet readiness (verification only — never writes):\n');
  console.log(`  provider selection:  GOOGLE_SHEETS_PROVIDER=${c.GOOGLE_SHEETS_PROVIDER}`);
  console.log(`  sync flag:           GOOGLE_SHEETS_SYNC_ENABLED=${String(c.GOOGLE_SHEETS_SYNC_ENABLED)}`);
  console.log(`  spreadsheet id:      ${c.GOOGLE_SHEETS_SPREADSHEET_ID ? 'set' : 'MISSING'}`);

  if (c.GOOGLE_SHEETS_PROVIDER !== 'http') {
    console.log('  credentials:         not required — mock provider selected (no external access).');
  } else {
    let provider: HttpSheetsProvider | null = null;
    try {
      provider = buildHttpSheetsProvider(ctx);
    } catch (err) {
      console.log(`  credentials/access:  FAIL — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (provider) {
      const access = await provider.verifyAccess();
      if (access.ok) {
        console.log(`  credentials/scope:   OK (exactly ${GOOGLE_SHEETS_SCOPE})`);
        console.log(`  spreadsheet:         reachable — "${access.title ?? ''}"`);
        for (const t of Object.values(OUTREACH_TABS)) {
          const present = access.existingTabs?.includes(t) ?? false;
          console.log(`    tab "${t}": ${present ? 'present' : 'absent (created on first sync)'}`);
        }
      } else {
        console.log(`  credentials/access:  FAIL — ${access.reason ?? 'unknown'}`);
      }
    }
  }

  const read = new OutreachReadRepository(ctx.db);
  let campaignId: string | undefined;
  if (opts.campaign) {
    const campaign = await read.getCampaignByName(opts.campaign);
    if (!campaign) {
      console.log(`\n  Campaign not found: ${opts.campaign}. (No projection preview.)`);
      return;
    }
    campaignId = campaign.id;
  }
  const projection = await read.projection({ campaignId });
  const snapshots = buildAllTabs(projection, Date.now());
  console.log(`\n  Projection that WOULD be written${opts.campaign ? ` (campaign="${opts.campaign}")` : ' (all outreach)'} — no write performed:`);
  printProjectionCounts(snapshots);
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
