import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { scheduleIntegrityFingerprint } from '../../src/domain/schedule/fingerprint.js';
import { SendService, type SendConfig } from '../../src/domain/send/send-service.js';
import { SendAdminService } from '../../src/domain/send/send-admin-service.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { DrizzleSendUnitOfWork } from '../../src/persistence/send-unit-of-work.js';
import { SendRepository } from '../../src/persistence/repositories/send.repo.js';
import { SendAdminRepository } from '../../src/persistence/repositories/send-admin.repo.js';
import { SendInputRepository } from '../../src/persistence/repositories/send-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { MockSendProvider } from '../../src/integrations/send/mock-send.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import {
  demoDecisions,
  demoDeploymentRuns,
  demos,
  emailDraftFinalizations,
  emailDrafts,
  gmailDrafts,
  leads as leadsTbl,
  pipelineEvents,
  sendAttempts,
  sendSchedules,
  sendingReadinessApprovals,
} from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });
const TZ = 'America/New_York';
const RECIP = 'contact@example.invalid';
const ACCOUNT = 'sender@example.invalid';
const SENDER = 'Example Sender';
const POLICY = 'send-policy-1';
const RULES_V = 'sched-rules-1';
const CONTENT = 'contenthash1';
const SUBJECT = 'Note';
const NOW = Date.parse('2026-07-20T13:00:00Z');
const SCHEDULED_AT = new Date(NOW - 10 * 60_000); // 10 minutes ago (due, within the 60-min late window)

const cfg: SendConfig = { gmailAccount: ACCOUNT, senderName: SENDER, policyVersion: POLICY, sendingEnabled: true, outboundActionsEnabled: true, dryRun: false, maxLateMs: 60 * 60_000, confirmationTtlMs: 120_000, dailyCap: 1 };

describe.skipIf(!DATABASE_URL)('controlled sending (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= createDb(DATABASE_URL as string); await truncateAll(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(): Promise<{ leadId: string; scheduleId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'contact_email', value: RECIP, normalizedValue: RECIP, sourceType: 'website', sourceUrl: null, confidence: 1 });
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'contact_timezone', value: TZ, normalizedValue: TZ.toLowerCase(), sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    for (const s of ['OPPORTUNITY_READY', 'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'WAITING_FOR_DEMO_URL', 'FINALIZED_EMAIL_PENDING', 'HUMAN_APPROVED', 'DRAFT_CREATED', 'SCHEDULED'])
      await leads.updateStatus(lead.id, s as never, new Date());

    const decId = randomUUID(), demoId = randomUUID(), emailId = randomUUID(), depId = randomUUID(), gId = randomUUID(), sId = randomUUID(), rId = randomUUID(), finId = randomUUID();
    await handle.db.insert(demoDecisions).values({ id: decId, leadId: lead.id, decision: 'BUILD_DEMO', outcome: 'DEMO_COMPOSED', reason: 'seed', opportunityScore: 60, minOpportunity: 0, justifiedByScore: true, justifiedByFinding: true, briefRulesVersion: 'x' });
    await handle.db.insert(demos).values({ id: demoId, leadId: lead.id, demoDecisionId: decId, templateId: 'composer-v1', templateVersion: 't', path: '/demos/seed', status: 'APPROVED', noindexVerified: true, disclosurePresent: true, contentHash: 'h', ctaKind: 'scroll', factsUsed: [], findingRefs: [] });
    await handle.db.insert(emailDrafts).values({ id: emailId, leadId: lead.id, runId: null, subject: SUBJECT, body: 'Hallo, {{SENDER_NAME}}', ctaKind: 'demo_link', hasDemoUrlPlaceholder: true, status: 'APPROVED', writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v', provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', reviewerDecision: 'APPROVE', humanDecision: 'APPROVED', totalCostUsd: 0 });
    await handle.db.insert(demoDeploymentRuns).values({ id: depId, leadId: lead.id, demoId, originalEmailDraftId: emailId, provider: 'http-netlify', siteId: 's', deployId: 'd1', artifactHash: 'h', attemptFingerprint: 'fp', outcome: 'DEPLOYED_AND_VERIFIED', draftUrl: 'https://x', verifiedUrl: 'https://x', callsMade: 0, startedAt: new Date(), completedAt: new Date() });
    await handle.db.insert(emailDraftFinalizations).values({ id: finId, originalDraftId: emailId, deploymentRunId: depId, verifiedDeploymentUrl: 'https://deploy.example.invalid/', originalBodyHash: 'oh', resolvedBody: 'Hallo, {{SENDER_NAME}}', resolvedBodyHash: CONTENT, finalHumanDecision: 'APPROVED', finalReviewedAt: new Date(NOW - 2000), finalReviewedBy: 'Example Operator' });
    await handle.db.insert(gmailDrafts).values({ id: gId, leadId: lead.id, finalizedEmailId: finId, recipientEmail: RECIP, senderEmail: ACCOUNT, gmailAccount: ACCOUNT, provider: 'mock-gmail', providerDraftId: 'provider-draft-example', threadId: 'fictional-thread', messageId: 'fictional-message', idempotencyFingerprint: 'gfp', sourceEmailVersion: CONTENT, outcome: 'DRAFT_CREATED', createdAt: new Date(), completedAt: new Date() });

    const fp = scheduleIntegrityFingerprint({ leadId: lead.id, gmailDraftId: gId, providerDraftId: 'provider-draft-example', finalizedContentHash: CONTENT, recipientEmail: RECIP, scheduledAtUtcMs: SCHEDULED_AT.getTime(), rulesVersion: RULES_V });
    await handle.db.insert(sendSchedules).values({ id: sId, leadId: lead.id, gmailDraftId: gId, providerDraftId: 'provider-draft-example', finalizedContentHash: CONTENT, recipientEmail: RECIP, scheduledAtUtc: SCHEDULED_AT, timezone: TZ, rulesVersion: RULES_V, computedFrom: {}, integrityFingerprint: fp, origin: 'auto', status: 'SCHEDULED', rescheduleCount: 0 });
    await handle.db.insert(sendingReadinessApprovals).values({ id: rId, gmailAccount: ACCOUNT, policyVersion: POLICY, approvedBy: 'operator', approvedAt: new Date(NOW - 1000), expiresAt: new Date(NOW + 3_600_000) });
    return { leadId: lead.id, scheduleId: sId };
  }

  const scriptedProvider = () => new MockSendProvider({ account: { ok: true, email: ACCOUNT }, draft: { outcome: 'ok', providerDraftId: 'provider-draft-example', providerMessageId: 'fictional-message', providerThreadId: 'fictional-thread', envelope: { fromName: SENDER, fromEmail: ACCOUNT, to: [RECIP], cc: [], bcc: [], replyTo: null, subject: SUBJECT, body: `Hallo, ${SENDER}`, attachmentCount: 0 } } });
  const service = (provider = scriptedProvider()) => new SendService({ provider, store: new SendRepository(handle.db), uow: new DrizzleSendUnitOfWork(handle.db), logger, config: cfg, now: () => NOW });

  function uncertainService() {
    const provider = new MockSendProvider({ account: { ok: true, email: ACCOUNT }, draft: { outcome: 'ok',
      providerDraftId: 'provider-draft-example', providerMessageId: 'fictional-message', providerThreadId: 'fictional-thread',
      envelope: { fromName: SENDER, fromEmail: ACCOUNT, to: [RECIP], cc: [], bcc: [], replyTo: null, subject: SUBJECT,
        body: `Hallo, ${SENDER}`, attachmentCount: 0 } }, send: { outcome: 'unknown', reason: 'fictional_timeout' } });
    return { provider, service: new SendService({ provider, store: new SendRepository(handle.db),
      uow: new DrizzleSendUnitOfWork(handle.db), logger, config: cfg, now: () => NOW }) };
  }

  function admin(now = NOW + 1000) {
    return new SendAdminService(new SendAdminRepository(handle.db), { gmailAccount: ACCOUNT,
      policyVersion: POLICY }, () => now);
  }

  async function buildInput(leadId: string) {
    const data = await new SendInputRepository(handle.db).latest(leadId);
    const lead = await new LeadsRepository(handle.db).getById(leadId);
    return {
      leadId, leadStatus: lead?.status ?? 'UNKNOWN', schedule: data.schedule, currentGmailDraft: data.currentGmailDraft,
      finalization: data.finalization, currentFinalizedContentHash: data.currentFinalizedContentHash, currentRecipientEmail: data.currentRecipientEmail, subject: data.subject,
      normalizedDomain: data.normalizedDomain, normalizedPhone: data.normalizedPhone, placeId: data.placeId,
      confirmation: null, preflightProof: null,
    };
  }

  async function execute(serviceUnderTest: SendService, leadId: string, runId: string) {
    const input = await buildInput(leadId);
    const preflight = await serviceUnderTest.preflight(input);
    expect(preflight.outcome).toBe('READY');
    const proof = preflight.preflightProof!;
    return serviceUnderTest.send({ ...input, preflightProof: proof, confirmation: { observedSendFingerprint: proof.sendFingerprint, confirmedBy: 'Example Operator', confirmedAtMs: NOW } }, runId);
  }

  it('sends (mock): SCHEDULED→SENT, schedule FULFILLED, one SENT_CONFIRMED attempt; re-run is ALREADY_SENT', async () => {
    const { leadId, scheduleId } = await seed();
    const runs = new PipelineRunsRepository(handle.db);
    const instance = service();
    const r = await execute(instance, leadId, await runs.start('send:1', false));
    expect(r.outcome).toBe('SENT_CONFIRMED');

    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SENT');
    const sched = (await handle.db.select().from(sendSchedules).where(eq(sendSchedules.id, scheduleId)))[0];
    expect(sched?.status).toBe('FULFILLED');
    expect(sched?.fulfilledAt).toBeTruthy();
    const attempts = await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('SENT_CONFIRMED');
    expect(attempts[0]?.providerMessageId).toBeTruthy();

    // Re-running is refused: the schedule is now FULFILLED (no active schedule) and the lead is
    // SENT, so no second send occurs and no second attempt row is created.
    const r2 = await instance.preflight(await buildInput(leadId));
    expect(r2.outcome).toBe('INVALID_ELIGIBILITY');
    expect(r2.reason).toContain('no_active_schedule');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(1);
  });

  it('read-only preflight reports binding drift; only send execution invalidates and routes to manual review', async () => {
    const { leadId, scheduleId } = await seed();
    // Change the current verified recipient so the recomputed integrity fingerprint no longer matches.
    await handle.db.transaction(async (tx) => {
      await new LeadFactsRepository(tx).writeCurrentFact({ leadId, factType: 'contact_email', value: 'moved@example.invalid', normalizedValue: 'moved@example.invalid', sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    const provider = scriptedProvider(); const instance = service(provider);
    const eventsBefore = (await handle.db.select().from(pipelineEvents)).length;
    const r = await instance.preflight(await buildInput(leadId));
    expect(r.outcome).toBe('BINDING_INVALIDATED');
    expect((await handle.db.select().from(sendSchedules).where(eq(sendSchedules.id, scheduleId)))[0]?.status).toBe('SCHEDULED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SCHEDULED');
    expect((await handle.db.select().from(pipelineEvents)).length).toBe(eventsBefore);
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(0);
    expect(provider.verified).toHaveLength(0); expect(provider.inspected).toHaveLength(0); expect(provider.sent).toHaveLength(0);

    const executed = await instance.send(await buildInput(leadId), 'run-binding-drift');
    expect(executed.outcome).toBe('BINDING_INVALIDATED');
    expect((await handle.db.select().from(sendSchedules).where(eq(sendSchedules.id, scheduleId)))[0]?.status).toBe('INVALIDATED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('NEEDS_MANUAL_REVIEW');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(0);
    expect(provider.verified).toHaveLength(0); expect(provider.inspected).toHaveLength(0); expect(provider.sent).toHaveLength(0);
  });

  it('is inert when the kill switches are disabled (SENDING_DISABLED, nothing written)', async () => {
    const { leadId, scheduleId } = await seed();
    const disabled = new SendService({ provider: new MockSendProvider(), store: new SendRepository(handle.db), uow: new DrizzleSendUnitOfWork(handle.db), logger, config: { ...cfg, sendingEnabled: false }, now: () => NOW });
    const r = await disabled.send(await buildInput(leadId), '');
    expect(r.outcome).toBe('SENDING_DISABLED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SCHEDULED');
    expect((await handle.db.select().from(sendSchedules).where(eq(sendSchedules.id, scheduleId)))[0]?.status).toBe('SCHEDULED');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(0);
  });

  it('dedicated confirmed-sent reconciliation preserves OUTCOME_UNKNOWN, fulfills once, and rejects a duplicate', async () => {
    const { leadId, scheduleId } = await seed();
    const uncertain = uncertainService();
    expect((await execute(uncertain.service, leadId, await new PipelineRunsRepository(handle.db).start('send:unknown', false))).outcome).toBe('OUTCOME_UNKNOWN');
    const before = await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId));
    expect(before).toHaveLength(1); expect(before[0]?.status).toBe('OUTCOME_UNKNOWN');
    const attemptId = before[0]!.id;
    const sendCallsBeforeReconciliation = uncertain.provider.sent.length;
    const ops = admin();
    const phrase = ops.reconciliationPhrase(attemptId, 'CONFIRMED_SENT');
    expect(await ops.reconcile({ attemptId, outcome: 'CONFIRMED_SENT', reconciledBy: 'Example Operator',
      note: 'Fictional provider evidence reference.', observedPhrase: phrase })).toBe('SENT_CONFIRMED');
    const after = await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId));
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('OUTCOME_UNKNOWN');
    expect(after[0]?.reconciledOutcome).toBe('CONFIRMED_SENT');
    expect((await handle.db.select().from(sendSchedules).where(eq(sendSchedules.id, scheduleId)))[0]?.status).toBe('FULFILLED');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SENT');
    expect(uncertain.provider.sent.length).toBe(sendCallsBeforeReconciliation);
    const audit = await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, leadId));
    expect(audit.some((e) => (e.data as { originalAttemptStatus?: string } | null)?.originalAttemptStatus === 'OUTCOME_UNKNOWN')).toBe(true);
    await expect(ops.reconcile({ attemptId, outcome: 'CONFIRMED_SENT', reconciledBy: 'Example Operator',
      note: 'Duplicate fictional evidence.', observedPhrase: phrase })).rejects.toThrow('not_unresolved_unknown');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(1);
  });

  it('confirmed-not-sent requires intact bindings, returns to SCHEDULED, and requires fresh readiness', async () => {
    const { leadId, scheduleId } = await seed();
    const uncertain = uncertainService();
    await execute(uncertain.service, leadId, await new PipelineRunsRepository(handle.db).start('send:not-sent', false));
    const attempt = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId)))[0]!;
    await handle.db.update(sendSchedules).set({ finalizedContentHash: 'changed-fictional-hash' }).where(eq(sendSchedules.id, scheduleId));
    const ops = admin();
    const phrase = ops.reconciliationPhrase(attempt.id, 'CONFIRMED_NOT_SENT');
    await expect(ops.reconcile({ attemptId: attempt.id, outcome: 'CONFIRMED_NOT_SENT', reconciledBy: 'Example Operator',
      note: 'Fictional provider non-delivery evidence.', observedPhrase: phrase })).rejects.toThrow('content_binding_changed');
    await handle.db.update(sendSchedules).set({ finalizedContentHash: CONTENT }).where(eq(sendSchedules.id, scheduleId));
    expect(await ops.reconcile({ attemptId: attempt.id, outcome: 'CONFIRMED_NOT_SENT', reconciledBy: 'Example Operator',
      note: 'Fictional provider non-delivery evidence.', observedPhrase: phrase })).toBe('DEFINITIVE_FAILURE');
    const reconciled = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.id, attempt.id)))[0];
    expect(reconciled?.status).toBe('OUTCOME_UNKNOWN'); expect(reconciled?.reconciledOutcome).toBe('CONFIRMED_NOT_SENT');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('SCHEDULED');
    expect((await uncertain.service.preflight(await buildInput(leadId))).outcome).toBe('READINESS_INVALID');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(1);
  });

  it('unresolved reconciliation remains OUTCOME_UNKNOWN and blocks retry without a second attempt', async () => {
    const { leadId, scheduleId } = await seed();
    const uncertain = uncertainService();
    await execute(uncertain.service, leadId, await new PipelineRunsRepository(handle.db).start('send:unresolved', false));
    const attempt = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId)))[0]!;
    const ops = admin();
    expect(await ops.reconcile({ attemptId: attempt.id, outcome: 'UNRESOLVED', reconciledBy: 'Example Operator',
      note: 'Fictional evidence remains inconclusive.', observedPhrase: ops.reconciliationPhrase(attempt.id, 'UNRESOLVED') })).toBe('UNCHANGED');
    const current = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.id, attempt.id)))[0];
    expect(current?.status).toBe('OUTCOME_UNKNOWN'); expect(current?.reconciledOutcome).toBeNull();
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('NEEDS_MANUAL_REVIEW');
    expect((await uncertain.service.preflight(await buildInput(leadId))).outcome).toBe('DUPLICATE_PREVENTED');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(1);
  });

  it('recovers CALL_STARTED only through the explicit admin path and preserves retry blocking', async () => {
    const { leadId, scheduleId } = await seed(); const uncertain = uncertainService();
    await execute(uncertain.service, leadId, await new PipelineRunsRepository(handle.db).start('send:crash-fixture', false));
    const attempt = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId)))[0]!;
    await handle.db.update(sendAttempts).set({ status: 'CALL_STARTED', errorClass: null, completedAt: null }).where(eq(sendAttempts.id, attempt.id));
    await handle.db.update(leadsTbl).set({ status: 'SCHEDULED' }).where(eq(leadsTbl.id, leadId));
    const ops = admin(); const phrase = ops.recoveryPhrase(attempt.id);
    expect(await ops.recoverStarted({ attemptId: attempt.id, recoveredBy: 'Example Operator',
      note: 'Fictional process-crash evidence.', observedPhrase: phrase })).toBe(true);
    const recovered = (await handle.db.select().from(sendAttempts).where(eq(sendAttempts.id, attempt.id)))[0];
    expect(recovered?.status).toBe('OUTCOME_UNKNOWN'); expect(recovered?.errorClass).toBe('crash_after_call_started');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('NEEDS_MANUAL_REVIEW');
    expect((await uncertain.service.preflight(await buildInput(leadId))).outcome).toBe('DUPLICATE_PREVENTED');
    expect(await handle.db.select().from(sendAttempts).where(eq(sendAttempts.scheduleId, scheduleId))).toHaveLength(1);
  });

  it('creates, reports, and revokes one expiring fictional readiness approval without sending', async () => {
    const ops = admin();
    const created = await ops.createReadiness({ approvedBy: 'Example Operator', expiresInMinutes: 15 });
    expect(created.expiresAt.getTime()).toBe(NOW + 1000 + 15 * 60_000);
    expect((await ops.status())?.id).toBe(created.id);
    expect(await ops.revokeReadiness({ id: created.id, revokedBy: 'Example Operator',
      reason: 'Fictional readiness lifecycle test complete.' })).toBe(true);
    expect((await ops.status())?.revokedAt).not.toBeNull();
    expect(await handle.db.select().from(sendAttempts)).toHaveLength(0);
  });
});
