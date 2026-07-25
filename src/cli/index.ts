import { Command } from 'commander';
import { auditWebsitesCommand } from './commands/audit-websites.js';
import { captureWebsitesCommand } from './commands/capture-websites.js';
import { cleanAuditDebugCommand } from './commands/clean-audit-debug.js';
import { collectLeadsCommand } from './commands/collect-leads.js';
import { enrichLeadCommand } from './commands/enrich-lead.js';
import { enrichLeadsCommand } from './commands/enrich-leads.js';
import { evalAuditCommand } from './commands/eval-audit.js';
import { gateACheckCommand } from './commands/gate-a-check.js';
import { generateDemosCommand } from './commands/generate-demos.js';
import { composeDemosCommand } from './commands/compose-demos.js';
import { generateEmailsCommand } from './commands/generate-emails.js';
import { reviewDashboardCommand } from './commands/review-dashboard.js';
import { deployDemosCommand } from './commands/deploy-demos.js';
import { gmailAuthCommand } from './commands/gmail-auth.js';
import { createGmailDraftsCommand } from './commands/create-gmail-drafts.js';
import { scheduleDraftsCommand } from './commands/schedule-drafts.js';
import { cancelScheduleCommand, rescheduleCommand, scheduleStatusCommand } from './commands/schedule-ops.js';
import { sendScheduledCommand } from './commands/send-scheduled.js';
import { gmailSendPreflightCommand } from './commands/gmail-send-preflight.js';
import { addSuppressionCommand, revokeSuppressionCommand, suppressionStatusCommand } from './commands/suppression-admin.js';
import { gmailCredentialAclCommand } from './commands/gmail-credential-acl.js';
import { approveSendingReadinessCommand, reconcileSendAttemptCommand, recoverStartedSendCommand, revokeSendingReadinessCommand,
  sendAttemptStatusCommand, sendingReadinessStatusCommand } from './commands/send-admin.js';
import { previewDemoCommand } from './commands/preview-demo.js';
import { qualifyLeadsCommand } from './commands/qualify-leads.js';
import { prospectRunCommand } from './commands/prospect-run.js';
import { controlledExistingLeadCommand } from './commands/prospect-controlled-test.js';
import { createSampleLeads } from './commands/create-sample-leads.js';
import { leadState } from './commands/lead-state.js';
import { listLeads } from './commands/list-leads.js';
import { resetTestData } from './commands/reset-test-data.js';
import { resumeAuditCommand } from './commands/resume-audit.js';
import { withConfigOnly, withContext } from './context.js';
import { websiteVerificationStatusCommand } from './commands/website-verification-status.js';
import { demoV2OrchestrationFixtureCommand } from './commands/demo-v2-orchestrate-fixture.js';
import {
  demoV2PreviewCommand, demoV2RenderCommand, demoV2RenderHashCommand, demoV2ScreenshotsCommand,
  type RenderLanguage,
} from './commands/demo-v2-render.js';
import { demoV2PersistCommand, demoV2PersistStatusCommand } from './commands/demo-v2-persist.js';
import {
  demoV2ReviewCommand, demoV2ReviseCommand, demoV2ReviewHistoryCommand, demoV2ReviewLoopCommand,
} from './commands/demo-v2-review.js';
import { type MockReviewFixture } from '../domain/demo-v2/render/visual-review.js';

const program = new Command();

program
  .name('automation-suite')
  .description('Controlled AI Outreach Operating System — Phase 1 CLI')
  .version('0.1.0');

program
  .command('demo-v2-orchestrate-fixture')
  .description('Build and inspect a fictional mock-only Demo V2 Milestone 2 package; never renders or deploys')
  .requiredOption('--fixture <name>', 'premium-german-dental | english-specialist-clinic | french-clinic | hebrew-rtl-clinic | arabic-rtl-clinic')
  .option('--stage <name>', 'intelligence | content | translation | assets | brief | plan | report', 'report')
  .action((opts: { fixture: string; stage?: string }) => demoV2OrchestrationFixtureCommand(opts));

program
  .command('demo-v2-render')
  .description('Milestone 3A: render the fictional Demo V2 fixture to a local bundle and run deterministic checks; never deploys')
  .option('--out <dir>', 'output directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .action((opts: { out?: string; family?: string }) => demoV2RenderCommand(opts));

program
  .command('demo-v2-preview')
  .description('Milestone 3A: serve a rendered Demo V2 bundle on loopback only (no deployment)')
  .option('--out <dir>', 'bundle directory', './demos/demo-v2')
  .option('--port <n>', 'loopback port', '4601')
  .action((opts: { out?: string; port?: string }) => demoV2PreviewCommand(opts));

program
  .command('demo-v2-screenshots')
  .description('Milestone 3A/3B2A: capture desktop/tablet/mobile screenshots for a language (de|fr|he|ar); optionally export the review package. Filesystem only.')
  .option('--out <dir>', 'bundle directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .option('--language <lang>', 'primary language: de | fr | he | ar', 'de')
  .option('--no-english', 'withhold the English secondary package (renders primary only, hides switcher)')
  .option('--review-package', 'also write review-package.json')
  .action((opts: { out?: string; family?: string; language?: RenderLanguage; english?: boolean; reviewPackage?: boolean }) =>
    demoV2ScreenshotsCommand({ ...opts, noEnglish: opts.english === false }));

program
  .command('demo-v2-persist')
  .description('Milestone 3B2A: render + screenshot + persist into the guarded local database. Requires DEMO_V2_ENABLED=true, ALLOW_DEMO_V2_PERSIST=true and DEMO_V2_PERSIST_DATABASE_URL (loopback test DB only). Never deploys or approves.')
  .option('--out <dir>', 'bundle directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .option('--language <lang>', 'primary language: de | fr | he | ar', 'de')
  .option('--no-english', 'withhold the English secondary package')
  .action((opts: { out?: string; family?: string; language?: RenderLanguage; english?: boolean }) =>
    withConfigOnly((config) => demoV2PersistCommand(config, { ...opts, noEnglish: opts.english === false })));

program
  .command('demo-v2-persist-status')
  .description('Milestone 3B2A: read-only inspection of persisted render versions, screenshots, review packages, and lifecycle status (guarded local database only)')
  .option('--limit <n>', 'max render versions to show', '10')
  .action((opts: { limit?: string }) => withConfigOnly((config) => demoV2PersistStatusCommand(config, opts)));

program
  .command('demo-v2-review')
  .description('Milestone 3B2B1: review an existing fictional review-package.json with the MOCK reviewer. Filesystem only; live reviewer is not launchable from here.')
  .requiredOption('--review-package <path>', 'path to a review-package.json')
  .option('--fixture <name>', 'mock verdict fixture', 'strong-premium-dental')
  .option('--persist', 'validate the guarded persistence database (no operational DB is ever touched)')
  .action((opts: { reviewPackage: string; fixture?: string; persist?: boolean }) =>
    withConfigOnly((config) => demoV2ReviewCommand(config, { ...opts, fixture: opts.fixture as MockReviewFixture })));

program
  .command('demo-v2-revise')
  .description('Milestone 3B2B1: apply a permitted-revision-operations file to a review package plan (presentation only; evidence bindings preserved). Filesystem only.')
  .requiredOption('--review-package <path>', 'path to a review-package.json')
  .requiredOption('--operations <path>', 'path to a revision-plan JSON (demo-v2-revision-1)')
  .action((opts: { reviewPackage: string; operations: string }) =>
    withConfigOnly((config) => demoV2ReviseCommand(config, opts)));

program
  .command('demo-v2-review-history')
  .description('Milestone 3B2B1: read-only inspection of persisted visual reviews — scores, blockers, costs, and hashes (guarded local database only)')
  .option('--limit <n>', 'max reviews to show', '10')
  .action((opts: { limit?: string }) => withConfigOnly((config) => demoV2ReviewHistoryCommand(config, opts)));

program
  .command('demo-v2-review-loop')
  .description('Milestone 3B2B1: run one complete fictional review loop with the MOCK reviewer (max 3 reviews / 2 revisions). Filesystem only; no persistence, no network.')
  .requiredOption('--review-package <path>', 'path to a review-package.json')
  .option('--sequence <fixtures>', 'comma-separated mock verdict fixtures per cycle')
  .action((opts: { reviewPackage: string; sequence?: string }) =>
    withConfigOnly((config) => demoV2ReviewLoopCommand(config, opts)));

program
  .command('demo-v2-render-hash')
  .description('Milestone 3A: print the render, content, translation, asset, and manifest hashes')
  .option('--out <dir>', 'output directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .action((opts: { out?: string; family?: string }) => demoV2RenderHashCommand(opts));

program
  .command('create-sample-leads')
  .description('Insert deterministic sample leads into the local database')
  .action(() => withContext(createSampleLeads));

program
  .command('list-leads')
  .description('List leads with their current state')
  .action(() => withContext(listLeads));

program
  .command('lead-state')
  .description('Show a lead current state and full event history')
  .argument('<id>', 'lead id')
  .action((id: string) => withContext((ctx) => leadState(ctx, id)));

program
  .command('collect-leads')
  .description('Collect and deduplicate leads for a campaign (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--source <provider>', 'override provider: mock | google_places')
  .option('--dry-run', 'force dry-run (no paid API calls)')
  .option('--limit <n>', 'max new leads this run (overrides MAX_LEADS_PER_RUN)')
  .action((opts: { campaign: string; source?: string; dryRun?: boolean; limit?: string }) =>
    withContext((ctx) =>
      collectLeadsCommand(ctx, {
        campaign: opts.campaign,
        source: opts.source === 'google_places' ? 'google_places' : opts.source === 'mock' ? 'mock' : undefined,
        dryRun: opts.dryRun,
        limit: opts.limit,
      }),
    ),
  );

program
  .command('website-verification-status')
  .description('Show the latest sanitized, stored website-verification attempt; never accesses the network')
  .requiredOption('--lead <id>', 'internal lead id')
  .action((opts: { lead: string }) =>
    withContext((ctx) => websiteVerificationStatusCommand(ctx, opts)),
  );

program
  .command('prospect-run')
  .description('Discover and qualify a bounded niche + radius candidate set; disabled by default')
  .requiredOption('--niche <name>', 'dentists | lawyers | gyms | real_estate')
  .option('--location <text>', 'city/locality/administrative area; optional with explicit coordinates')
  .requiredOption('--radius-km <n>', 'radius greater than 0 and no more than 50 km')
  .option('--target-qualified <n>', 'qualified lead target, bounded by configured cap')
  .option('--max-candidates <n>', 'candidate budget, 1-20 and bounded by configured cap')
  .option('--rank <rank>', 'POPULARITY | DISTANCE')
  .option('--latitude <n>', 'manual latitude; requires longitude and bypasses location resolution')
  .option('--longitude <n>', 'manual longitude; requires latitude and bypasses location resolution')
  .option('--continue-pipeline', 'continue only the first qualified lead through existing guarded stages')
  .option('--controlled-test', 'run the one-lead non-sendable controlled validation path')
  .option('--test-recipient-env <name>', 'approved test-recipient environment variable name')
  .option('--auto-approve-test-artifacts', 'record short-lived run/hash-bound controlled artifact approvals')
  .action((opts: { niche: string; location?: string; radiusKm: string; targetQualified?: string; maxCandidates?: string; rank?: string; latitude?: string; longitude?: string; continuePipeline?: boolean }) => withContext((ctx) => prospectRunCommand(ctx, opts)));

program
  .command('controlled-test-existing-lead')
  .description('Continue one already-qualified prospect lead through controlled artifacts and stop after draft read-back')
  .requiredOption('--lead <id>', 'existing qualified prospect lead id')
  .requiredOption('--stop-after-draft', 'hard stop after one draft and read-only exact-draft preflight')
  .requiredOption('--test-recipient-env <name>', 'approved controlled recipient environment variable name')
  .requiredOption('--auto-approve-test-artifacts', 'record short-lived run/hash-bound controlled artifact approvals')
  .option('--resume-after-audit', 'skip capture/audit and require an opportunity-ready lead')
  .action((opts: { lead: string; stopAfterDraft: boolean; testRecipientEnv?: string; autoApproveTestArtifacts: boolean; resumeAfterAudit?: boolean }) =>
    withContext((ctx) => controlledExistingLeadCommand(ctx, opts)));

program
  .command('qualify-leads')
  .description('Deterministically qualify (PRE_AUDIT) collected leads for a campaign')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to qualify this run')
  .option('--lead <id>', 'qualify exactly one lead id; overrides list ordering and limit')
  .action((opts: { campaign: string; limit?: string; lead?: string }) =>
    withContext((ctx) => qualifyLeadsCommand(ctx, opts)),
  );

program
  .command('enrich-leads')
  .description('Discover & verify official websites for READY_FOR_ENRICHMENT leads (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to enrich this run')
  .action((opts: { campaign: string; limit?: string }) =>
    withContext((ctx) => enrichLeadsCommand(ctx, { campaign: opts.campaign, limit: opts.limit })),
  );

program
  .command('enrich-lead')
  .description('Manually verify an operator-supplied candidate URL (no Google/paid API)')
  .option('--lead <id>', 'lead id')
  .option('--candidate <url>', 'candidate official website URL')
  .option('--csv <path>', 'CSV of leadId,candidateUrl rows')
  .action((opts: { lead?: string; candidate?: string; csv?: string }) =>
    withContext((ctx) => enrichLeadCommand(ctx, opts)),
  );

program
  .command('capture-websites')
  .description('Playwright capture of verified official websites (mock by default)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--purpose <p>', 'audit | verification', 'audit')
  .option('--limit <n>', 'max leads to capture this run')
  .action((opts: { campaign: string; purpose?: string; limit?: string }) =>
    withContext((ctx) => captureWebsitesCommand(ctx, opts)),
  );

program
  .command('audit-websites')
  .description('AI website audit of READY_FOR_AUDIT leads (mock by default; paid calls hard-gated)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to audit this run')
  .option('--lead <id>', 'audit exactly one lead id')
  .option('--resume-validation', 'resume one failed generator validation at its next attempt')
  .action((opts: { campaign: string; limit?: string; lead?: string; resumeValidation?: boolean }) =>
    withContext((ctx) => auditWebsitesCommand(ctx, opts)),
  );

program
  .command('eval-audit')
  .description('Run the audit model eval matrix on the fixture dataset (mock by default; Gate B when paid)')
  .option('--models <list>', 'comma-separated generator models')
  .option('--reviewers <list>', 'comma-separated reviewer models (default: same as --models)')
  .option('--cases <list>', 'comma-separated fixture case names (default: all)')
  .option('--max-calls <n>', 'hard cap on model calls for the whole matrix')
  .option('--out <dir>', 'report output directory', './eval-reports')
  .action((opts: { models?: string; reviewers?: string; cases?: string; maxCalls?: string; out?: string }) =>
    withContext((ctx) => evalAuditCommand(ctx, opts)),
  );

program
  .command('gate-a-check')
  .description('Print Gate A readiness (projected tokens/cost, caps, safety gates) — no OpenAI call')
  .option('--limit <n>', 'max READY_FOR_AUDIT leads to report')
  .action((opts: { limit?: string }) => withContext((ctx) => gateACheckCommand(ctx, opts)))
  ;

program
  .command('clean-audit-debug')
  .description('Remove audit validation-debug envelopes (expired by default; --all purges everything)')
  .option('--all', 'purge all debug records, not just expired')
  .action((opts: { all?: boolean }) => withContext((ctx) => cleanAuditDebugCommand(ctx, opts)))
  ;

program
  .command('resume-audit')
  .description('Replay paid-result recovery envelopes after a failed DB write (never calls the model)')
  .action(() => withContext(resumeAuditCommand));

program
  .command('generate-demos')
  .description('Generate local concept-demo sites for OPPORTUNITY_READY leads (no deploy, human review required)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to generate demos for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => generateDemosCommand(ctx, opts)));

program
  .command('compose-demos')
  .description('AI Demo Composer: design + render local concept demos for OPPORTUNITY_READY leads (mock by default; no deploy, human review required)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to compose demos for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => composeDemosCommand(ctx, opts)));

program
  .command('generate-emails')
  .description('Phase 9: write one factual cold email per DEMO_READY/DEMO_DECIDED lead (mock by default; independent reviewer; no sending, no Gmail, no deploy)')
  .requiredOption('--campaign <name>', 'campaign name (see src/config/campaigns.ts)')
  .option('--limit <n>', 'max leads to write emails for this run')
  .action((opts: { campaign: string; limit?: string }) => withContext((ctx) => generateEmailsCommand(ctx, opts)));

program
  .command('deploy-demos')
  .description('Phase 11: deploy approved demos to Netlify DRAFT deploys, verify, and finalize the email (mock by default; no send/Gmail)')
  .option('--limit <n>', 'max leads to deploy this run')
  .action((opts: { limit?: string }) => withContext((ctx) => deployDemosCommand(ctx, opts)));

program
  .command('gmail-auth')
  .description('One-time local OAuth setup for Gmail draft creation (scope gmail.compose only; loopback callback; stores refresh token 0600)')
  .action(() => withContext((ctx) => gmailAuthCommand(ctx)));

program
  .command('create-gmail-drafts')
  .description('Phase 12: create a Gmail DRAFT (never send) for HUMAN_APPROVED leads with an approved finalized email (mock by default)')
  .option('--limit <n>', 'max leads to draft this run')
  .action((opts: { limit?: string }) => withContext((ctx) => createGmailDraftsCommand(ctx, opts)));

program
  .command('schedule-drafts')
  .description('Phase 13: record deterministic, timezone-aware send times for DRAFT_CREATED leads (never sends). --dry-run previews with no changes.')
  .option('--limit <n>', 'max leads to schedule this run')
  .option('--dry-run', 'compute + display proposed slots without any database or external changes')
  .option('--not-before <iso>', 'do not schedule before this ISO instant')
  .action((opts: { limit?: string; dryRun?: boolean; notBefore?: string }) => withContext((ctx) => scheduleDraftsCommand(ctx, opts)));

program
  .command('schedule-status')
  .description('Phase 13: list active schedules (read-only; UTC + recipient-local; no sending)')
  .action(() => withContext((ctx) => scheduleStatusCommand(ctx)));

program
  .command('cancel-schedule')
  .description('Phase 13: cancel a lead\'s active schedule (SCHEDULED → DRAFT_CREATED; history preserved)')
  .requiredOption('--lead <id>', 'lead id')
  .option('--reason <text>', 'cancellation reason')
  .action((opts: { lead: string; reason?: string }) => withContext((ctx) => cancelScheduleCommand(ctx, opts)));

program
  .command('reschedule')
  .description('Phase 13: reschedule a lead (supersede-and-insert; history preserved)')
  .requiredOption('--lead <id>', 'lead id')
  .requiredOption('--at <iso>', 'new send time (ISO 8601)')
  .action((opts: { lead: string; at: string }) => withContext((ctx) => rescheduleCommand(ctx, opts)));

program
  .command('send-scheduled')
  .description('Phases 14-15: evaluate ONE scheduled Gmail draft; dry-run is local-only and live use requires interactive TTY confirmation')
  .requiredOption('--lead <id>', 'lead id (must have an active SCHEDULED schedule)')
  .action((opts: { lead: string }) => withContext((ctx) => sendScheduledCommand(ctx, opts)));

program
  .command('gmail-send-preflight')
  .description('Phase 16: read-only account + one known Gmail draft verification; structurally cannot send')
  .requiredOption('--lead <id>', 'internal lead id with one active schedule')
  .action((opts: { lead: string }) => withContext((ctx) => gmailSendPreflightCommand(ctx, opts)));

program
  .command('add-suppression')
  .description('Phase 16: add an audited suppression after exact interactive confirmation; no external call')
  .requiredOption('--scope <scope>', 'email | domain | phone | place_id | business')
  .requiredOption('--value <value>', 'identity value (never printed or written to audit events)')
  .requiredOption('--reason <text>', 'audited operational reason; do not include private identity data')
  .requiredOption('--by <operator>', 'operator identity')
  .action((opts: { scope: string; value: string; reason: string; by: string }) => withContext((ctx) => addSuppressionCommand(ctx, opts)));

program
  .command('suppression-status')
  .description('Phase 16: inspect suppressions with identity values replaced by hashes')
  .option('--scope <scope>', 'optional email | domain | phone | place_id | business filter')
  .action((opts: { scope?: string }) => withContext((ctx) => suppressionStatusCommand(ctx, opts)));

program
  .command('revoke-suppression')
  .description('Phase 16: revoke one suppression after exact interactive confirmation; history remains')
  .requiredOption('--id <id>', 'internal suppression id')
  .requiredOption('--reason <text>', 'audited revocation reason')
  .requiredOption('--by <operator>', 'operator identity')
  .action((opts: { id: string; reason: string; by: string }) => withContext((ctx) => revokeSuppressionCommand(ctx, opts)));

program
  .command('gmail-credential-acl')
  .description('Phase 16: inspect Gmail credential-file ACLs; optional owner-only remediation requires exact TTY confirmation')
  .option('--fix', 'apply owner-only ACLs to existing configured credential files')
  .option('--by <operator>', 'operator identity required with --fix')
  .action((opts: { fix?: boolean; by?: string }) => withContext((ctx) => gmailCredentialAclCommand(ctx, opts)));

program
  .command('approve-sending-readiness')
  .description('Phase 15: create one expiring account/policy readiness approval; does not call Gmail or send')
  .requiredOption('--by <operator>', 'operator creating the readiness approval')
  .requiredOption('--minutes <n>', 'expiry in minutes (1-60)')
  .action((opts: { by: string; minutes: string }) => withContext((ctx) => approveSendingReadinessCommand(ctx, opts)));

program
  .command('revoke-sending-readiness')
  .description('Phase 15: revoke an active readiness approval; does not call Gmail or send')
  .requiredOption('--id <id>', 'internal readiness approval id')
  .requiredOption('--by <operator>', 'operator revoking readiness')
  .requiredOption('--reason <text>', 'audited revocation reason')
  .action((opts: { id: string; by: string; reason: string }) => withContext((ctx) => revokeSendingReadinessCommand(ctx, opts)));

program
  .command('sending-readiness-status')
  .description('Phase 15: show redacted readiness status for the configured account/policy')
  .action(() => withContext(sendingReadinessStatusCommand));

program
  .command('send-attempt-status')
  .description('Phase 15: show redacted send-attempt status; no Gmail access')
  .option('--lead <id>', 'optional internal lead id')
  .action((opts: { lead?: string }) => withContext((ctx) => sendAttemptStatusCommand(ctx, opts)));

program
  .command('reconcile-send-attempt')
  .description('Phase 15: manually reconcile an uncertain attempt; does not call Gmail or send')
  .requiredOption('--attempt <id>', 'internal send-attempt id')
  .requiredOption('--outcome <value>', 'confirmed-sent | confirmed-not-sent | unresolved')
  .requiredOption('--by <operator>', 'operator performing reconciliation')
  .requiredOption('--note <text>', 'audited evidence/reason summary; do not include private values or Gmail ids')
  .action((opts: { attempt: string; outcome: string; by: string; note: string }) => withContext((ctx) => reconcileSendAttemptCommand(ctx, opts)));

program
  .command('recover-started-send')
  .description('Phase 16: explicitly record one crash-left CALL_STARTED as OUTCOME_UNKNOWN; never calls Gmail')
  .requiredOption('--attempt <id>', 'internal send-attempt id')
  .requiredOption('--by <operator>', 'operator identity')
  .requiredOption('--note <text>', 'audited recovery evidence; do not include private values or Gmail ids')
  .action((opts: { attempt: string; by: string; note: string }) => withContext((ctx) => recoverStartedSendCommand(ctx, opts)));

program
  .command('review-dashboard')
  .description('Start the local review dashboard (loopback only; approve/reject demos + emails; no auth, no sending, no deploy)')
  .action(() => withContext((ctx) => reviewDashboardCommand(ctx)));

program
  .command('preview-demo')
  .description("Serve a lead's generated demo locally (loopback only; never public)")
  .requiredOption('--lead <id>', 'lead id')
  .action((opts: { lead: string }) => withContext((ctx) => previewDemoCommand(ctx, opts)));

program
  .command('reset-test-data')
  .description('Clear only the validated local integration-test database')
  .action(() => resetTestData());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
