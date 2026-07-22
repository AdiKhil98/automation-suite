import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ReadOnlyGmailPreflightService } from '../../domain/send/read-only-gmail-preflight.js';
import { type SendInput } from '../../domain/send/send-service.js';
import { type ProspectContinuation, type ProspectContinuationContext } from '../../domain/prospect/prospect-service.js';
import { CONTROLLED_TEST_RECIPIENT_ENV, CONTROLLED_TEST_TTL_MS, controlledEmailArtifactHash,
  controlledRecipientFingerprint, normalizeControlledRecipient,
  assertControlledDraftRecipient, assertControlledExistingLeadPreflight } from '../../domain/prospect/controlled-test.js';
import { MockSendProvider } from '../../integrations/send/mock-send.js';
import { ControlledTestRepository } from '../../persistence/repositories/controlled-test.repo.js';
import { SendInputRepository } from '../../persistence/repositories/send-input.repo.js';
import { type CliContext } from '../context.js';
import { auditWebsitesCommand } from './audit-websites.js';
import { captureWebsitesCommand } from './capture-websites.js';
import { composeDemosCommand } from './compose-demos.js';
import { deployDemosCommand } from './deploy-demos.js';
import { generateEmailsCommand } from './generate-emails.js';
import { buildGmailService } from './gmail-build.js';
import { buildScheduleService } from './schedule-build.js';
import { buildReadOnlyGmailVerifier, buildSendService } from './send-build.js';

type ControlledGate =
  | 'PROSPECT_DISCOVERY_ENABLED' | 'ALLOW_PAID_READS' | 'ALLOW_PAID_LLM_CALLS'
  | 'CAPTURE_PROVIDER' | 'DEMO_COMPOSER_ENABLED' | 'EMAIL_GENERATION_ENABLED'
  | 'NETLIFY_DEPLOYMENT_ENABLED' | 'GMAIL_DRAFTS_ENABLED' | 'GMAIL_DRAFT_ACTIONS_ENABLED'
  | 'GMAIL_SEND_PREFLIGHT_ENABLED' | 'SCHEDULING_ENABLED' | 'PROSPECT_CONTINUE_PIPELINE';

const CONTROLLED_GATES: Record<ControlledGate, boolean | string> = {
  PROSPECT_DISCOVERY_ENABLED: true,
  ALLOW_PAID_READS: true,
  ALLOW_PAID_LLM_CALLS: true,
  CAPTURE_PROVIDER: 'playwright',
  DEMO_COMPOSER_ENABLED: true,
  EMAIL_GENERATION_ENABLED: true,
  NETLIFY_DEPLOYMENT_ENABLED: true,
  GMAIL_DRAFTS_ENABLED: true,
  GMAIL_DRAFT_ACTIONS_ENABLED: true,
  GMAIL_SEND_PREFLIGHT_ENABLED: true,
  SCHEDULING_ENABLED: true,
  PROSPECT_CONTINUE_PIPELINE: true,
};

const DRAFT_ONLY_GATES: Record<ControlledGate, boolean | string> = {
  ...CONTROLLED_GATES,
  PROSPECT_DISCOVERY_ENABLED: false,
  SCHEDULING_ENABLED: false,
};

/** Process-local gate changes only. The caller's environment and .env are never modified. */
export async function withControlledTestGates<T>(config: CliContext['config'], fn: () => Promise<T>,
  options: { stopAfterDraft?: boolean } = {}): Promise<T> {
  const mutable = config as unknown as Record<string, unknown>;
  const before = new Map<string, unknown>();
  const gates = options.stopAfterDraft ? DRAFT_ONLY_GATES : CONTROLLED_GATES;
  for (const [key, value] of Object.entries(gates)) { before.set(key, mutable[key]); mutable[key] = value; }
  try {
    if (config.SENDING_ENABLED || config.OUTBOUND_ACTIONS_ENABLED) throw new Error('controlled_test_kill_switch_changed');
    if (options.stopAfterDraft ? config.DRY_RUN : !config.DRY_RUN) throw new Error('controlled_test_dry_run_mode_changed');
    if (options.stopAfterDraft && config.SCHEDULING_ENABLED) throw new Error('controlled_test_scheduling_enabled');
    return await fn();
  } finally {
    for (const [key, value] of before) mutable[key] = value;
  }
}

/** Local-only checks that run before location resolution, Places, or any other provider. */
export function assertControlledProviderConfig(c: CliContext['config']): void {
  const missing: string[] = [];
  if (!c.GOOGLE_PLACES_API_KEY) missing.push('GOOGLE_PLACES_API_KEY');
  if (c.LLM_PROVIDER !== 'openai') missing.push('LLM_PROVIDER=openai');
  if (!c.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!c.NETLIFY_AUTH_TOKEN) missing.push('NETLIFY_AUTH_TOKEN');
  if (!c.NETLIFY_SITE_ID) missing.push('NETLIFY_SITE_ID');
  if (!c.NETLIFY_EXPECTED_HOSTNAME) missing.push('NETLIFY_EXPECTED_HOSTNAME');
  if (!c.GMAIL_ACCOUNT_EMAIL) missing.push('GMAIL_ACCOUNT_EMAIL');
  if (!c.GMAIL_SENDER_NAME) missing.push('GMAIL_SENDER_NAME');
  if (!existsSync(c.GMAIL_CREDENTIALS_FILE)) missing.push('GMAIL_CREDENTIALS_FILE');
  if (!existsSync(c.GMAIL_OAUTH_CLIENT_FILE) && (!c.GMAIL_OAUTH_CLIENT_ID || !c.GMAIL_OAUTH_CLIENT_SECRET)) missing.push('GMAIL_OAUTH_CLIENT_FILE');
  if (missing.length > 0) throw new Error(`controlled_test_configuration_missing:${missing.join(',')}`);
}

function requireValue<T>(value: T | null | undefined, reason: string): T {
  if (value === null || value === undefined) throw new Error(reason);
  return value;
}

/**
 * Exact-lead controlled continuation. It can create a preview, one draft and one schedule,
 * but it has no send-provider reference and records no production sending readiness approval.
 */
export class ControlledTestContinuation implements ProspectContinuation {
  constructor(private readonly ctx: CliContext, private readonly recipient: string,
    private readonly options: { stopAfterDraft?: boolean; resumeAfterAudit?: boolean } = {}) {}

  async continueFirstQualified(leadId: string, context: ProspectContinuationContext): Promise<void> {
    const repo = new ControlledTestRepository(this.ctx.db);
    const controlledTestRunId = randomUUID();
    const recipient = normalizeControlledRecipient(this.recipient);
    const recipientFingerprint = controlledRecipientFingerprint(recipient);
    const expiresAt = new Date(Date.now() + CONTROLLED_TEST_TTL_MS);
    await repo.start({ id: controlledTestRunId, prospectRunId: context.prospectRunId,
      pipelineRunId: context.pipelineRunId, leadId, recipientEmail: recipient, recipientFingerprint,
      recipientEnvName: CONTROLLED_TEST_RECIPIENT_ENV, expiresAt });
    try {
      const exact = { campaign: 'prospect-runtime', limit: '1', lead: leadId };
      if (!this.options.resumeAfterAudit) {
        await captureWebsitesCommand(this.ctx, exact);
        await auditWebsitesCommand(this.ctx, exact);
      } else {
        const lead = await this.ctx.leads.getById(leadId);
        if (lead?.status !== 'OPPORTUNITY_READY') {
          throw new Error(`controlled_resume_after_audit_not_ready:${lead?.status ?? 'missing'}`);
        }
      }
      await composeDemosCommand(this.ctx, exact);

      const demo = requireValue(await repo.latestDemo(leadId), 'controlled_test_demo_missing');
      const demoHash = requireValue(demo.contentHash, 'controlled_test_demo_hash_missing');
      await repo.approve({ controlledTestRunId, leadId, artifactType: 'DEMO', artifactId: demo.id,
        artifactHash: demoHash, recipientFingerprint, expiresAt });

      await generateEmailsCommand(this.ctx, { ...exact, controlledTestRunId });
      const email = requireValue(await repo.latestEmail(leadId), 'controlled_test_email_missing');
      const emailHash = controlledEmailArtifactHash(email.subject, email.body);
      await repo.approve({ controlledTestRunId, leadId, artifactType: 'EMAIL_DRAFT', artifactId: email.id,
        artifactHash: emailHash, recipientFingerprint, expiresAt });

      await deployDemosCommand(this.ctx, { limit: '1', lead: leadId, controlledTestRunId });
      const finalized = requireValue(await repo.latestFinalization(leadId), 'controlled_test_finalization_missing');
      await repo.approve({ controlledTestRunId, leadId, artifactType: 'FINALIZED_EMAIL',
        artifactId: finalized.finalization.id, artifactHash: finalized.finalization.resolvedBodyHash,
        recipientFingerprint, expiresAt });
      if (!await repo.isArtifactApproved({ controlledTestRunId, leadId, artifactType: 'FINALIZED_EMAIL',
        artifactId: finalized.finalization.id, artifactHash: finalized.finalization.resolvedBodyHash })) {
        throw new Error('controlled_test_finalization_approval_invalid');
      }

      assertControlledDraftRecipient(requireValue(this.ctx.config.TEST_RECIPIENT_EMAIL,
        'controlled_test_recipient_missing_at_draft'), recipient);
      const gmail = buildGmailService(this.ctx);
      if (!gmail.live) throw new Error('controlled_test_gmail_draft_provider_not_live');
      const gmailResult = await gmail.service.createDraft({ leadId, leadStatus: 'HUMAN_APPROVED',
        finalization: { id: finalized.finalization.id, resolvedBody: finalized.finalization.resolvedBody,
          resolvedBodyHash: finalized.finalization.resolvedBodyHash, finalHumanDecision: 'APPROVED' },
        subject: finalized.subject, recipientEmail: recipient }, context.pipelineRunId);
      if (gmailResult.outcome !== 'DRAFT_CREATED') throw new Error(`controlled_test_gmail_draft_failed:${gmailResult.outcome}`);

      const draft = requireValue(await repo.latestGmailDraft(leadId), 'controlled_test_gmail_draft_record_missing');
      if (draft.id !== gmailResult.draftId || normalizeControlledRecipient(draft.recipientEmail) !== recipient) {
        throw new Error('controlled_test_gmail_draft_binding_mismatch');
      }
      const preflightInput: SendInput = {
        leadId, leadStatus: 'DRAFT_CREATED', schedule: null,
        currentGmailDraft: { id: draft.id, outcome: draft.outcome, providerDraftId: draft.providerDraftId,
          providerMessageId: draft.messageId, providerThreadId: draft.threadId, gmailAccount: draft.gmailAccount,
          senderEmail: draft.senderEmail, recipientEmail: draft.recipientEmail, finalizedEmailId: draft.finalizedEmailId },
        finalization: { id: finalized.finalization.id, resolvedBody: finalized.finalization.resolvedBody,
          resolvedBodyHash: finalized.finalization.resolvedBodyHash, finalHumanDecision: 'APPROVED', finalReviewedAt: new Date() },
        currentFinalizedContentHash: finalized.finalization.resolvedBodyHash, currentRecipientEmail: recipient,
        subject: finalized.subject, normalizedDomain: null, normalizedPhone: null, placeId: null,
        confirmation: null, preflightProof: null,
      };
      if (!this.ctx.config.GMAIL_SEND_PREFLIGHT_ENABLED) throw new Error('controlled_test_gmail_preflight_disabled');
      const preflight = await new ReadOnlyGmailPreflightService(buildReadOnlyGmailVerifier(this.ctx), {
        gmailAccount: this.ctx.config.GMAIL_ACCOUNT_EMAIL ?? '', senderName: this.ctx.config.GMAIL_SENDER_NAME ?? null,
      }).verify(preflightInput);
      if (!preflight.ok) throw new Error(`controlled_test_gmail_preflight_failed:${preflight.outcome}`);

      if (this.options.stopAfterDraft) {
        await repo.finish(controlledTestRunId, 'COMPLETED');
        console.log('  Controlled continuation stopped after one Gmail draft and exact read-only preflight.');
        console.log('  Scheduling, readiness, send attempts, and sending remain disabled.');
        return;
      }

      const scheduled = await buildScheduleService(this.ctx).schedule({ leadId, leadStatus: 'DRAFT_CREATED',
        gmailDraft: { id: draft.id, outcome: draft.outcome, providerDraftId: draft.providerDraftId },
        finalizedContentHash: finalized.finalization.resolvedBodyHash, recipientEmail: recipient,
        timezone: 'UTC' }, context.pipelineRunId);
      if (scheduled.outcome !== 'SCHEDULED') throw new Error(`controlled_test_schedule_failed:${scheduled.outcome}`);
      const schedule = requireValue(await repo.activeSchedule(leadId), 'controlled_test_schedule_record_missing');

      const persisted = await new SendInputRepository(this.ctx.db).latest(leadId);
      const readinessInput: SendInput = { leadId, leadStatus: 'SCHEDULED', ...persisted,
        currentRecipientEmail: recipient,
        finalization: persisted.finalization ? { ...persisted.finalization, finalHumanDecision: 'APPROVED', finalReviewedAt: new Date() } : null,
        confirmation: null, preflightProof: null };
      const sendController = buildSendService(this.ctx, new MockSendProvider());
      const readiness = await sendController.localReadiness(readinessInput);
      await repo.evaluation({ controlledTestRunId, leadId, gmailDraftId: draft.id, scheduleId: schedule.id,
        evaluationType: 'READINESS', report: readiness });
      const dryRun = await sendController.localReadiness(readinessInput);
      await repo.evaluation({ controlledTestRunId, leadId, gmailDraftId: draft.id, scheduleId: schedule.id,
        evaluationType: 'DRY_RUN', report: dryRun });
      await repo.finish(controlledTestRunId, 'COMPLETED');
      console.log('  Controlled continuation complete: preview, one draft, read-only preflight, one schedule, and non-sendable dry-run recorded.');
      console.log('  Recipient: configured test address (redacted); send capability: disabled.');
    } catch (error) {
      await repo.finish(controlledTestRunId, 'FAILED');
      throw error;
    }
  }
}

export async function controlledExistingLeadCommand(ctx: CliContext, opts: {
  lead: string; stopAfterDraft: boolean; testRecipientEnv?: string; autoApproveTestArtifacts: boolean;
  resumeAfterAudit?: boolean;
}): Promise<void> {
  const recipient = assertControlledExistingLeadPreflight({
    stopAfterDraft: opts.stopAfterDraft,
    autoApproveTestArtifacts: opts.autoApproveTestArtifacts,
    recipientEnvName: opts.testRecipientEnv,
    recipientValue: ctx.config.TEST_RECIPIENT_EMAIL,
    dryRun: ctx.config.DRY_RUN,
    sendingEnabled: ctx.config.SENDING_ENABLED,
    outboundActionsEnabled: ctx.config.OUTBOUND_ACTIONS_ENABLED,
    schedulingEnabled: ctx.config.SCHEDULING_ENABLED,
  });
  assertControlledProviderConfig(ctx.config);
  const lead = await ctx.leads.getById(opts.lead);
  if (!lead) throw new Error('controlled_existing_lead_not_found');
  const requiredStatus = opts.resumeAfterAudit ? 'OPPORTUNITY_READY' : 'QUALIFIED';
  if (lead.status !== requiredStatus) {
    throw new Error(`controlled_existing_lead_wrong_status:${lead.status}:required:${requiredStatus}`);
  }
  const context = await new ControlledTestRepository(ctx.db).prospectContextForLead(lead.id);
  if (!context) throw new Error('controlled_existing_lead_missing_prospect_context');
  await withControlledTestGates(ctx.config,
    () => new ControlledTestContinuation(ctx, recipient, {
      stopAfterDraft: true,
      resumeAfterAudit: opts.resumeAfterAudit,
    })
      .continueFirstQualified(lead.id, context),
    { stopAfterDraft: true });
}
