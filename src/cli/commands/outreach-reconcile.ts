import { runDeliveryReconciliation } from '../../domain/outreach/delivery-reconciliation.js';
import { OutreachService } from '../../domain/outreach/outreach-service.js';
import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { HttpGmailBounceReader } from '../../integrations/gmail/http-bounce-reader.js';
import { MockGmailBounceReader } from '../../integrations/gmail/mock-bounce-reader.js';
import { type GmailBounceReader } from '../../integrations/gmail/bounce-reader.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { liveReplyReadGate, selectReplyReader } from '../../integrations/gmail/http-reply-provider.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { DrizzleOutreachUnitOfWork } from '../../persistence/outreach-unit-of-work.js';
import { OutreachReadRepository } from '../../persistence/repositories/outreach.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

function service(ctx: CliContext): OutreachService {
  return new OutreachService(new DrizzleOutreachUnitOfWork(ctx.db));
}

/**
 * Build the guarded LIVE read-only Gmail bounce reader. Reuses the SEPARATE readonly
 * credential and the exact-scope precondition; a compose/send credential can never reach it.
 * Returns a fail-closed reason unless both gates plus the scope check pass.
 */
async function buildLiveBounceReader(
  ctx: CliContext,
  confirmGmailRead: boolean,
): Promise<{ reader: HttpGmailBounceReader } | { refused: string }> {
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
  const reader = new HttpGmailBounceReader({ tokens, store, logger: ctx.logger, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const check = await reader.verifyReadAccess();
  if (!check.ok) return { refused: check.reason ?? 'read-only access precondition failed.' };
  return { reader };
}

/**
 * Phase 17C: reconcile Gmail delivery failures. STRICTLY READ-ONLY over the Gmail side.
 * Finds Delivery Status Notifications connected to tracked outbound messages, correlates
 * each to EXACTLY ONE outbound (fail-closed on ambiguity), and — unless `--dry-report` —
 * transitions permanent bounces to BOUNCED and cancels pending follow-ups. Nothing here
 * sends, drafts, labels, archives, or modifies Gmail, and no automatic retry is ever scheduled.
 *
 * Reader selection is FAIL-CLOSED (reuses the Phase 17A3 decision): LIVE is selected the
 * moment GMAIL_REPLY_SYNC_ENABLED=true OR --confirm-gmail-read is present; once live, EVERY
 * live guard (both gates, present readonly credential, exact readonly scope) must pass or the
 * command exits nonzero — it NEVER falls back to mock. The mock reader runs ONLY with --mock.
 */
export async function outreachReconcileDeliveryCommand(
  ctx: CliContext,
  opts: { record?: string; campaign?: string; confirmGmailRead?: boolean; mock?: boolean; dryReport?: boolean } = {},
): Promise<void> {
  if (!ctx.config.OUTREACH_TRACKING_ENABLED) {
    console.log('Outreach tracking is disabled (OUTREACH_TRACKING_ENABLED=false). No action taken.');
    return;
  }
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

  // Deterministic, fail-closed reader selection (a live request that cannot satisfy every
  // guard throws instead of silently using mock).
  const selection = selectReplyReader({
    syncEnabled: ctx.config.GMAIL_REPLY_SYNC_ENABLED,
    confirmed: opts.confirmGmailRead === true,
    mock: opts.mock === true,
  });
  if (selection.kind === 'refuse') {
    throw new AppError('GMAIL_READ_REFUSED', selection.reason);
  }
  let reader: GmailBounceReader;
  if (selection.kind === 'live') {
    const live = await buildLiveBounceReader(ctx, opts.confirmGmailRead === true);
    if ('refused' in live) {
      throw new AppError('GMAIL_READ_REFUSED', `Live Gmail read refused: ${live.refused}`);
    }
    reader = live.reader;
  } else {
    reader = new MockGmailBounceReader();
    console.log('Using the OFFLINE mock bounce reader (--mock): no external Gmail access occurs.');
  }

  const outbounds = await read.trackedOutbounds({ recordId: opts.record, campaignId });
  if (outbounds.length === 0) {
    console.log('No tracked outbound messages match the selection (need a SENT message with a Gmail message id). No action taken.');
    return;
  }

  const dryRun = opts.dryReport === true;
  const report = await runDeliveryReconciliation({ reader, service: service(ctx), outbounds, dryRun });

  console.log(`\nDelivery reconciliation (reader=${report.reader}, external=${String(report.readExternally)}${dryRun ? ', DRY REPORT — no writes' : ''}):`);
  console.log(`  tracked outbounds:    ${String(outbounds.length)}`);
  console.log(`  notifications seen:   ${String(report.notificationsChecked)}`);
  console.log(`  correlated proposals: ${String(report.proposals.length)}`);
  for (const p of report.proposals) {
    console.log(`   • DSN ${p.dsnGmailMessageId} → record ${p.outreachRecordId} [${p.correlationSignal}] ${p.permanence}/${p.deliveryStatus} ${p.rejectionCode ?? ''}`);
  }
  if (report.skipped.length > 0) {
    console.log(`  skipped (fail-closed): ${String(report.skipped.length)}`);
    for (const s of report.skipped) console.log(`   • DSN ${s.dsnGmailMessageId}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
  }
  if (dryRun) {
    console.log('\n(Dry report only — no state change, no follow-up cancellation, no write performed.)');
    return;
  }
  console.log(`  applied:              ${String(report.applied.length)}`);
  for (const a of report.applied) {
    console.log(`   • record ${a.outreachRecordId}: ${a.outcome}`);
  }
  console.log('\nNo email was sent and no Gmail message was modified. Permanent bounces are BOUNCED with pending follow-ups cancelled; nothing is ever auto-retried.');
}
