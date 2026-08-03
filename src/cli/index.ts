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
import { gmailReadAuthCommand } from './commands/gmail-read-auth.js';
import { sheetsAuthCommand } from './commands/sheets-auth.js';
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
import { competitorResearchPlanCommand } from './commands/competitor-research-plan.js';
import { competitorResearchRunCommand } from './commands/competitor-research-run.js';
import { competitorResearchReviewCommand } from './commands/competitor-research-review.js';
import { competitorCapturePlanCommand } from './commands/competitor-capture-plan.js';
import { competitorCaptureRunCommand } from './commands/competitor-capture-run.js';
import { competitorCaptureReviewCommand } from './commands/competitor-capture-review.js';
import { competitorCaptureInvalidateCommand } from './commands/competitor-capture-invalidate.js';
import { competitorPatternPlanCommand } from './commands/competitor-pattern-plan.js';
import { competitorPatternRunCommand } from './commands/competitor-pattern-run.js';
import { competitorPatternReviewCommand } from './commands/competitor-pattern-review.js';
import { competitorPatternApproveCommand } from './commands/competitor-pattern-approve.js';
import { competitorPatternRejectCommand } from './commands/competitor-pattern-reject.js';
import { competitorPatternInvalidateCommand } from './commands/competitor-pattern-invalidate.js';
import { outreachComposePreviewCommand } from './commands/outreach-compose-preview.js';
import { withConfigOnly, withContext } from './context.js';
import { websiteVerificationStatusCommand } from './commands/website-verification-status.js';
import { demoV2OrchestrationFixtureCommand } from './commands/demo-v2-orchestrate-fixture.js';
import { competitorEmailValidationPlanCommand } from './commands/competitor-email-validation-plan.js';
import { competitorEmailValidationRunCommand } from './commands/competitor-email-validation-run.js';
import { competitorEmailValidationReviewCommand } from './commands/competitor-email-validation-review.js';
import { competitorEmailLiveValidationPlanCommand } from './commands/competitor-email-live-validation-plan.js';
import { competitorEmailLiveValidationRunCommand } from './commands/competitor-email-live-validation-run.js';
import { competitorEmailLiveValidationReviewCommand } from './commands/competitor-email-live-validation-review.js';
import {
  demoV2PreviewCommand, demoV2RenderCommand, demoV2RenderHashCommand, demoV2ScreenshotsCommand,
  type RenderLanguage,
} from './commands/demo-v2-render.js';
import { demoV2PersistCommand, demoV2PersistStatusCommand } from './commands/demo-v2-persist.js';
import {
  demoV2ReviewCommand, demoV2ReviseCommand, demoV2ReviewHistoryCommand, demoV2ReviewLoopCommand,
} from './commands/demo-v2-review.js';
import { demoV2ReviewLoopLiveCommand } from './commands/demo-v2-review-loop-live.js';
import { ku64ExportEvidenceCommand } from './commands/ku64-v2-export-evidence.js';
import {
  outreachCancelFollowupCommand,
  outreachFollowupsDueCommand,
  outreachInitCommand,
  outreachPostponeFollowupCommand,
  outreachReadinessCommand,
  outreachRecordMessageCommand,
  outreachScheduleFollowupCommand,
  outreachSheetVerifyCommand,
  outreachSyncRepliesCommand,
  outreachSyncSheetCommand,
  outreachTimelineCommand,
  outreachTrackCommand,
  outreachTransitionCommand,
} from './commands/outreach.js';
import {
  outreachSmokeApproveCommand,
  outreachSmokeInitCommand,
  outreachSmokeReconcileCommand,
  outreachSmokeSendCommand,
} from './commands/outreach-smoke.js';
import { outreachCorrectDeliveryEventsCommand, outreachReconcileDeliveryCommand } from './commands/outreach-reconcile.js';
import { demoV2RenderEvidenceCommand } from './commands/demo-v2-render-evidence.js';
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
  .command('competitor-email-validation-plan')
  .description('Phase 7A4A: print the synthetic scenario, pipeline stages, rubric, and hard gates. Read-only; no network/DB/model/Gmail.')
  .action(() => { competitorEmailValidationPlanCommand(); });

program
  .command('competitor-email-validation-run')
  .description('Phase 7A4A: run the fixture-only baseline-vs-enriched competitor email quality comparison and write a local, git-ignored report. No production DB write, network, live model, Gmail, Sheets, draft, or send.')
  .option('--json', 'print the report as JSON instead of text')
  .option('--no-write', 'do not write the report to .local-data/competitor-email-validation/')
  .option('--out <dir>', 'output directory (git-ignored)')
  .action((opts: { json?: boolean; write?: boolean; out?: string }) => competitorEmailValidationRunCommand(opts));

program
  .command('competitor-email-validation-review')
  .description('Phase 7A4A: re-render a saved validation report with claim traceability and verify its determinism hash. Read-only.')
  .option('--report <path>', 'path to a saved report.json')
  .option('--out <dir>', 'directory containing report.json (git-ignored)')
  .action((opts: { report?: string; out?: string }) => competitorEmailValidationReviewCommand(opts));

program
  .command('competitor-email-live-validation-plan')
  .description('Phase 7A4B: print the fictional fixture, Terra/Sol routing, the two-call budget, stages, and required live guards. Read-only; no model/network/DB.')
  .action(() => withConfigOnly((config) => { competitorEmailLiveValidationPlanCommand(config); return Promise.resolve(); }));

program
  .command('competitor-email-live-validation-run')
  .description('Phase 7A4B: guarded fictional live-model validation (Terra base + Sol advisory critique). Mock by default; --confirm-live requires all guards. At most one Terra + one Sol call; local git-ignored report only. No production DB, Gmail, Sheets, draft, or send.')
  .option('--confirm-live', 'make real Terra + Sol calls (requires every guard; never falls back to mock)')
  .option('--fixture <id>', 'fictional fixture id (must be synthetic-dental)')
  .option('--confirm-no-real-prospect', 'confirm the fixture is fictional and no real prospect is involved')
  .option('--max-live-calls <n>', 'maximum live model calls (must be 2)')
  .option('--json', 'print the report as JSON instead of text')
  .option('--no-write', 'do not write the report to .local-data/competitor-email-validation/live/')
  .option('--out <dir>', 'output directory (git-ignored)')
  .action((opts: { confirmLive?: boolean; fixture?: string; confirmNoRealProspect?: boolean; maxLiveCalls?: string; json?: boolean; write?: boolean; out?: string }) =>
    withConfigOnly((config, logger) => competitorEmailLiveValidationRunCommand(config, logger, opts)));

program
  .command('competitor-email-live-validation-review')
  .description('Phase 7A4B: re-render a saved live validation report (routing, deterministic result, Sol advisory, combined status) and verify its report hash. Read-only.')
  .option('--report <path>', 'path to a saved live-report json')
  .option('--out <dir>', 'directory containing latest.json (git-ignored)')
  .action((opts: { report?: string; out?: string }) => competitorEmailLiveValidationReviewCommand(opts));

program
  .command('demo-v2-render')
  .description('Milestone 3A: render the fictional Demo V2 fixture to a local bundle and run deterministic checks; never deploys')
  .option('--out <dir>', 'output directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .action((opts: { out?: string; family?: string }) => demoV2RenderCommand(opts));

program
  .command('demo-v2-render-evidence')
  .description('Render a private, local review bundle from an already-exported redacted evidence JSON, using the tracked synthetic illustrative image pool (clearly disclosed). Reads only the local file; never touches a database, live site, Sol, deployment, Gmail, email, or scheduling. Output is git-ignored and never committed.')
  .requiredOption('--evidence <path>', 'path to an exported evidence JSON (e.g. .local-data/ku64-v2/evidence.json)')
  .option('--out <dir>', 'output directory (git-ignored)', './demos/ku64-v2')
  .option('--family <name>', 'override the reference family')
  .option('--review-package', 'also capture screenshots and write review-package.json')
  .action((opts: { evidence: string; out?: string; family?: string; reviewPackage?: boolean }) =>
    demoV2RenderEvidenceCommand(opts));

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
  .command('demo-v2-review-loop-live')
  .description([
    'Milestone 3B2B1: run ONE guarded LIVE OpenAI visual-review cycle over an existing review-package.json — THIS SPENDS MONEY.',
    'Fixed reviewer: OpenAI gpt-5.6-sol at high reasoning effort, NO fallback model, NO automatic retries.',
    'Hard caps: max 3 review calls / 2 revisions; mandatory projected-cost guard + $3 artifact ceiling enforced BEFORE calling; exact-fingerprint cache active.',
    'Refuses to run without --confirm-live-review AND DEMO_ENGINE_VERSION=v2, DEMO_V2_ENABLED=true, DEMO_V2_VISUAL_REVIEW_PROVIDER=openai, LLM_PROVIDER=openai, ALLOW_PAID_LLM_CALLS=true, OPENAI_API_KEY.',
    'Filesystem-only by default; --persist validates ONLY the guarded DEMO_V2_PERSIST_DATABASE_URL (loopback test DB) — never DATABASE_URL, never a supabase/pooler/remote/production target.',
    'Never deploys, emails, schedules, or records an automatic pass / human approval.',
  ].join(' '))
  .requiredOption('--review-package <path>', 'path to a review-package.json; its screenshots are uploaded to the live reviewer')
  .option('--persist', 'validate the guarded persistence database only (no operational DB is ever touched)')
  .option('--confirm-live-review', 'REQUIRED: explicitly acknowledge this makes a paid OpenAI call; without it the command refuses to run')
  .action((opts: { reviewPackage: string; persist?: boolean; confirmLiveReview?: boolean }) =>
    withConfigOnly((config, logger) => demoV2ReviewLoopLiveCommand(config, logger, opts)));

program
  .command('demo-v2-render-hash')
  .description('Milestone 3A: print the render, content, translation, asset, and manifest hashes')
  .option('--out <dir>', 'output directory', './demos/demo-v2')
  .option('--family <name>', 'override the reference family')
  .action((opts: { out?: string; family?: string }) => demoV2RenderHashCommand(opts));

program
  .command('ku64-v2-export-evidence')
  .description([
    'Phase 3C-A: guarded, read-only export of ONE lead\'s stored evidence into .local-data/ku64-v2/evidence.json for private V2 prep.',
    'SELECT-only; session is opened read-only. Refuses to run without --confirm-production-read AND ALLOW_PRODUCTION_READ_EXPORT=true,',
    'and only binds to a lead whose normalized domain is exactly ku64.de (www accepted).',
    'Never renders, deploys, downloads media, drafts, schedules, sends, or writes to the database.',
  ].join(' '))
  .requiredOption('--lead-id <id>', 'exact internal lead id to export')
  .requiredOption('--expected-domain <domain>', 'must normalize to ku64.de (www accepted)')
  .option('--confirm-production-read', 'REQUIRED: explicitly acknowledge this reads the production database')
  .action((opts: { leadId: string; expectedDomain: string; confirmProductionRead?: boolean }) =>
    withConfigOnly((config, logger) => ku64ExportEvidenceCommand(config, logger, opts)));

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
  .command('outreach-compose-preview')
  .description('Phase 7A3B: preview a prospect-only or competitor-enriched email (deterministic; read-only unless --apply). Never creates a Gmail draft or sends.')
  .requiredOption('--lead <id>', 'lead id')
  .option('--competitor-package <id>', 'explicit APPROVED competitor pattern package id to enrich with (else prospect-only)')
  .option('--competitor-pattern <id>', 'explicit pattern id within the package (else deterministic selection)')
  .option('--apply', 'persist the composed enriched email + provenance + claim ledger (still no Gmail/send)')
  .action((opts: { lead: string; competitorPackage?: string; competitorPattern?: string; apply?: boolean }) =>
    withContext((ctx) => outreachComposePreviewCommand(ctx, opts)));

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
  .command('gmail-read-auth')
  .description('Phase 17A2: one-time local OAuth setup for READ-ONLY reply detection (scope gmail.readonly only; separate 0600 credential file; never sends/drafts/modifies)')
  .action(() => withContext((ctx) => gmailReadAuthCommand(ctx)));

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

// --- Phase 17A: outreach tracking & follow-up operations (tracking only; NEVER sends) ---

program
  .command('outreach-init')
  .description('Phase 17A: verify outreach tracking tables/flags; optionally create a campaign. Never sends.')
  .option('--create-campaign <name>', 'create a campaign with this name if absent')
  .option('--timezone <iana>', 'campaign IANA timezone (default UTC)')
  .action((opts: { createCampaign?: string; timezone?: string }) => withContext((ctx) => outreachInitCommand(ctx, opts)));

program
  .command('outreach-track')
  .description('Phase 17A: create a tracked outreach record for (campaign, lead, contact). Never sends.')
  .requiredOption('--campaign <name>', 'campaign name')
  .requiredOption('--lead <id>', 'lead id')
  .requiredOption('--contact <email>', 'contact email')
  .option('--timezone <iana>', 'override recipient timezone')
  .option('--owner <name>', 'owner')
  .action((opts: { campaign: string; lead: string; contact: string; timezone?: string; owner?: string }) =>
    withContext((ctx) => outreachTrackCommand(ctx, opts)));

program
  .command('outreach-record-message')
  .description('Phase 17A: record an immutable message snapshot (exact subject + body). Never sends.')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--type <type>', 'INITIAL | FOLLOW_UP')
  .requiredOption('--step <n>', 'sequence step (0=initial, 1, 2)')
  .requiredOption('--subject <text>', 'exact subject')
  .requiredOption('--body <text>', 'exact body')
  .option('--gmail-message-id <id>', 'Gmail message id (if already sent elsewhere)')
  .option('--gmail-thread-id <id>', 'Gmail thread id')
  .option('--sent', 'mark this message as already sent (records sent timestamp)')
  .action((opts: { record: string; type: string; step: string; subject: string; body: string; gmailMessageId?: string; gmailThreadId?: string; sent?: boolean }) =>
    withContext((ctx) => outreachRecordMessageCommand(ctx, opts)));

program
  .command('outreach-transition')
  .description('Phase 17A: transition an outreach record status (validated; never sends)')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--to <status>', 'target status')
  .option('--reason <text>', 'reason')
  .action((opts: { record: string; to: string; reason?: string }) => withContext((ctx) => outreachTransitionCommand(ctx, opts)));

program
  .command('outreach-schedule-followup')
  .description('Phase 17A: compute + store a follow-up due date (never sends)')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--step <n>', 'follow-up step (1 or 2)')
  .action((opts: { record: string; step: string }) => withContext((ctx) => outreachScheduleFollowupCommand(ctx, opts)));

program
  .command('outreach-cancel-followup')
  .description('Phase 17A: cancel a pending follow-up')
  .requiredOption('--followup <id>', 'follow-up id')
  .requiredOption('--record <id>', 'outreach record id')
  .option('--reason <text>', 'reason')
  .action((opts: { followup: string; record: string; reason?: string }) => withContext((ctx) => outreachCancelFollowupCommand(ctx, opts)));

program
  .command('outreach-postpone-followup')
  .description('Phase 17A: postpone a pending follow-up to a new explicit instant')
  .requiredOption('--followup <id>', 'follow-up id')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--at <iso>', 'new due instant (ISO 8601)')
  .option('--reason <text>', 'reason')
  .action((opts: { followup: string; record: string; at: string; reason?: string }) => withContext((ctx) => outreachPostponeFollowupCommand(ctx, opts)));

program
  .command('outreach-followups-due')
  .description('Phase 17A: list follow-ups due (read-only; NEVER sends)')
  .action(() => withContext((ctx) => outreachFollowupsDueCommand(ctx)));

program
  .command('outreach-sync-replies')
  .description('Phase 17A2/17A3: read-only Gmail reply sync over tracked threads. Select exactly one reader: --mock (offline) OR a live read-only read (GMAIL_REPLY_SYNC_ENABLED=true AND --confirm-gmail-read). A requested live read that fails any guard exits nonzero and NEVER falls back to mock. NEVER sends/drafts/modifies Gmail.')
  .option('--confirm-gmail-read', 'confirm a LIVE read-only Gmail read (only honored with GMAIL_REPLY_SYNC_ENABLED=true)')
  .option('--mock', 'explicitly use the OFFLINE mock reader (no external Gmail access)')
  .option('--record <id>', 'restrict to one tracked outreach record')
  .option('--campaign <name>', 'restrict to one campaign')
  .action((opts: { confirmGmailRead?: boolean; mock?: boolean; record?: string; campaign?: string }) => withContext((ctx) => outreachSyncRepliesCommand(ctx, opts)));

program
  .command('sheets-auth')
  .description('Phase 17A3: one-time Google Sheets OAuth consent (spreadsheets scope ONLY; separate 0600 file; touches no Gmail credential)')
  .action(() => withContext((ctx) => sheetsAuthCommand(ctx)));

program
  .command('outreach-sync-sheet')
  .description('Phase 17A3: sync the Google Sheet operator projection (one-way; Postgres authoritative). Mock/off by default. A real http write requires GOOGLE_SHEETS_PROVIDER=http + GOOGLE_SHEETS_SYNC_ENABLED=true + a spreadsheet id + --confirm-sheet-write; any missing requirement exits nonzero and NEVER falls back to mock.')
  .option('--preview', 'build and print the projection row counts; write NOTHING')
  .option('--confirm-sheet-write', 'confirm a real external Sheet write (only honored with the http provider + GOOGLE_SHEETS_SYNC_ENABLED=true)')
  .option('--campaign <name>', 'scope to one campaign (upsert-only; other campaigns untouched)')
  .action((opts: { preview?: boolean; confirmSheetWrite?: boolean; campaign?: string }) => withContext((ctx) => outreachSyncSheetCommand(ctx, opts)));

program
  .command('outreach-sheet-verify')
  .description('Phase 17A3: verify Sheet configuration + (for http) credentials and spreadsheet/tab access without modifying data')
  .option('--campaign <name>', 'preview the projection for one campaign')
  .action((opts: { campaign?: string }) => withContext((ctx) => outreachSheetVerifyCommand(ctx, opts)));

program
  .command('outreach-timeline')
  .description('Phase 17A: show one outreach record\'s complete timeline (events + messages)')
  .requiredOption('--record <id>', 'outreach record id')
  .action((opts: { record: string }) => withContext((ctx) => outreachTimelineCommand(ctx, opts)));

program
  .command('outreach-readiness')
  .description('Phase 17A: report readiness for the first controlled send; NEVER sends')
  .action(() => withContext((ctx) => outreachReadinessCommand(ctx)));

// --- Phase 17C: delivery failure reconciliation (read-only DSN detection; NEVER sends) ---

program
  .command('outreach-reconcile-delivery')
  .description('Phase 17C: reconcile Gmail delivery failures (DSN/bounce). STRICTLY READ-ONLY on Gmail: correlates delivery notifications to tracked outbounds, transitions permanent bounces to BOUNCED, and cancels pending follow-ups. Select exactly one reader: --mock (offline) OR a live read-only read (GMAIL_REPLY_SYNC_ENABLED=true AND --confirm-gmail-read); a requested live read that fails any guard exits nonzero and NEVER falls back to mock. Never sends/drafts/modifies Gmail; never auto-retries.')
  .option('--record <id>', 'restrict to one tracked outreach record')
  .option('--campaign <name>', 'restrict to one campaign (unresolved sent records only)')
  .option('--confirm-gmail-read', 'confirm a LIVE read-only Gmail read (only honored with GMAIL_REPLY_SYNC_ENABLED=true)')
  .option('--mock', 'explicitly use the OFFLINE mock bounce reader (no external Gmail access)')
  .option('--dry-report', 'show the proposed correlation + state change; write NOTHING')
  .action((opts: { record?: string; campaign?: string; confirmGmailRead?: boolean; mock?: boolean; dryReport?: boolean }) =>
    withContext((ctx) => outreachReconcileDeliveryCommand(ctx, opts)));

program
  .command('outreach-correct-delivery-events')
  .description('Phase 17C1: invalidate (supersede) mis-correlated delivery events WITHOUT deleting history. Appends an immutable DELIVERY_RECONCILIATION_CORRECTED event; changes no outreach state or follow-up. Touches no Gmail and sends nothing. Dry-run by default; --apply (with --by and --reason) writes.')
  .option('--dsn <id...>', 'one or more DSN Gmail message ids to invalidate (repeatable)')
  .option('--reason <text>', 'correction reason (required with --apply)')
  .option('--by <operator>', 'operator identity (required with --apply)')
  .option('--apply', 'perform the correction (default is a dry run that writes nothing)')
  .action((opts: { dsn?: string[]; reason?: string; by?: string; apply?: boolean }) =>
    withContext((ctx) => outreachCorrectDeliveryEventsCommand(ctx, opts)));

// --- Phase 17B: controlled first-send smoke test (exactly ONE tracked send; heavily gated) ---

program
  .command('outreach-smoke-init')
  .description('Phase 17B: create the ONE synthetic controlled test record (campaign + synthetic lead + INITIAL step-0 message) at AWAITING_APPROVAL. NEVER sends.')
  .option('--subject <text>', 'override the exact subject (default: the suggested test subject)')
  .option('--body <text>', 'override the exact body (default: the suggested test body)')
  .option('--timezone <iana>', 'record timezone for follow-up tracking (default UTC)')
  .option('--owner <name>', 'owner label')
  .action((opts: { subject?: string; body?: string; timezone?: string; owner?: string }) => withContext((ctx) => outreachSmokeInitCommand(ctx, opts)));

program
  .command('outreach-smoke-approve')
  .description('Phase 17B: record the human approval and move the record to APPROVED_TO_SEND. NEVER sends.')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--by <operator>', 'approving operator identity')
  .action((opts: { record: string; by: string }) => withContext((ctx) => outreachSmokeApproveCommand(ctx, opts)));

program
  .command('outreach-smoke-send')
  .description('Phase 17B: perform EXACTLY ONE controlled, allowlisted send. Fail-closed. Requires OUTREACH_SMOKE_TEST_ENABLED=true + SENDING_ENABLED=true + OUTBOUND_ACTIONS_ENABLED=true + DRY_RUN=false + SENDING_PROVIDER=http + --provider http + --confirm-phase-17b + exact --sender + allowlisted --recipient + a valid unexpired approval.')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--sender <email>', 'exact sender (must equal GMAIL_ACCOUNT_EMAIL)')
  .requiredOption('--recipient <email>', 'allowlisted recipient (must equal OUTREACH_SMOKE_TEST_RECIPIENT)')
  .requiredOption('--provider <name>', 'must be "http"')
  .option('--confirm-phase-17b', 'explicit Phase 17B confirmation for the single real send')
  .action((opts: { record: string; sender: string; recipient: string; provider: string; confirmPhase17b?: boolean }) => withContext((ctx) => outreachSmokeSendCommand(ctx, opts)));

program
  .command('outreach-smoke-reconcile')
  .description('Phase 17B recovery ONLY: attach a Gmail message/thread id to the record WITHOUT sending (idempotent). Never calls Gmail.')
  .requiredOption('--record <id>', 'outreach record id')
  .requiredOption('--gmail-message-id <id>', 'confirmed Gmail message id')
  .requiredOption('--gmail-thread-id <id>', 'confirmed Gmail thread id')
  .action((opts: { record: string; gmailMessageId: string; gmailThreadId: string }) => withContext((ctx) => outreachSmokeReconcileCommand(ctx, opts)));

program
  .command('reset-test-data')
  .description('Clear only the validated local integration-test database')
  .action(() => resetTestData());

program
  .command('competitor-research-plan')
  .description('Phase 7A1: read-only preview of a lead + candidate source (fixtures/CSV only). No DB writes, no network.')
  .requiredOption('--lead <id>', 'lead id')
  .option('--provider <name>', 'fixture | operator_csv (default from COMPETITOR_RESEARCH_PROVIDER)')
  .option('--csv <path>', 'operator CSV path (operator_csv provider)')
  .option('--fixture <path>', 'fixture JSON path (fixture provider)')
  .action((opts: { lead: string; provider?: string; csv?: string; fixture?: string }) =>
    withContext((ctx) => competitorResearchPlanCommand(ctx, opts)));

program
  .command('competitor-research-run')
  .description('Phase 7A1: deterministically evaluate one prospect\'s competitor candidates (fixtures/CSV only). Dry report by default; --apply persists a DRAFT run (requires COMPETITOR_RESEARCH_ENABLED=true). No capture, no AI, no live provider, no Gmail/Sheets, no sending.')
  .requiredOption('--lead <id>', 'lead id (one prospect at a time)')
  .option('--provider <name>', 'fixture | operator_csv (default from COMPETITOR_RESEARCH_PROVIDER)')
  .option('--csv <path>', 'operator CSV path (operator_csv provider)')
  .option('--fixture <path>', 'fixture JSON path (fixture provider)')
  .option('--apply', 'persist a DRAFT run + candidates (idempotent); requires COMPETITOR_RESEARCH_ENABLED=true')
  .action((opts: { lead: string; provider?: string; csv?: string; fixture?: string; apply?: boolean }) =>
    withContext((ctx) => competitorResearchRunCommand(ctx, opts)));

program
  .command('competitor-research-review')
  .description('Phase 7A1: read-only review of persisted competitor-research runs for a lead (scores + rejection reasons). Does not approve email use.')
  .requiredOption('--lead <id>', 'lead id')
  .action((opts: { lead: string }) => withContext((ctx) => competitorResearchReviewCommand(ctx, opts)));

program
  .command('competitor-capture-plan')
  .description('Phase 7A2: read-only capture plan for a lead\'s selected competitors — validates research run, origins, limits, provider mode, and proposed pages. No network, no DB writes.')
  .requiredOption('--lead <id>', 'lead id')
  .option('--research-run <id>', 'specific research run id (default: latest DRAFT run for the lead)')
  .action((opts: { lead: string; researchRun?: string }) => withContext((ctx) => competitorCapturePlanCommand(ctx, opts)));

program
  .command('competitor-capture-run')
  .description('Phase 7A2: capture presence/absence evidence from selected competitors\' public pages. Fixture (offline) + dry report by default; --apply persists a DRAFT run. A LIVE capture requires COMPETITOR_CAPTURE_ENABLED=true + --provider playwright + --confirm-live-capture and NEVER falls back to fixtures. No email, no AI, no Gmail/Sheets, no sending.')
  .requiredOption('--lead <id>', 'lead id (one prospect at a time)')
  .option('--research-run <id>', 'specific research run id (default: latest DRAFT run for the lead)')
  .option('--provider <name>', 'fixture | playwright (default from COMPETITOR_CAPTURE_PROVIDER)')
  .option('--fixture <path>', 'local HTML fixture JSON (required for fixture mode)')
  .option('--apply', 'persist a DRAFT capture run + pages + evidence (idempotent)')
  .option('--confirm-live-capture', 'REQUIRED for a live browser capture (only valid with --provider playwright)')
  .action((opts: { lead: string; researchRun?: string; provider?: string; fixture?: string; apply?: boolean; confirmLiveCapture?: boolean }) =>
    withContext((ctx) => competitorCaptureRunCommand(ctx, opts)));

program
  .command('competitor-capture-review')
  .description('Phase 7A2: read-only review of persisted competitor capture runs — source pages, evidence items, confidence, freshness (re-evaluated), and withholding reasons. No comparative pattern or email wording.')
  .requiredOption('--lead <id>', 'lead id')
  .action((opts: { lead: string }) => withContext((ctx) => competitorCaptureReviewCommand(ctx, opts)));

program
  .command('competitor-capture-invalidate')
  .description('Phase 7A2: operator-controlled invalidation/supersession of ONE active evidence item. Dry-run by default; --apply marks it inactive/unsafe/UNREPRODUCIBLE. Immutable history preserved (row never deleted). Idempotent.')
  .requiredOption('--lead <id>', 'lead id')
  .requiredOption('--evidence <id>', 'evidence item id to invalidate')
  .option('--apply', 'perform the invalidation (default is a dry run)')
  .action((opts: { lead: string; evidence: string; apply?: boolean }) =>
    withContext((ctx) => competitorCaptureInvalidateCommand(ctx, opts)));

program
  .command('competitor-pattern-plan')
  .description('Phase 7A3A: read-only plan of the cross-competitor pattern denominators + proposed prospect contrasts for a lead. Validates research run, capture run, mappings, and freshness. No network, no DB writes, no email.')
  .requiredOption('--lead <id>', 'lead id')
  .option('--research-run <id>', 'specific research run id (default: latest DRAFT run for the lead)')
  .option('--capture-run <id>', 'specific capture run id (default: latest active capture run for the research run)')
  .action((opts: { lead: string; researchRun?: string; captureRun?: string }) => withContext((ctx) => competitorPatternPlanCommand(ctx, opts)));

program
  .command('competitor-pattern-run')
  .description('Phase 7A3A: build a deterministic competitor pattern package for ONE lead + ONE approved research/capture set. Dry report by default; --apply persists an immutable DRAFT package (requires COMPETITOR_PATTERN_ENABLED=true). Idempotent. No AI, no live provider, no email, no Gmail/Sheets, no sending.')
  .requiredOption('--lead <id>', 'lead id (one prospect at a time)')
  .option('--research-run <id>', 'specific research run id (default: latest DRAFT run for the lead)')
  .option('--capture-run <id>', 'specific capture run id (default: latest active capture run for the research run)')
  .option('--apply', 'persist a DRAFT package (idempotent); requires COMPETITOR_PATTERN_ENABLED=true')
  .action((opts: { lead: string; researchRun?: string; captureRun?: string; apply?: boolean }) => withContext((ctx) => competitorPatternRunCommand(ctx, opts)));

program
  .command('competitor-pattern-review')
  .description('Phase 7A3A: read-only review of persisted competitor pattern packages — counts, evidence sources, contrasts, confidence, exclusions, prohibited-claim validation. Produces no email wording.')
  .requiredOption('--lead <id>', 'lead id')
  .option('--package <id>', 'a specific package id (default: all packages for the lead)')
  .action((opts: { lead: string; package?: string }) => withContext((ctx) => competitorPatternReviewCommand(ctx, opts)));

program
  .command('competitor-pattern-approve')
  .description('Phase 7A3A: human approval of a DRAFT/REVIEWED package. Dry-run by default; --apply requires --operator identity + COMPETITOR_PATTERN_ENABLED=true and only approves when all validation gates pass. Creates no outreach, no lead-state change, no email, no send.')
  .requiredOption('--package <id>', 'package id to approve')
  .option('--operator <name>', 'operator identity (REQUIRED for --apply)')
  .option('--apply', 'perform the approval (default is a dry run)')
  .action((opts: { package: string; operator?: string; apply?: boolean }) => withContext((ctx) => competitorPatternApproveCommand(ctx, opts)));

program
  .command('competitor-pattern-reject')
  .description('Phase 7A3A: explicit operator rejection of a DRAFT/REVIEWED package. Dry-run by default; --apply requires --operator + COMPETITOR_PATTERN_ENABLED=true. Immutable history preserved (row not deleted).')
  .requiredOption('--package <id>', 'package id to reject')
  .option('--operator <name>', 'operator identity (REQUIRED for --apply)')
  .option('--apply', 'perform the rejection (default is a dry run)')
  .action((opts: { package: string; operator?: string; apply?: boolean }) => withContext((ctx) => competitorPatternRejectCommand(ctx, opts)));

program
  .command('competitor-pattern-invalidate')
  .description('Phase 7A3A: operator invalidation of a package (evidence changed). Dry-run by default; --apply requires --operator + COMPETITOR_PATTERN_ENABLED=true. Non-terminal → INVALIDATED. History + evidence refs preserved (nothing deleted).')
  .requiredOption('--package <id>', 'package id to invalidate')
  .option('--operator <name>', 'operator identity (REQUIRED for --apply)')
  .option('--apply', 'perform the invalidation (default is a dry run)')
  .action((opts: { package: string; operator?: string; apply?: boolean }) => withContext((ctx) => competitorPatternInvalidateCommand(ctx, opts)));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
