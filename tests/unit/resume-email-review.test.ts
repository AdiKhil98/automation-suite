import { describe, expect, it } from 'vitest';
import {
  ResumeEmailReviewService,
  ResumeReviewAbort,
  type PersistedDraftRow,
  type ResumeCommitPlan,
  type ResumeInputs,
  type ResumeReviewConfig,
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
  demoAligned: true, persuasive: true, problems: [], requiredRevisions: [], ...over,
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
    writerResponseId: 'writer-resp-1', ...over,
  };
}

function debugRecord(draft: EmailWriterOutput): EmailDebugRecord {
  return {
    leadId: LEAD, runId: RUN, outcome: 'VALIDATION_FAILED', draft, review: null, violations: ['cta_in_model_body'],
    costUsd: 0.055, callsMade: 1, createdAt: '2026-08-27T19:18:02.953Z', expiresAt: '2026-09-03T19:18:02.953Z',
  };
}

interface Harness {
  service: ResumeEmailReviewService;
  calls: LlmRequest[];
  committed: ResumeCommitPlan[];
}

function harness(opts: {
  rawReview?: unknown;
  status?: LlmStatus;
  row?: PersistedDraftRow | null;
  leadStatus?: string | null;
  record?: EmailDebugRecord | null;
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
    },
    commit: async (plan) => { committed.push(plan); },
    logger: { info() {}, warn() {}, error() {} } as never,
    config,
  });
  return { service, calls, committed };
}

describe('resume-email-review', () => {
  it('exact-match success + reviewer APPROVE appends an APPROVED draft and advances the lead', async () => {
    const h = harness({ rawReview: approveReview() });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWED_APPROVED');
    expect(h.calls).toHaveLength(1); // exactly one reviewer call
    expect(r.newLeadStatus).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(h.committed).toHaveLength(1);
    const plan = h.committed[0]!;
    expect(plan.approved).toBe(true);
    expect(plan.route).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(plan.persist.email?.status).toBe('APPROVED');
    expect(plan.persist.email?.id).not.toBe(DRAFT); // NEW immutable row, original preserved
    expect(plan.sourceDraftId).toBe(DRAFT);
    // Writer provenance carried verbatim; writer not re-run.
    expect(plan.persist.email?.writerResponseId).toBe('writer-resp-1');
    expect(plan.persist.email?.requestedWriterModel).toBe('gpt-5.6-sol');
    // Evidence binding preserved.
    expect(plan.persist.findingInputs.map((f) => f.auditFindingId)).toContain('finding-cta');
  });

  it('reviewer REJECT appends a REVIEW_FAILED row and keeps the lead in EMAIL_REVIEW_FAILED', async () => {
    const h = harness({ rawReview: approveReview({ decision: 'REJECT' }) });
    const r = await h.service.resume({ leadId: LEAD, draftId: DRAFT }, RUN);

    expect(r.outcome).toBe('REVIEWED_REJECTED');
    expect(h.calls).toHaveLength(1);
    expect(r.newLeadStatus).toBe('EMAIL_REVIEW_FAILED');
    expect(h.committed[0]!.approved).toBe(false);
    expect(h.committed[0]!.persist.email?.status).toBe('REVIEW_FAILED');
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
