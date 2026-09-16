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
import { EMAIL_SCHEMA_VERSION } from '../../src/domain/email/email-schema.js';
import { worstCaseCostUsd } from '../../src/integrations/llm/pricing.js';

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

function fakeProvider(rawJson: unknown, status: LlmStatus = 'ok', name = 'mock'): { provider: LlmProvider; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = {
    name,
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
  diagnostics: EmailDebugRecord[];
  /** The order the two persistence sinks were attempted in. */
  order: string[];
}

/** The accounting write a paid-but-unusable reviewer attempt must produce. */
function accounting(plan: ResumeCommitPlan) {
  if (plan.write.kind !== 'ACCOUNT_FAILED_ATTEMPT') throw new Error(`expected ACCOUNT_FAILED_ATTEMPT, got ${plan.write.kind}`);
  return plan.write;
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
  /** A non-mock name turns the real-provider budget guard on. */
  providerName?: string;
  config?: Partial<ResumeReviewConfig>;
  /** Simulated infrastructure failures, to prove the two sinks are independent. */
  failDebugWrite?: boolean;
  failCommit?: boolean;
}): Harness {
  const { provider, calls } = fakeProvider(opts.rawReview ?? approveReview(), opts.status ?? 'ok', opts.providerName);
  const committed: ResumeCommitPlan[] = [];
  const diagnostics: EmailDebugRecord[] = [];
  const order: string[] = [];
  const service = new ResumeEmailReviewService({
    provider,
    debug: { findByLeadAndRun: async () => (opts.record === undefined ? debugRecord(fixtureWriter('strong English business email')) : opts.record) },
    ports: {
      loadDraft: async () => (opts.row === undefined ? rowFor(fixtureWriter('strong English business email')) : opts.row),
      loadLeadStatus: async () => (opts.leadStatus === undefined ? 'EMAIL_REVIEW_FAILED' : opts.leadStatus),
      loadInputs: async () => inputs,
      loadThreadContext: async () => (opts.thread === undefined ? defaultThread : opts.thread),
    },
    commit: async (plan) => {
      order.push('commit');
      if (opts.failCommit) throw new Error('database unavailable');
      committed.push(plan);
    },
    debugWriter: {
      record: async (rec) => {
        order.push('debug');
        if (opts.failDebugWrite) throw new Error('disk full');
        diagnostics.push(rec);
      },
    },
    logger: { info() {}, warn() {}, error() {} } as never,
    config: { ...config, ...opts.config },
  });
  return { service, calls, committed, diagnostics, order };
}

describe('resume-email-review — the reviewer budget is CUMULATIVE per draft', () => {
  // Failed reviewer attempts now add to the draft's spend on purpose. A per-CALL admission test
  // would therefore let an unbounded number of retries walk past the per-lead cap while each
  // individual call still looked affordable.
  const REVIEWER_MODEL = 'gpt-5.6-terra';
  const projected = worstCaseCostUsd(REVIEWER_MODEL, 1000, 1500)!;

  const priced = (alreadySpent: number, cap: number | null) => {
    const draft = fixtureWriter('strong English business email');
    return harness({
      row: { ...rowFor(draft), totalCostUsd: alreadySpent },
      record: debugRecord(draft),
      providerName: 'openai',
      config: { reviewerModel: REVIEWER_MODEL, maxCostUsdPerLead: cap, worstCaseInputTokensPerCall: 1000, maxOutputTokens: 1500 },
    });
  };

  it('allows the call when the writer spend plus the projected reviewer cost fits under the cap', async () => {
    const h = priced(0.05, 0.05 + projected + 0.01);
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('REVIEWED_APPROVED');
    expect(h.calls).toHaveLength(1);
  });

  it('blocks with ZERO provider calls when the cumulative total would exceed the cap', async () => {
    const h = priced(0.05, 0.05 + projected - 0.0001);
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWER_BUDGET_BLOCKED');
    expect(r.costUsd).toBe(0);
    expect(r.callsMade).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  it('would have been admitted under the old per-call rule — the regression this closes', async () => {
    // The single call costs far less than the cap; only the accumulated spend breaches it.
    const cap = 0.05 + projected - 0.0001;
    expect(projected).toBeLessThan(cap);
    const h = priced(0.05, cap);
    expect((await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).outcome).toBe('REVIEWER_BUDGET_BLOCKED');
  });

  it('fails closed when the projected cost is unknown', async () => {
    const draft = fixtureWriter('strong English business email');
    const h = harness({
      row: { ...rowFor(draft), totalCostUsd: 0 },
      record: debugRecord(draft),
      providerName: 'openai',
      config: { reviewerModel: 'model-with-no-published-price', maxCostUsdPerLead: 10 },
    });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('REVIEWER_BUDGET_BLOCKED');
    expect(h.calls).toEqual([]);
  });

  it('accounted failed attempts eventually block the next retry', async () => {
    const cap = 0.05 + 3 * projected;
    // Each failed attempt adds its cost to the draft; simulate the running total the DB now holds.
    const spendAfter = (attempts: number): number => 0.05 + attempts * projected;
    for (const attempts of [0, 1, 2]) {
      const h = priced(spendAfter(attempts), cap);
      expect((await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).outcome, `attempt ${String(attempts)}`)
        .toBe('REVIEWED_APPROVED');
    }
    // The fourth would push the draft past the cap.
    const blocked = priced(spendAfter(3), cap);
    const r = await blocked.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('REVIEWER_BUDGET_BLOCKED');
    expect(blocked.calls).toEqual([]);
  });

  it('leaves the mock provider free, as everywhere else in the pipeline', async () => {
    const draft = fixtureWriter('strong English business email');
    const h = harness({
      row: { ...rowFor(draft), totalCostUsd: 9_999 },
      record: debugRecord(draft),
      config: { maxCostUsdPerLead: 0.0001 },
    });
    expect((await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).outcome).toBe('REVIEWED_APPROVED');
  });
});

describe('resume-email-review — the two persistence sinks are independent', () => {
  const invalid = (): Record<string, unknown> => ({
    ...approveReview(),
    problems: Array.from({ length: 21 }, (_, i) => `problem ${String(i)}`),
  });

  it('writes the local diagnostic BEFORE the database, so a DB outage still leaves evidence', async () => {
    const h = harness({ rawReview: invalid() });
    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(h.order).toEqual(['debug', 'commit']);
  });

  it('a local diagnostic failure never undoes or obscures successful DB accounting', async () => {
    const h = harness({ rawReview: invalid(), failDebugWrite: true });

    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    // The determinate outcome is still reported, and the books are still correct.
    expect(r.outcome).toBe('SCHEMA_INVALID');
    expect(h.committed).toHaveLength(1);
    expect(accounting(h.committed[0]!).addCostUsd).toBeCloseTo(0.02, 6);
    expect(h.diagnostics).toEqual([]);
    // One paid call, and the diagnostic failure did not cause another.
    expect(h.calls).toHaveLength(1);
  });

  it('a DB accounting failure propagates, and the local diagnostic survives it', async () => {
    const h = harness({ rawReview: invalid(), failCommit: true });

    await expect(h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).rejects.toThrow('database unavailable');

    // Evidence of the paid call exists even though the database rejected the accounting.
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]?.outcome).toBe('SCHEMA_INVALID');
    expect((h.diagnostics[0]?.review as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    // And still exactly one paid call.
    expect(h.calls).toHaveLength(1);
  });

  it('both succeeding is the ordinary path', async () => {
    const h = harness({ rawReview: invalid() });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('SCHEMA_INVALID');
    expect(h.committed).toHaveLength(1);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });
});

describe('resume-email-review — schema-version provenance', () => {
  it('records the NEW reviewer call under the current schema version', async () => {
    const h = harness({ rawReview: { ...approveReview(), problems: Array.from({ length: 21 }, () => 'p') } });
    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(accounting(h.committed[0]!).modelCalls[0]?.schemaVersion).toBe(EMAIL_SCHEMA_VERSION);
  });

  it('never rewrites the schema version the writer recorded on the draft', async () => {
    // The draft was produced under the OLD provider contract; its provenance must stay truthful.
    const draft = fixtureWriter('strong English business email');
    const row = { ...rowFor(draft), schemaVersion: 'email-copy-schema-4', totalCostUsd: 0.05 };
    const h = harness({ row, record: debugRecord(draft) });

    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    const appended = appendedEmail(h.committed[0]!);
    expect(appended?.schemaVersion).toBe('email-copy-schema-4');
    expect(appended?.schemaVersion).not.toBe(EMAIL_SCHEMA_VERSION);
  });

  it('an in-place recovery writes no schema version at all', async () => {
    const draft = fixtureWriter('strong English business email');
    const rendered = renderEmail(draft, { ...emailInputs, threadSubject: INITIAL_SENT_SUBJECT },
      { step: 1, threadSubject: INITIAL_SENT_SUBJECT, priorMessageBodies: [INITIAL_SENT_BODY] });
    const row: PersistedDraftRow = {
      ...rowFor(draft), subject: rendered.subject, body: rendered.body, sequenceStep: 1,
      outreachRecordId: 'rec-1', threadSubject: rendered.subject, schemaVersion: 'email-copy-schema-4',
    };
    const followup = {
      ...draft,
      subject_options: [INITIAL_SENT_SUBJECT, INITIAL_SENT_SUBJECT, INITIAL_SENT_SUBJECT],
      selected_subject: INITIAL_SENT_SUBJECT,
      selected_subject_reason: 'Thread continuity is preserved.',
    };
    const followupRendered = renderEmail(followup, { ...emailInputs, threadSubject: INITIAL_SENT_SUBJECT },
      { step: 1, threadSubject: INITIAL_SENT_SUBJECT, priorMessageBodies: [INITIAL_SENT_BODY] });
    const h = harness({
      row: { ...row, subject: followupRendered.subject, body: followupRendered.body, threadSubject: followupRendered.subject },
      record: debugRecord(followup),
    });

    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    const update: Record<string, unknown> = { ...recovery(h.committed[0]!).update };
    expect(Object.keys(update)).not.toContain('schemaVersion');
    expect(recovery(h.committed[0]!).modelCalls[0]?.schemaVersion).toBe(EMAIL_SCHEMA_VERSION);
  });
});

describe('resume-email-review — a paid reviewer call that yields nothing usable', () => {
  // PRODUCTION: `resume-email-review` returned SCHEMA_INVALID after spending $0.033. Nothing was
  // committed — no model_call, no cost on the draft, no record of WHY the response was rejected —
  // so the only evidence the money was spent lived in the operator's terminal.
  const THREAD_SUBJECT = INITIAL_SENT_SUBJECT;

  const followupDraft = (): EmailWriterOutput => ({
    ...fixtureWriter('strong English business email'),
    subject_options: [THREAD_SUBJECT, THREAD_SUBJECT, THREAD_SUBJECT],
    selected_subject: THREAD_SUBJECT,
    selected_subject_reason: 'Thread continuity is preserved.',
  });

  const followupRow = (draft: EmailWriterOutput): PersistedDraftRow => {
    const rendered = renderEmail(draft, { ...emailInputs, threadSubject: THREAD_SUBJECT },
      { step: 1, threadSubject: THREAD_SUBJECT, priorMessageBodies: [INITIAL_SENT_BODY] });
    return {
      ...rowFor(draft), subject: rendered.subject, body: rendered.body,
      sequenceStep: 1, outreachRecordId: 'rec-1', threadSubject: rendered.subject, totalCostUsd: 0.0529,
    };
  };

  /** Schema-valid for the provider, invalid for Zod: 21 problems where the cap is 20. */
  const tooManyProblems = (): Record<string, unknown> => ({
    ...approveReview(),
    problems: Array.from({ length: 21 }, (_, i) => `problem ${String(i)}`),
  });

  const failing = (rawReview: unknown, status: LlmStatus = 'ok') => {
    const draft = followupDraft();
    return harness({ row: followupRow(draft), record: debugRecord(draft), rawReview, status });
  };

  it('commits the spend and the model_call instead of losing them', async () => {
    const h = failing(tooManyProblems());
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('SCHEMA_INVALID');
    expect(r.callsMade).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.02, 6);

    const write = accounting(h.committed[0]!);
    expect(write.draftId).toBe(DRAFT);
    expect(write.addCostUsd).toBeCloseTo(0.02, 6);
    expect(write.modelCalls).toHaveLength(1);
    expect(write.modelCalls[0]?.purpose).toBe('email_review');
    expect(write.modelCalls[0]?.estimatedCostUsd).toBeCloseTo(0.02, 6);
  });

  it('never approves, never progresses, and never writes a second draft', async () => {
    const h = failing(tooManyProblems());
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(h.committed).toHaveLength(1);
    expect(h.committed[0]!.approved).toBe(false);
    expect(h.committed[0]!.write.kind).toBe('ACCOUNT_FAILED_ATTEMPT');
    expect(r.newDraftId).toBeNull();
    expect(r.review).toBeNull();
    // The draft that stays canonical is the one that was resumed.
    expect(r.resultDraftId).toBe(DRAFT);
    expect(r.newLeadStatus).toBe('EMAIL_REVIEW_FAILED');
  });

  it('preserves the exact Zod issues and the raw response for diagnosis', async () => {
    const h = failing(tooManyProblems());
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    const diag = accounting(h.committed[0]!).diagnostic;
    expect(diag.outcome).toBe('SCHEMA_INVALID');
    expect(diag.providerStatus).toBe('ok');
    expect(diag.responseId).toBe('resp-1');
    expect(diag.requestId).toBe('req-1');
    expect(diag.issues.length).toBeGreaterThan(0);
    expect(diag.issues[0]).toMatchObject({ path: 'problems', code: expect.any(String), message: expect.any(String) });
    expect(diag.rawExcerpt).toContain('problem 0');
    // The same violations reach model_calls, in the writer's format.
    expect(r.violations).toContain('schema_invalid:problems');
    expect(accounting(h.committed[0]!).modelCalls[0]?.validationViolations).toContain('schema_invalid:problems');
    // And the raw payload reaches the diagnostic sink.
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]?.outcome).toBe('SCHEMA_INVALID');
    expect(h.diagnostics[0]?.draft).toBeNull();
  });

  it('bounds the diagnostic so one bad response cannot bloat the audit trail', async () => {
    const h = failing({
      ...approveReview(),
      problems: Array.from({ length: 60 }, () => 'x'.repeat(400)),
      requiredRevisions: Array.from({ length: 60 }, () => 'y'.repeat(400)),
    });
    await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    const diag = accounting(h.committed[0]!).diagnostic;
    expect(diag.issues.length).toBeLessThanOrEqual(20);
    for (const issue of diag.issues) {
      expect(issue.message.length).toBeLessThanOrEqual(200);
      expect(issue.path.length).toBeLessThanOrEqual(120);
    }
    expect(diag.rawExcerpt?.length).toBeLessThanOrEqual(2000);
    expect(diag.rawTruncated).toBe(true);
    expect(accounting(h.committed[0]!).modelCalls[0]?.validationViolations?.length).toBeLessThanOrEqual(20);
  });

  it.each([
    ['refusal', 'MODEL_REFUSAL'],
    ['rate_limited', 'RATE_LIMITED'],
    ['transient', 'TRANSIENT_PROVIDER_ERROR'],
    ['incomplete', 'TRANSIENT_PROVIDER_ERROR'],
  ] as const)('accounts a %s reviewer call too', async (status, outcome) => {
    const h = failing(approveReview(), status);
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe(outcome);
    const write = accounting(h.committed[0]!);
    expect(write.addCostUsd).toBeCloseTo(0.02, 6);
    expect(write.modelCalls).toHaveLength(1);
    expect(write.diagnostic.outcome).toBe(outcome);
    // A provider failure has no Zod issues to report, and that is not an error.
    expect(write.diagnostic.issues).toEqual([]);
  });

  it('leaves the draft resumable: the next attempt recovers it in place', async () => {
    const draft = followupDraft();
    const row = followupRow(draft);

    const first = harness({ row, record: debugRecord(draft), rawReview: tooManyProblems() });
    expect((await first.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN)).outcome).toBe('SCHEMA_INVALID');
    expect(accounting(first.committed[0]!).addCostUsd).toBeCloseTo(0.02, 6);

    // Nothing about the draft changed, so the SAME row is resumed again — writer never re-run.
    const second = harness({ row, record: debugRecord(draft), rawReview: approveReview() });
    const r = await second.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWED_APPROVED');
    expect(recovery(second.committed[0]!).draftId).toBe(DRAFT);
    expect(second.calls.filter((c) => c.task === 'email_write')).toHaveLength(0);
  });

  it('accumulates across repeated failed attempts rather than overwriting', async () => {
    const draft = followupDraft();
    const row = followupRow(draft);
    const attempts = [];
    for (let i = 0; i < 3; i += 1) {
      const h = harness({ row, record: debugRecord(draft), rawReview: tooManyProblems() });
      await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
      attempts.push(accounting(h.committed[0]!));
    }
    // Each attempt contributes its own model_call and its own increment — never a replacement.
    expect(attempts.map((a) => a.addCostUsd)).toEqual([0.02, 0.02, 0.02].map((n) => expect.closeTo(n, 6)));
    const ids = attempts.flatMap((a) => a.modelCalls.map((m) => m.id));
    expect(new Set(ids).size).toBe(3);
  });

  it('an unbound (first-email) draft is accounted the same way', async () => {
    const h = harness({ rawReview: tooManyProblems() });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);
    expect(r.outcome).toBe('SCHEMA_INVALID');
    expect(accounting(h.committed[0]!).draftId).toBe(DRAFT);
  });
});

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
    // Rendered exactly as production would for THIS step — the final step appends a different,
    // deterministic closing line, so a row rendered at step 0 would not match on resume.
    const rendered = renderEmail(
      draft,
      { ...emailInputs, threadSubject: THREAD_SUBJECT },
      { step, threadSubject: THREAD_SUBJECT, priorMessageBodies: [INITIAL_SENT_BODY] },
    );
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
