import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { EmailWriterService } from '../../src/domain/email/email-writer-service.js';
import { worstCaseEmailInputTokens } from '../../src/domain/email/email-token-budget.js';
import { EMAIL_SCHEMA_VERSION } from '../../src/domain/email/email-schema.js';
import { EMAIL_REVIEWER_PROMPT_VERSION } from '../../src/prompts/email/index.js';
import { worstCaseCostUsd } from '../../src/integrations/llm/pricing.js';
import {
  ResumeEmailReviewService,
  type ResumeInputs,
} from '../../src/domain/email/resume-email-review.js';
import { decideFollowupPreparation, runFollowupPreparation } from '../../src/domain/outreach/followup-preparation-runner.js';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { defaultMockEmailResponder } from '../../src/fixtures/mock-email-responses.js';
import { type LlmProvider, type LlmRequest, type LlmResult } from '../../src/integrations/llm/provider.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { createResumeCommit } from '../../src/domain/email/resume-commit.js';
import { DrizzleEmailUnitOfWork } from '../../src/persistence/email-unit-of-work.js';
import { DrizzleOutreachUnitOfWork } from '../../src/persistence/outreach-unit-of-work.js';
import { DemoInputRepository } from '../../src/persistence/repositories/demo-input.repo.js';
import { EmailRepository } from '../../src/persistence/repositories/email.repo.js';
import { FollowupPreparationRepository } from '../../src/persistence/repositories/followup-preparation.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { OutreachReadRepository } from '../../src/persistence/repositories/outreach.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { ReviewWriteRepository } from '../../src/persistence/repositories/review.repo.js';
import {
  auditFindings, auditRuns, emailDrafts, modelCalls, opportunityAssessments, outreachFollowups,
  outreachRecords, pipelineEvents,
} from '../../src/persistence/schema.js';

/**
 * RECOVERY OF A FAILED FOLLOW-UP DRAFT, against the REAL migration-0044 constraint.
 *
 *   CREATE UNIQUE INDEX email_drafts_outreach_sequence_uk ON email_drafts (outreach_record_id, sequence_step)
 *     WHERE outreach_record_id IS NOT NULL AND human_decision IS DISTINCT FROM 'REJECTED';
 *
 * The production draft that failed deterministic validation is `human_decision = NULL`, so it is
 * INSIDE that index. Appending a second row for the same (record, step) — which is what the resume
 * path used to do — is a guaranteed unique violation, and would also create two drafts competing
 * for one send slot. Recovery therefore writes the reviewer outcome onto the canonical row.
 *
 * Only a real database can prove this: the index, the writer-provenance preservation, and the
 * downstream queries (preparation idempotency, progression pickup) are all SQL behaviour.
 */

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const TZ = 'Europe/London';
const SENT_AT = Date.parse('2026-09-11T13:01:00Z');
const NOW = Date.parse('2026-09-14T10:00:00Z');
const policy: SequencePolicy = { step1DelayDays: 2, step2DelayDays: 2, step3DelayDays: 3, dueHourLocal: 9 };
const INITIAL_SUBJECT = 'Something I noticed on Complete Dentistry’s mobile site';

const REVIEW = (decision: 'APPROVE' | 'REJECT'): Record<string, unknown> => ({
  decision, fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true, openingSpecific: true,
  businessRelevanceClear: true, urgencySupported: true, competitorClaimsSupported: true, humanStylePass: true,
  punctuationPass: true, singlePrimaryCta: true, sufficientlyPersonalized: true, evidenceSupported: true,
  demoAligned: true, persuasive: true, singleObservation: true, buyerLanguageOnly: true,
  conversationNotAudit: true, confidentObservation: true,
  addsClarityNotRestart: true, compressedNotExpanded: true, pressureReduced: true, binaryReplyClose: true,
  problems: decision === 'APPROVE' ? [] : ['the close is too soft'],
  requiredRevisions: decision === 'APPROVE' ? [] : ['sharpen the ask'],
});

/** Mock writer + scripted reviewer, recording every request so call counts are provable. */
function provider(
  reviewDecision: 'APPROVE' | 'REJECT',
  rawReviewOverride?: unknown,
  name = 'mock',
): { provider: LlmProvider; calls: LlmRequest[]; writerJson: () => unknown } {
  const calls: LlmRequest[] = [];
  let writerJson: unknown = null;
  const p: LlmProvider = {
    name,
    async generate(req: LlmRequest): Promise<LlmResult> {
      calls.push(req);
      let rawJson: unknown;
      if (req.task === 'email_write') {
        rawJson = (defaultMockEmailResponder(req, calls.length - 1) as { rawJson: unknown }).rawJson;
        writerJson = rawJson;
      } else {
        rawJson = rawReviewOverride === undefined ? REVIEW(reviewDecision) : rawReviewOverride;
      }
      return {
        status: 'ok', rawJson, refusal: null, incompleteReason: null, provider: 'mock',
        requestedModel: req.model, resolvedModel: req.model, requestId: `req-${randomUUID()}`,
        responseId: `resp-${randomUUID()}`,
        usage: { inputTokens: 100, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 50, reasoningTokens: null, estimatedCostUsd: 0.02 },
        latencyMs: 5, imageDetail: null,
      };
    },
  };
  return { provider: p, calls, writerJson: () => writerJson };
}

describe('resume recovery of a failed follow-up draft (PostgreSQL, migration 0044)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  const emailConfig = {
    writerModel: 'gpt-5.6-sol', reviewerModel: 'gpt-5.6-terra', writerEffort: 'medium' as const,
    reviewerEffort: 'medium' as const, store: false, timeoutMs: 1000, maxOutputTokens: 1500, maxRetries: 0,
    maxCallsPerLead: 2, maxCostUsdPerLead: 0.5, worstCaseInputTokensPerCall: worstCaseEmailInputTokens(),
  };

  /** A real pipeline run row, which pipeline_events reference by foreign key. */
  const newRun = (label: string): Promise<string> =>
    new PipelineRunsRepository(handle.db).start(`${label}:${randomUUID()}`, true);

  /** A lead whose initial email is sent, whose follow-up 1 is due, and whose evidence is in place. */
  async function seedDueFollowup(): Promise<{ leadId: string; recordId: string; followupId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      for (const [t, v] of [['business_name', 'Complete Dentistry'], ['city', 'Surrey']] as [string, string][]) {
        await fr.writeCurrentFact({ leadId: lead.id, factType: t as never, value: v, normalizedValue: v.toLowerCase(), sourceType: 'website', sourceUrl: null, confidence: 1 });
      }
    });

    const runId = randomUUID();
    await handle.db.insert(auditRuns).values({
      id: runId, leadId: lead.id, outcome: 'AUDITED', rubricVersion: 'r', generatorPromptVersion: 'g',
      reviewerPromptVersion: 'rev', schemaVersion: 's', opportunityRulesVersion: 'opp', opportunityRulesHash: 'h',
      provider: 'mock', requestedAuditModel: 'm', reasoningEffort: 'medium', reasoningMode: 'standard',
      imageDetail: 'high', responseStore: false, inputFingerprint: 'fp', startedAt: new Date(SENT_AT),
    });
    await handle.db.insert(auditFindings).values({
      id: randomUUID(), auditRunId: runId, findingRef: 'F1', category: 'CTA_CLARITY',
      observation: 'The contact action is hard to find on mobile.', affectedUrls: [], affectedProfiles: ['MOBILE'],
      severity: 'MEDIUM', confidence: 0.8, businessImpact: 'i', recommendation: 'Surface the contact action.',
      safeForOutreach: true, reviewDecision: 'APPROVE',
    });
    await handle.db.insert(opportunityAssessments).values({
      id: randomUUID(), auditRunId: runId, leadId: lead.id, conversionScore: 60, mobileScore: 0, trustScore: 0,
      contactabilityScore: 0, overallScore: 60, rulesVersion: 'opp', rulesHash: 'h', breakdown: [], capsApplied: [],
    });

    // The lead has already been sent to: SENT is the sequence re-entry point.
    await leads.updateStatus(lead.id, 'SENT', new Date(SENT_AT));

    const outreach = new OutreachService(new DrizzleOutreachUnitOfWork(handle.db), { now: () => NOW });
    const campaign = await new OutreachReadRepository(handle.db)
      .insertCampaign({ name: `camp-${randomUUID()}`, sequencePolicy: policy, timezone: TZ });
    const tracked = await outreach.track({ campaignId: campaign.id, leadId: lead.id, contactEmail: `r-${randomUUID()}@clinic.example`, timezone: TZ });
    const recordId = tracked.record!.id;
    const enrolled = await outreach.enrollConfirmedSend({
      outreachRecordId: recordId, subject: INITIAL_SUBJECT, body: 'The main contact action is hard to find on mobile.',
      gmailMessageId: `g-${randomUUID()}`, gmailThreadId: `thr-${randomUUID()}`, sentAt: new Date(SENT_AT),
      sendAttemptId: `att-${randomUUID()}`, policy,
    });
    const followupId = enrolled.followup!.id;
    // The due-state promotion phase: INITIAL_SENT -> FOLLOW_UP_1_DUE.
    const promoted = await outreach.promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    expect(promoted.outcome).toBe('PROMOTED');

    return { leadId: lead.id, recordId, followupId };
  }

  async function writeInputs(leadId: string) {
    const facts = await new LeadFactsRepository(handle.db).listCurrentFacts(leadId);
    const audit = await new DemoInputRepository(handle.db).latestAuditForComposer(leadId);
    return { facts, findings: audit?.findings ?? [], demo: null };
  }

  /** Compose the follow-up and have the reviewer REJECT it: the production-like failed draft. */
  async function composeFailedFollowup(leadId: string, recordId: string): Promise<{ draftId: string; writerJson: unknown }> {
    const p = provider('REJECT');
    const service = new EmailWriterService({
      provider: p.provider, uow: new DrizzleEmailUnitOfWork(handle.db), logger, config: emailConfig,
    });
    const inputs = await writeInputs(leadId);
    const thread = await new FollowupPreparationRepository(handle.db).threadContext(recordId);
    const result = await service.write({
      leadId, facts: inputs.facts, findings: inputs.findings, demo: null, opportunityScore: 60,
      recipient: null, outreachRecordId: recordId,
      sequence: { step: 1, threadSubject: thread.threadSubject, priorMessages: thread.priorMessages },
    }, await newRun('compose-followup'));
    expect(result.outcome).toBe('REVIEW_REJECTED');

    const rows = await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('REVIEW_FAILED');
    expect(rows[0]!.sequenceStep).toBe(1);
    expect(rows[0]!.outreachRecordId).toBe(recordId);
    expect(rows[0]!.humanDecision).toBeNull();
    return { draftId: rows[0]!.id, writerJson: p.writerJson() };
  }

  function resumeService(
    writerJson: unknown,
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
    rawReviewOverride?: unknown,
    opts: { providerName?: string; maxCostUsdPerLead?: number } = {},
  ) {
    const p = provider(decision, rawReviewOverride, opts.providerName);
    const emailRepo = new EmailRepository(handle.db);
    const followupRepo = new FollowupPreparationRepository(handle.db);
    const uow = new DrizzleEmailUnitOfWork(handle.db);
    // The EXACT commit the CLI installs — the same factory, not a copy of it.
    const commit = createResumeCommit(uow);

    const service = new ResumeEmailReviewService({
      provider: p.provider,
      debug: { findByLeadAndRun: async (leadId, runId) => ({
        leadId, runId: runId ?? '', outcome: 'REVIEW_REJECTED', draft: writerJson, review: null, violations: [],
        costUsd: 0.02, callsMade: 2, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW).toISOString(),
      }) },
      ports: {
        loadDraft: (id) => emailRepo.getById(id),
        loadLeadStatus: async (id) => (await new LeadsRepository(handle.db).getById(id))?.status ?? null,
        loadInputs: async (id): Promise<ResumeInputs> => writeInputs(id),
        loadThreadContext: (recordId) => followupRepo.threadContext(recordId),
      },
      commit,
      logger,
      config: {
        reviewerModel: 'gpt-5.6-terra', reviewerEffort: 'medium', store: false, timeoutMs: 1000,
        maxOutputTokens: 1500, maxRetries: 0,
        maxCostUsdPerLead: opts.maxCostUsdPerLead ?? 0.5,
        worstCaseInputTokensPerCall: worstCaseEmailInputTokens(),
      },
    });
    return { service, calls: p.calls };
  }

  it('recovers the canonical draft in place: no unique violation, one live draft, writer not re-run', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);

    const writerCallsBefore = await handle.db.select().from(modelCalls)
      .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_write')));
    expect(writerCallsBefore).toHaveLength(1);

    const r = resumeService(failed.writerJson);
    const result = await r.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

    // 1. It succeeded — the insert that used to violate the index never happens.
    expect(result.outcome).toBe('REVIEWED_APPROVED');
    expect(result.newDraftId).toBeNull();
    expect(result.resultDraftId).toBe(failed.draftId);

    // 2. Exactly ONE draft exists for the (outreach record, sequence step) slot, and it is the
    //    original row — recovered, not replaced.
    const slot = await handle.db.select().from(emailDrafts)
      .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
    expect(slot).toHaveLength(1);
    expect(slot[0]!.id).toBe(failed.draftId);
    expect(slot[0]!.status).toBe('APPROVED');
    expect(slot[0]!.reviewerDecision).toBe('APPROVE');
    // Human review is still pending: nothing forged a decision to dodge the index.
    expect(slot[0]!.humanDecision).toBeNull();

    // 3. The writer was NOT called again: one writer call in total, and its provenance is intact.
    const writerCalls = await handle.db.select().from(modelCalls)
      .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_write')));
    expect(writerCalls).toHaveLength(1);
    expect(slot[0]!.writerResponseId).toBe(writerCallsBefore[0]!.responseId);
    expect(slot[0]!.writerPromptVersion).toBe((await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!.writerPromptVersion);

    // 4. The reviewer ran exactly once in the resume.
    expect(r.calls.filter((c) => c.task === 'email_review')).toHaveLength(1);
    expect(r.calls.filter((c) => c.task === 'email_write')).toHaveLength(0);

    // 5. The lead ends where a human can review it.
    const lead = await new LeadsRepository(handle.db).getById(leadId);
    expect(lead?.status).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(result.newLeadStatus).toBe('READY_FOR_HUMAN_APPROVAL');
  });

  it('gives the resumed reviewer the real thread, and keeps the subject byte-identical', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);
    const before = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;

    const r = resumeService(failed.writerJson);
    await r.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

    const review = r.calls.find((c) => c.task === 'email_review')!;
    expect(`${review.system}\n${review.user}`).toContain('already sent (internal step 0)');
    expect(`${review.system}\n${review.user}`).toContain(INITIAL_SUBJECT);

    const after = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
    expect(after.subject).toBe(before.subject);
    expect(after.subject).toBe(`Re: ${INITIAL_SUBJECT}`);
    expect(after.body).toBe(before.body);
  });

  it('preparation does not compose a second draft after recovery', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);
    await resumeService(failed.writerJson).service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

    const prepRepo = new FollowupPreparationRepository(handle.db);
    const composeCalls: string[] = [];
    const report = await runFollowupPreparation({
      now: () => NOW,
      gates: { followupPreparationEnabled: true, outreachTrackingEnabled: true, emailGenerationEnabled: true },
      preflight: () => { /* provider selection is a CLI concern */ },
      maxPerRun: 5,
      dueCandidates: (nowMs, limit) => prepRepo.dueCandidates(nowMs, limit, { recordId }),
      cancelFollowup: async () => { throw new Error('a recovered draft must not be cancelled'); },
      compose: async (c) => { composeCalls.push(c.leadId); return { prepared: false, outcome: 'should not happen' }; },
    });

    expect(composeCalls).toEqual([]);
    expect(report.skipped.map((e) => e.detail).join(' ')).toContain('AWAITING_HUMAN_REVIEW');
    const all = await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, leadId));
    expect(all).toHaveLength(1);
  });

  it('progression finds the recovered draft once a human approves it', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);
    await resumeService(failed.writerJson).service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

    // The human approval that is still mandatory — recorded through the real review repository.
    await new ReviewWriteRepository(handle.db)
      .setEmailHumanDecision(failed.draftId, 'APPROVED', null, 'operator', new Date(NOW));
    await new LeadsRepository(handle.db).updateStatus(leadId, 'HUMAN_APPROVED', new Date(NOW));

    const candidates = await new FollowupPreparationRepository(handle.db).progressionCandidates(10, { leadId });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      emailDraftId: failed.draftId, outreachRecordId: recordId, sequenceStep: 1,
      humanDecision: 'APPROVED', leadStatus: 'HUMAN_APPROVED', recordStatus: 'FOLLOW_UP_1_DUE',
      hasFinalization: false, hasGmailDraft: false, hasActiveSchedule: false,
    });
  });

  it('a rejected resume recovers in place as REVIEW_FAILED and still leaves one draft', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);

    const result = await resumeService(failed.writerJson, 'REJECT').service
      .resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

    expect(result.outcome).toBe('REVIEWED_REJECTED');
    const slot = await handle.db.select().from(emailDrafts)
      .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
    expect(slot).toHaveLength(1);
    expect(slot[0]!.status).toBe('REVIEW_FAILED');
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('EMAIL_REVIEW_FAILED');
  });

  it('proves the constraint is real: inserting a second live draft for the slot is rejected', async () => {
    const { leadId, recordId } = await seedDueFollowup();
    const failed = await composeFailedFollowup(leadId, recordId);
    const row = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;

    // This is exactly what the old append-a-new-row resume did.
    const err = await handle.db.insert(emailDrafts).values({ ...row, id: randomUUID() })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    const pg = (err as { constraint?: string; cause?: { constraint?: string } });
    expect(pg.constraint ?? pg.cause?.constraint).toBe('email_drafts_outreach_sequence_uk');

    // The decision function agrees the existing row still owns the slot.
    const [candidate] = await new FollowupPreparationRepository(handle.db).dueCandidates(NOW, 5, { recordId });
    expect(decideFollowupPreparation(candidate!).action).toBe('SKIP');
  });

  /** Provider-legal, Zod-invalid: 21 problems where the local cap is 20. */
  const tooManyProblems = (): Record<string, unknown> => ({
    ...REVIEW('APPROVE'),
    problems: Array.from({ length: 21 }, (_, i) => `problem ${String(i)}`),
  });

  describe('a paid reviewer call that produced no usable verdict', () => {
    it('accounts the attempt durably and leaves the canonical draft untouched and resumable', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const before = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;

      const r = resumeService(failed.writerJson, 'APPROVE', tooManyProblems());
      const result = await r.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));

      expect(result.outcome).toBe('SCHEMA_INVALID');
      expect(result.violations).toContain('schema_invalid:problems');

      // Exactly ONE canonical draft, still the original row.
      const slot = await handle.db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
      expect(slot).toHaveLength(1);
      const after = slot[0]!;
      expect(after.id).toBe(failed.draftId);

      // Nothing about the draft's state moved.
      expect(after.status).toBe('REVIEW_FAILED');
      expect(after.humanDecision).toBeNull();
      expect(after.subject).toBe(before.subject);
      expect(after.body).toBe(before.body);
      expect(after.writerResponseId).toBe(before.writerResponseId);
      expect(after.writerPromptVersion).toBe(before.writerPromptVersion);
      expect(after.reviewerDecision).toBe(before.reviewerDecision);

      // The spend and the call ARE on the books.
      expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd + 0.02, 6);
      const reviewerCalls = await handle.db.select().from(modelCalls)
        .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_review')));
      // One from the composing run's reviewer, one from this failed resume attempt.
      expect(reviewerCalls).toHaveLength(2);
      const resumed = reviewerCalls.find((c) => c.validationViolations !== null);
      expect(resumed?.validationViolations).toContain('schema_invalid:problems');

      // The lead is untouched, which is what keeps the draft resumable.
      expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('EMAIL_REVIEW_FAILED');

      // And the diagnostic is durable on the timeline, bounded.
      const events = await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, leadId));
      const diagnostic = events
        .map((e) => e.data as { draftWrite?: string; diagnostic?: { issues?: unknown[]; rawExcerpt?: string } } | null)
        .find((d) => d?.draftWrite === 'ACCOUNT_FAILED_ATTEMPT');
      expect(diagnostic?.diagnostic?.issues?.length).toBeGreaterThan(0);
      expect((diagnostic?.diagnostic?.rawExcerpt ?? '').length).toBeLessThanOrEqual(2000);
    });

    it('a retry after the fix succeeds in place, and human approval is still mandatory', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);

      await resumeService(failed.writerJson, 'APPROVE', tooManyProblems()).service
        .resume({ leadId, draftId: failed.draftId }, await newRun('resume-failed'));

      // Same draft, reviewer-only, no writer re-run.
      const retry = resumeService(failed.writerJson);
      const result = await retry.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume-retry'));

      expect(result.outcome).toBe('REVIEWED_APPROVED');
      expect(retry.calls.filter((c) => c.task === 'email_write')).toHaveLength(0);
      const slot = await handle.db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
      expect(slot).toHaveLength(1);
      expect(slot[0]!.id).toBe(failed.draftId);
      expect(slot[0]!.status).toBe('APPROVED');

      // STILL not sendable: a human has not decided, so progression sees nothing.
      expect(slot[0]!.humanDecision).toBeNull();
      expect(await new FollowupPreparationRepository(handle.db).progressionCandidates(10, { leadId })).toEqual([]);

      // Only after the human approves does progression pick it up.
      await new ReviewWriteRepository(handle.db)
        .setEmailHumanDecision(failed.draftId, 'APPROVED', null, 'operator', new Date(NOW));
      await new LeadsRepository(handle.db).updateStatus(leadId, 'HUMAN_APPROVED', new Date(NOW));
      const candidates = await new FollowupPreparationRepository(handle.db).progressionCandidates(10, { leadId });
      expect(candidates.map((c) => c.emailDraftId)).toEqual([failed.draftId]);
    });

    it('repeated failed attempts accumulate cost and calls instead of overwriting', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const before = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const r = await resumeService(failed.writerJson, 'APPROVE', tooManyProblems()).service
          .resume({ leadId, draftId: failed.draftId }, await newRun(`resume-${String(attempt)}`));
        expect(r.outcome).toBe('SCHEMA_INVALID');
      }

      const after = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
      expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd + 3 * 0.02, 6);

      const reviewerCalls = await handle.db.select().from(modelCalls)
        .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_review')));
      expect(reviewerCalls).toHaveLength(4); // the composing run's reviewer + three failed attempts
      expect(new Set(reviewerCalls.map((c) => c.id)).size).toBe(4);

      // Still exactly one draft, still REVIEW_FAILED, still resumable.
      const slot = await handle.db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
      expect(slot).toHaveLength(1);
      expect(slot[0]!.status).toBe('REVIEW_FAILED');
      expect(slot[0]!.humanDecision).toBeNull();
    });
  });

  describe('schema-version provenance and the cumulative budget', () => {
    it('records the reviewer call under the current schema while the draft keeps the writer\'s', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const before = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;

      await resumeService(failed.writerJson, 'APPROVE', tooManyProblems()).service
        .resume({ leadId, draftId: failed.draftId }, await newRun('resume-schema'));
      await resumeService(failed.writerJson).service
        .resume({ leadId, draftId: failed.draftId }, await newRun('resume-schema-2'));

      // The draft's writer provenance is never rewritten, not by the failed attempt and not by the
      // successful in-place recovery.
      const after = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
      expect(after.schemaVersion).toBe(before.schemaVersion);
      expect(after.writerPromptVersion).toBe(before.writerPromptVersion);
      expect(after.writerResponseId).toBe(before.writerResponseId);

      // Both NEW reviewer calls are recorded under the current provider contract.
      const reviewerCalls = await handle.db.select().from(modelCalls)
        .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_review')));
      const resumed = reviewerCalls.filter((c) => c.promptVersion === EMAIL_REVIEWER_PROMPT_VERSION);
      expect(resumed.length).toBeGreaterThanOrEqual(2);
      for (const call of resumed) expect(call.schemaVersion).toBe(EMAIL_SCHEMA_VERSION);
    });

    it('refuses a retry once the accounted spend would breach the per-lead cap', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const spent = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!.totalCostUsd;
      const projected = worstCaseCostUsd('gpt-5.6-terra', worstCaseEmailInputTokens(), 1500)!;

      // A cap that this ONE call fits under, but the draft's accumulated spend does not.
      const r = resumeService(failed.writerJson, 'APPROVE', undefined, {
        providerName: 'openai', maxCostUsdPerLead: spent + projected - 0.0001,
      });
      const result = await r.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume-budget'));

      expect(result.outcome).toBe('REVIEWER_BUDGET_BLOCKED');
      expect(r.calls.filter((c) => c.task === 'email_review')).toHaveLength(0);

      // Nothing was spent, nothing was written.
      const after = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
      expect(after.totalCostUsd).toBeCloseTo(spent, 6);
      expect(after.status).toBe('REVIEW_FAILED');
      const slot = await handle.db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
      expect(slot).toHaveLength(1);
    });

    it('still admits the retry when the cumulative total fits', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const spent = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!.totalCostUsd;
      const projected = worstCaseCostUsd('gpt-5.6-terra', worstCaseEmailInputTokens(), 1500)!;

      const r = resumeService(failed.writerJson, 'APPROVE', undefined, {
        providerName: 'openai', maxCostUsdPerLead: spent + projected + 0.01,
      });
      const result = await r.service.resume({ leadId, draftId: failed.draftId }, await newRun('resume-budget-ok'));

      expect(result.outcome).toBe('REVIEWED_APPROVED');
      expect(r.calls.filter((c) => c.task === 'email_review')).toHaveLength(1);
    });
  });

  describe('regenerating a step-1 follow-up after a human rejected the copy', () => {
    /** The human review decision, through the same repository the dashboard uses. */
    async function rejectCopy(leadId: string, draftId: string): Promise<void> {
      await new ReviewWriteRepository(handle.db)
        .setEmailHumanDecision(draftId, 'REJECTED', 'restates the first email', 'operator', new Date(NOW));
      // Rejecting FOLLOW-UP copy returns the lead to SENT — it never rejects the prospect.
      await new LeadsRepository(handle.db).updateStatus(leadId, 'SENT', new Date(NOW));
    }

    /** One preparation pass over this record, with composition recorded rather than performed. */
    async function prepare(recordId: string, at: number = NOW) {
      const prepRepo = new FollowupPreparationRepository(handle.db);
      const composed: string[] = [];
      const cancelled: string[] = [];
      const outreach = new OutreachService(new DrizzleOutreachUnitOfWork(handle.db), { now: () => at });
      const report = await runFollowupPreparation({
        now: () => at,
        gates: { followupPreparationEnabled: true, outreachTrackingEnabled: true, emailGenerationEnabled: true },
        preflight: () => { /* provider selection is a CLI concern */ },
        maxPerRun: 5,
        dueCandidates: (nowMs, limit) => prepRepo.dueCandidates(nowMs, limit, { recordId }),
        cancelFollowup: async (followupId, id, reason) => {
          cancelled.push(followupId);
          await outreach.cancelFollowup(followupId, id, reason);
        },
        compose: async (c) => { composed.push(`${c.leadId}:${String(c.step)}`); return { prepared: true, outcome: 'APPROVED_READY' }; },
      });
      return { report, composed, cancelled };
    }

    it('cancels the pending row for rejected copy, then composes fresh copy once the step is rescheduled', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      // Make it a normal approved-then-rejected draft: recover it, then reject in human review.
      await resumeService(failed.writerJson).service.resume({ leadId, draftId: failed.draftId }, await newRun('resume'));
      await rejectCopy(leadId, failed.draftId);

      // 1. The runner reconciles the pending row for that rejected copy.
      const first = await prepare(recordId);
      expect(first.composed).toEqual([]);
      expect(first.cancelled).toHaveLength(1);
      expect(first.report.cancelled).toHaveLength(1);

      // The rejected draft is preserved exactly as it was, and the outreach record is untouched.
      const rejected = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
      expect(rejected.humanDecision).toBe('REJECTED');
      expect(rejected.status).toBe('APPROVED');
      const [record] = await handle.db.select().from(outreachRecords).where(eq(outreachRecords.id, recordId));
      expect(record?.status).toBe('FOLLOW_UP_1_DUE');

      // 2. The operator re-schedules step 1 through the normal path — the ONLY way a replacement is
      //    requested. What makes it a REPLACEMENT is that the new row is created AFTER the rejected
      //    draft; before this fix the next run cancelled THIS row too, because the rejected draft was
      //    still the newest one for the slot, and regeneration was impossible.
      const later = rejected.createdAt.getTime() + 60_000;
      const scheduled = await new OutreachService(new DrizzleOutreachUnitOfWork(handle.db), { now: () => later })
        .scheduleFollowup(recordId, 1, { ...policy, step1DelayDays: 0 });
      expect(scheduled.outcome).toBe('SCHEDULED');
      expect(scheduled.followup!.createdAt.getTime()).toBeGreaterThan(rejected.createdAt.getTime());

      // 3. Now preparation composes fresh copy instead of cancelling.
      const second = await prepare(recordId, later + 86_400_000);
      expect(second.cancelled).toEqual([]);
      expect(second.composed).toEqual([`${leadId}:1`]);

      // Exactly one pending follow-up row, and the rejected draft still untouched.
      const pending = await handle.db.select().from(outreachFollowups)
        .where(and(eq(outreachFollowups.outreachRecordId, recordId), eq(outreachFollowups.status, 'DUE')));
      expect(pending).toHaveLength(1);
      const stillThere = (await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!;
      expect(stillThere.humanDecision).toBe('REJECTED');
      expect(stillThere.body).toBe(rejected.body);
    });

    it('lets a NEW draft occupy the slot the rejected one vacated, without touching migration 0044', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      await rejectCopy(leadId, failed.draftId);

      // The partial index excludes REJECTED rows, so a replacement insert for the same slot is legal.
      const replacement = { ...(await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, failed.draftId)))[0]!, id: randomUUID(), humanDecision: null };
      await expect(handle.db.insert(emailDrafts).values(replacement)).resolves.toBeDefined();

      const slot = await handle.db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.outreachRecordId, recordId), eq(emailDrafts.sequenceStep, 1)));
      expect(slot).toHaveLength(2);
      // Exactly ONE of them is live; the rejected one is history.
      expect(slot.filter((d) => d.humanDecision !== 'REJECTED')).toHaveLength(1);

      // ...and a SECOND live row is still refused.
      const second = await handle.db.insert(emailDrafts).values({ ...replacement, id: randomUUID() })
        .then(() => null, (e: unknown) => e);
      const pg = second as { constraint?: string; cause?: { constraint?: string } };
      expect(pg.constraint ?? pg.cause?.constraint).toBe('email_drafts_outreach_sequence_uk');
    });

    it('does not re-run the writer until preparation is invoked again', async () => {
      const { leadId, recordId } = await seedDueFollowup();
      const failed = await composeFailedFollowup(leadId, recordId);
      const writerCallsBefore = (await handle.db.select().from(modelCalls)
        .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_write')))).length;

      await rejectCopy(leadId, failed.draftId);

      // Rejection alone composes nothing: no writer call, and the lead simply waits at SENT.
      const after = (await handle.db.select().from(modelCalls)
        .where(and(eq(modelCalls.leadId, leadId), eq(modelCalls.purpose, 'email_write')))).length;
      expect(after).toBe(writerCallsBefore);
      expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('SENT');
    });
  });
});
