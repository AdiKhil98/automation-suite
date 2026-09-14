import { describe, expect, it } from 'vitest';
import {
  ResumeEmailReviewService,
  ResumeReviewAbort,
  type PersistedDraftRow,
  type ResumeCommitPlan,
  type ResumeInputs,
  type ResumeReviewConfig,
  type ResumeThreadContext,
} from '../../src/domain/email/resume-email-review.js';
import { renderEmail, type EmailFinding, type EmailInputs } from '../../src/domain/email/email-render.js';
import { type EmailWriterOutput } from '../../src/domain/email/email-types.js';
import { type EmailDebugRecord } from '../../src/integrations/email/email-debug-store.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type LlmProvider, type LlmRequest, type LlmResult, type LlmStatus } from '../../src/integrations/llm/provider.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';

const LEAD = 'lead-1';
const RUN = 'run-1';
const DRAFT = 'draft-1';

const fixtureWriter = (name: string): EmailWriterOutput =>
  EMAIL_COPY_FIXTURES.find((f) => f.name === name)!.writer;

const businessFact: LeadFact = {
  id: 'fact-business', leadId: LEAD, factType: 'business_name', value: 'Linden Dental', normalizedValue: null,
  sourceType: 'mock', sourceUrl: null, capturedAt: new Date('2026-08-01T00:00:00Z'), confidence: 1,
  supersededBy: null, supersededAt: null, isCurrent: true,
};

const ctaFinding: EmailFinding = {
  id: 'finding-cta', findingRef: 'F1', category: 'CTA_CLARITY', safeForOutreach: true,
  observation: 'The appointment action is hard to find on the homepage.',
  recommendation: 'Surface the appointment action prominently on the homepage.',
};

const inputs: ResumeInputs = { facts: [businessFact], findings: [ctaFinding], demo: null };
const emailInputs: EmailInputs = { facts: inputs.facts, findings: inputs.findings, demo: inputs.demo };

const approveReview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  decision: 'APPROVE', fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true, openingSpecific: true,
  businessRelevanceClear: true, urgencySupported: true, competitorClaimsSupported: true, humanStylePass: true,
  punctuationPass: true, singlePrimaryCta: true, sufficientlyPersonalized: true, evidenceSupported: true,
  demoAligned: true, persuasive: true, singleObservation: true, buyerLanguageOnly: true,
  conversationNotAudit: true, confidentObservation: true,
  // Sequence-job dimensions (all reported every time; the gate enforces the step's subset).
  addsClarityNotRestart: true, compressedNotExpanded: true, pressureReduced: true, binaryReplyClose: true,
  problems: [], requiredRevisions: [], ...over,
});

const config: ResumeReviewConfig = {
  reviewerModel: 'gpt-5.6-terra', reviewerEffort: 'medium', store: false, timeoutMs: 1000, maxOutputTokens: 1500,
  maxRetries: 0, maxCostUsdPerLead: 0.2, worstCaseInputTokensPerCall: 1000,
};

function fakeProvider(rawJson: unknown, status: LlmStatus = 'ok'): { provider: LlmProvider; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: 'mock',
    async generate(req: LlmRequest): Promise<LlmResult> {
      calls.push(req);
      return {
        status, rawJson, refusal: null, incompleteReason: null, provider: 'mock', requestedModel: req.model,
        resolvedModel: req.model, requestId: 'req-1', responseId: 'resp-1',
        usage: { inputTokens: 100, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 50, reasoningTokens: null, estimatedCostUsd: 0.02 },
        latencyMs: 5, imageDetail: null,
      };
    },
  };
  return { provider, calls };
}

/** A persisted draft row whose subject/body are the EXACT render of `draft` (integrity passes). */
function rowFor(draft: EmailWriterOutput, over: Partial<PersistedDraftRow> = {}): PersistedDraftRow {
  const rendered = renderEmail(draft, emailInputs);
  return {
    id: DRAFT, leadId: LEAD, runId: RUN, status: 'REVIEW_FAILED', subject: rendered.subject, body: rendered.body,
    demoId: null, writerPromptVersion: 'email-writer-3', schemaVersion: 'email-copy-schema-3',
    rulesVersion: 'email-copy-standard-3', provider: 'openai', requestedWriterModel: 'gpt-5.6-sol',
    writerResponseId: 'writer-resp-1', sequenceStep: 0, outreachRecordId: null, threadSubject: null,
    totalCostUsd: 0.055, ...over,
  };
}

function debugRecord(draft: EmailWriterOutput): EmailDebugRecord {
  return {
    leadId: LEAD, runId: RUN, outcome: 'VALIDATION_FAILED', draft, review: null, violations: ['cta_in_model_body'],
    costUsd: 0.055, callsMade: 1, createdAt: '2026-08-27T19:18:02.953Z', expiresAt: '2026-09-03T19:18:02.953Z',
  };
}

/** The email row an APPEND plan would insert (unbound drafts only). */
function appendedEmail(plan: ResumeCommitPlan) {
  if (plan.write.kind !== 'APPEND') throw new Error(`expected an APPEND write, got ${plan.write.kind}`);
  return plan.write.persist.email;
}

/** The in-place recovery a sequence-bound draft must produce. */
function recovery(plan: ResumeCommitPlan) {
  if (plan.write.kind !== 'RECOVER_IN_PLACE') throw new Error(`expected RECOVER_IN_PLACE, got ${plan.write.kind}`);
  return plan.write;
}

interface Harness {
  service: ResumeEmailReviewService;
  calls: LlmRequest[];
  committed: ResumeCommitPlan[];
}

/** The authoritative thread a follow-up continues: the initial email, exactly as it was sent. */
const INITIAL_SENT_SUBJECT = 'Something I noticed on Complete Dentistry’s mobile site';
const INITIAL_SENT_BODY = 'The main contact action on your site is currently hard to find.';
const defaultThread: ResumeThreadContext = {
  threadSubject: INITIAL_SENT_SUBJECT,
  priorMessages: [{ sequenceStep: 0, subject: INITIAL_SENT_SUBJECT, body: INITIAL_SENT_BODY }],
};

function harness(opts: {
  rawReview?: unknown;
  status?: LlmStatus;
  row?: PersistedDraftRow | null;
  leadStatus?: string | null;
  record?: EmailDebugRecord | null;
  thread?: ResumeThreadContext | null;
}): Harness {
  const { provider, calls } = fakeProvider(opts.rawReview ?? approveReview(), opts.status ?? 'ok');
  const committed: ResumeCommitPlan[] = [];
  const service = new ResumeEmailReviewService({
    provider,
    debug: { findByLeadAndRun: async () => (opts.record === undefined ? debugRecord(fixtureWriter('strong English business email')) : opts.record) },
    ports: {
      loadDraft: async () => (opts.row === undefined ? rowFor(fixtureWriter('strong English business email')) : opts.row),
      loadLeadStatus: async () => (opts.leadStatus === undefined ? 'EMAIL_REVIEW_FAILED' : opts.leadStatus),
      loadInputs: async () => inputs,
      loadThreadContext: async () => (opts.thread === undefined ? defaultThread : opts.thread),
    },
    commit: async (plan) => { committed.push(plan); },
    logger: { info() {}, warn() {}, error() {} } as never,
    config,
  });
  return { service, calls, committed };
}

describe('resume-email-review — threaded follow-ups', () => {
  // The retry path for a follow-up that failed deterministic validation: it re-validates with the
  // CURRENT validator and calls the reviewer once, WITHOUT paying for another writer call.
  const THREAD_SUBJECT = INITIAL_SENT_SUBJECT;
  const STORED_SUBJECT = `Re: ${THREAD_SUBJECT}`;

  /** What a correctly-behaved follow-up writer produced: the thread subject, three times. */
  const followupDraft = (over: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
    ...fixtureWriter('strong English business email'),
    subject_options: [THREAD_SUBJECT, THREAD_SUBJECT, THREAD_SUBJECT],
    selected_subject: THREAD_SUBJECT,
    selected_subject_reason: 'Thread continuity is preserved.',
    ...over,
  });

  /** The persisted row for such a draft: the stored subject already carries its `Re: ` prefix. */
  const followupRow = (draft: EmailWriterOutput, step: 1 | 2 | 3 = 1, over: Partial<PersistedDraftRow> = {}): PersistedDraftRow => {
    const rendered = renderEmail(draft, { ...emailInputs, threadSubject: THREAD_SUBJECT });
    return {
      ...rowFor(draft),
      subject: rendered.subject,
      body: rendered.body,
      sequenceStep: step,
      outreachRecordId: 'rec-1',
      threadSubject: rendered.subject,
      ...over,
    };
  };

  it.each([1, 2, 3] as const)('gives the step-%i reviewer the ACTUAL messages already sent in the thread', async (step) => {
    // The sequence rubric judges continuity — add clarity without restarting, compress without
    // re-explaining, close without reopening. None of that is judgeable against "(none)".
    const draft = followupDraft();
    const h = harness({ row: followupRow(draft, step), record: debugRecord(draft) });

    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(h.calls).toHaveLength(1);
    const prompt = `${h.calls[0]!.system}\n${h.calls[0]!.user}`;
    expect(prompt).toContain(INITIAL_SENT_BODY);
    expect(prompt).toContain('already sent (internal step 0)');
    expect(prompt).toContain(`subject: ${INITIAL_SENT_SUBJECT}`);
    // The thread section must carry real messages, never the empty placeholder.
    const threadSection = prompt.slice(prompt.indexOf('ALREADY SENT IN THIS THREAD'));
    expect(threadSection).not.toContain('(none)');
  });

  it.each([1, 2, 3] as const)('recovers a step-%i follow-up IN PLACE instead of appending a duplicate draft', async (step) => {
    // Migration 0044 allows ONE live draft per (outreach record, sequence step). The failed row is
    // that draft, so the reviewer outcome is written onto it — appending a second row would both
    // violate `email_drafts_outreach_sequence_uk` and create two drafts for one send slot.
    const draft = followupDraft();
    const h = harness({ row: followupRow(draft, step), record: debugRecord(draft) });

    const result = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(result.outcome).toBe('REVIEWED_APPROVED');
    expect(h.calls).toHaveLength(1);
    const rec = recovery(h.committed[0]!);
    expect(rec.draftId).toBe(DRAFT);
    expect(rec.update.status).toBe('APPROVED');
    expect(rec.update.reviewerDecision).toBe('APPROVE');
    expect(rec.modelCalls).toHaveLength(1);
    expect(rec.modelCalls[0]?.purpose).toBe('email_review');
    // No new row, and the result names the recovered canonical draft.
    expect(result.newDraftId).toBeNull();
    expect(result.resultDraftId).toBe(DRAFT);
    // Cumulative cost accounting: the writer attempt already on the row plus this reviewer call.
    expect(rec.update.totalCostUsd).toBeCloseTo(0.055 + 0.02, 6);
  });

  it('never forges a human decision to get past the uniqueness index', async () => {
    const draft = followupDraft();
    const h = harness({ row: followupRow(draft), record: debugRecord(draft) });
    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    const update: Record<string, unknown> = { ...recovery(h.committed[0]!).update };
    expect(Object.keys(update)).not.toContain('humanDecision');
    expect(Object.keys(update)).not.toContain('human_decision');
    // Nor does it touch anything the writer produced.
    for (const writerColumn of ['subject', 'body', 'writerResponseId', 'writerPromptVersion', 'sequenceStep', 'outreachRecordId']) {
      expect(Object.keys(update)).not.toContain(writerColumn);
    }
  });

  it('a rejected review recovers in place as REVIEW_FAILED, still without a duplicate row', async () => {
    const draft = followupDraft();
    const h = harness({
      row: followupRow(draft), record: debugRecord(draft), rawReview: approveReview({ decision: 'REJECT' }),
    });

    const result = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(result.outcome).toBe('REVIEWED_REJECTED');
    expect(recovery(h.committed[0]!).update.status).toBe('REVIEW_FAILED');
    expect(result.newLeadStatus).toBe('EMAIL_REVIEW_FAILED');
  });

  it('aborts with ZERO provider calls when a follow-up carries no outreach record', async () => {
    const draft = followupDraft();
    const h = harness({ row: followupRow(draft, 1, { outreachRecordId: null }), record: debugRecord(draft) });

    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN))
      .rejects.toMatchObject({ code: 'FOLLOWUP_OUTREACH_RECORD_MISSING' });
    expect(h.calls).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  it.each([
    ['no thread at all', null],
    ['no original subject', { threadSubject: null, priorMessages: [] } as ResumeThreadContext],
    ['no messages sent', { threadSubject: INITIAL_SENT_SUBJECT, priorMessages: [] } as ResumeThreadContext],
  ])('aborts with ZERO provider calls when the thread context has %s', async (_label, thread) => {
    const draft = followupDraft();
    const h = harness({ row: followupRow(draft), record: debugRecord(draft), thread });

    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN))
      .rejects.toMatchObject({ code: 'FOLLOWUP_THREAD_CONTEXT_MISSING' });
    expect(h.calls).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  it('still fails closed when the resumed follow-up copy mutated the thread subject', async () => {
    const draft = followupDraft({
      subject_options: [THREAD_SUBJECT, 'A brand new hook', THREAD_SUBJECT],
    });
    const h = harness({ row: followupRow(draft), record: debugRecord(draft) });

    const result = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(result.outcome).toBe('VALIDATION_FAILED');
    expect(result.violations).toContain('followup_subject_not_thread_subject:2');
    // No reviewer call on copy that fails the deterministic gate.
    expect(h.calls).toEqual([]);
  });

  it('re-renders the stored subject byte-identically (no double `Re: ` prefix)', async () => {
    const draft = followupDraft();
    const row = followupRow(draft);
    expect(row.subject).toBe(STORED_SUBJECT);
    const h = harness({ row, record: debugRecord(draft) });
    // A render mismatch would abort; reaching the reviewer proves the re-render matched.
    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(h.calls).toHaveLength(1);
  });

  it('a first-email draft still APPENDS a new row and resumes under the first-email rules', async () => {
    const h = harness({});
    const result = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(result.outcome).toBe('REVIEWED_APPROVED');
    expect(appendedEmail(h.committed[0]!)?.sequenceStep).toBe(0);
    expect(appendedEmail(h.committed[0]!)?.subject.startsWith('Re: ')).toBe(false);
    expect(result.newDraftId).not.toBeNull();
    // An unbound draft is not constrained by the sequence index, so history is preserved by
    // appending — the original REVIEW_FAILED row is untouched.
    expect(result.newDraftId).not.toBe(DRAFT);
  });
});

describe('resume-email-review', () => {
  it('exact-match success + reviewer APPROVE appends an APPROVED draft and advances the lead', async () => {
    const h = harness({ rawReview: approveReview() });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWED_APPROVED');
    expect(h.calls).toHaveLength(1); // exactly one reviewer call
    expect(r.newLeadStatus).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(h.committed).toHaveLength(1);
    const plan = h.committed[0]!;
    if (plan.write.kind !== 'APPEND') throw new Error('an unbound draft must append a new row');
    expect(plan.approved).toBe(true);
    expect(plan.route).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(plan.write.persist.email?.status).toBe('APPROVED');
    expect(plan.write.persist.email?.id).not.toBe(DRAFT); // NEW immutable row, original preserved
    expect(plan.sourceDraftId).toBe(DRAFT);
    // Writer provenance carried verbatim; writer not re-run.
    expect(plan.write.persist.email?.writerResponseId).toBe('writer-resp-1');
    expect(plan.write.persist.email?.requestedWriterModel).toBe('gpt-5.6-sol');
    // Evidence binding preserved.
    expect(plan.write.persist.findingInputs.map((f) => f.auditFindingId)).toContain('finding-cta');
  });

  it('reviewer REJECT appends a REVIEW_FAILED row and keeps the lead in EMAIL_REVIEW_FAILED', async () => {
    const h = harness({ rawReview: approveReview({ decision: 'REJECT' }) });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWED_REJECTED');
    expect(h.calls).toHaveLength(1);
    expect(r.newLeadStatus).toBe('EMAIL_REVIEW_FAILED');
    expect(h.committed[0]!.approved).toBe(false);
    expect(appendedEmail(h.committed[0]!)?.status).toBe('REVIEW_FAILED');
  });

  it('a single failed reviewer dimension routes to REVIEW_REJECTED (approvable gate preserved)', async () => {
    const h = harness({ rawReview: approveReview({ persuasive: false }) });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('REVIEWED_REJECTED');
  });

  it('aborts when the debug record is missing — no reviewer call, nothing persisted', async () => {
    const h = harness({ record: null });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'DEBUG_RECORD_MISSING' });
    expect(h.calls).toHaveLength(0);
    expect(h.committed).toHaveLength(0);
  });

  it('aborts on subject/body mismatch between the reloaded draft and the persisted row', async () => {
    const row = rowFor(fixtureWriter('strong English business email'), { body: 'DIFFERENT BODY' });
    const h = harness({ row });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'RENDER_MISMATCH' });
    expect(h.calls).toHaveLength(0);
    expect(h.committed).toHaveLength(0);
  });

  it('aborts when the draft belongs to a different lead', async () => {
    const row = rowFor(fixtureWriter('strong English business email'), { leadId: 'other-lead' });
    const h = harness({ row });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'DRAFT_LEAD_MISMATCH' });
    expect(h.calls).toHaveLength(0);
  });

  it('aborts when the draft does not exist', async () => {
    const h = harness({ row: null });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(h.calls).toHaveLength(0);
  });

  it('aborts when the draft is not REVIEW_FAILED', async () => {
    const row = rowFor(fixtureWriter('strong English business email'), { status: 'APPROVED' });
    const h = harness({ row });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'DRAFT_NOT_REVIEW_FAILED' });
    expect(h.calls).toHaveLength(0);
  });

  it('aborts when the lead is not EMAIL_REVIEW_FAILED', async () => {
    const h = harness({ leadStatus: 'READY_FOR_HUMAN_APPROVAL' });
    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toMatchObject({ code: 'LEAD_NOT_REVIEW_FAILED' });
    expect(h.calls).toHaveLength(0);
  });

  it('returns VALIDATION_FAILED without calling the reviewer when the draft still fails validation', async () => {
    const badWriter = fixtureWriter('fake urgency');
    const h = harness({ row: rowFor(badWriter), record: debugRecord(badWriter) });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('VALIDATION_FAILED');
    expect(r.violations).toContain('contains_fake_urgency');
    expect(h.calls).toHaveLength(0);
    expect(h.committed).toHaveLength(0);
  });

  it('ResumeReviewAbort carries a typed code', () => {
    expect(new ResumeReviewAbort('DRAFT_NOT_FOUND', 'x').code).toBe('DRAFT_NOT_FOUND');
  });
});
