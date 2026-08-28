import { describe, expect, it } from 'vitest';
import { previewEmailReview, type PreviewReviewConfig } from '../../src/domain/email/compose-preview-review.js';
import { isEmailReviewApprovable } from '../../src/domain/email/email-review-gate.js';
import { buildEmailBrief } from '../../src/domain/email/email-brief.js';
import { buildEmailContext, type EmailFinding, type EmailInputs } from '../../src/domain/email/email-render.js';
import { emailReviewSchema, emailWriterSchema, type EmailWriterParsed } from '../../src/domain/email/email-schema.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type LlmProvider, type LlmRequest, type LlmResult, type LlmStatus } from '../../src/integrations/llm/provider.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';

const LEAD = 'lead-1';

// Diamond-Smile-style real inputs: one verified fact + one outreach-safe finding. The English copy
// fixtures are authored against exactly these evidence ids (fact-business, finding-cta).
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

const inputs: EmailInputs = { facts: [businessFact], findings: [ctaFinding], demo: null };
const validationCtx = buildEmailContext(inputs);
const brief = buildEmailBrief(inputs);

const config: PreviewReviewConfig = {
  reviewerModel: 'gpt-5.6-terra', reviewerEffort: 'medium', store: false, timeoutMs: 1000, maxOutputTokens: 1500, maxRetries: 0,
};

const draftOf = (name: string): EmailWriterParsed =>
  emailWriterSchema.parse(EMAIL_COPY_FIXTURES.find((f) => f.name === name)!.writer);
const strongDraft = draftOf('strong English business email');
const failingDraft = draftOf('fake urgency'); // deterministic validation fails: contains_fake_urgency

const approveReview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  decision: 'APPROVE', fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true, openingSpecific: true,
  businessRelevanceClear: true, urgencySupported: true, competitorClaimsSupported: true, humanStylePass: true,
  punctuationPass: true, singlePrimaryCta: true, sufficientlyPersonalized: true, evidenceSupported: true,
  demoAligned: true, persuasive: true, singleObservation: true, buyerLanguageOnly: true,
  conversationNotAudit: true, confidentObservation: true, problems: [], requiredRevisions: [], ...over,
});

/**
 * A provider spy wrapped in a Proxy that records every property accessed on it. previewEmailReview
 * receives NO unit-of-work, repository, or lead-service — the provider is its only collaborator — so
 * the accessed-key set is a hard read-only witness: the only method it may ever touch is `generate`.
 */
function trackedProvider(rawJson: unknown, status: LlmStatus = 'ok'): { provider: LlmProvider; calls: LlmRequest[]; accessed: Set<string> } {
  const calls: LlmRequest[] = [];
  const accessed = new Set<string>();
  const base: LlmProvider = {
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
  const provider = new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string') accessed.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { provider, calls, accessed };
}

describe('compose-preview --review', () => {
  it('default preview (withReview=false) validates but never runs the reviewer', async () => {
    const { provider, calls, accessed } = trackedProvider(approveReview());
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: false });

    expect(r.validation.ok).toBe(true);
    expect(r.reviewRan).toBe(false);
    expect(r.reviewer).toBeNull();
    expect(r.verdict).toBe('PREVIEW_ONLY');
    expect(r.reviewerCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(accessed.size).toBe(0); // provider never touched at all
  });

  it('--review runs the exact production reviewer after validation passes and reports APPROVABLE', async () => {
    const { provider, calls } = trackedProvider(approveReview());
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: true });

    expect(r.validation.ok).toBe(true);
    expect(r.reviewRan).toBe(true);
    expect(r.reviewerCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe('email_review');
    expect(calls[0]!.model).toBe('gpt-5.6-terra');
    expect(calls[0]!.schemaName).toBe('email_review');
    expect(r.reviewer?.schemaValid).toBe(true);
    expect(r.reviewer?.approvable).toBe(true);
    expect(r.verdict).toBe('REVIEW_APPROVABLE');
  });

  it('validation failure short-circuits: the reviewer is never called', async () => {
    const { provider, calls, accessed } = trackedProvider(approveReview());
    const r = await previewEmailReview({ draft: failingDraft, validationCtx, brief, provider, config, withReview: true });

    expect(r.validation.ok).toBe(false);
    expect(r.validation.violations).toContain('contains_fake_urgency');
    expect(r.reviewRan).toBe(false);
    expect(r.reviewer).toBeNull();
    expect(r.verdict).toBe('VALIDATION_FAILED');
    expect(r.reviewerCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(accessed.size).toBe(0);
  });

  it('reviewer rejection is reported with the failing dimension, problems and required revisions', async () => {
    const rejected = approveReview({
      decision: 'APPROVE_WITH_REVISIONS', persuasive: false,
      problems: ['Opening is generic.'], requiredRevisions: ['Lead with the specific finding.'],
    });
    const { provider } = trackedProvider(rejected);
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: true });

    expect(r.reviewRan).toBe(true);
    expect(r.reviewer?.approvable).toBe(false);
    expect(r.verdict).toBe('REVIEW_NOT_APPROVABLE');
    expect(r.reviewer?.review?.persuasive).toBe(false);
    expect(r.reviewer?.review?.problems).toContain('Opening is generic.');
    expect(r.reviewer?.review?.requiredRevisions).toContain('Lead with the specific finding.');
  });

  it('a REJECT decision with all booleans true is still not approvable (shared gate)', async () => {
    const { provider } = trackedProvider(approveReview({ decision: 'REJECT' }));
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: true });
    expect(r.reviewer?.approvable).toBe(false);
    expect(r.verdict).toBe('REVIEW_NOT_APPROVABLE');
  });

  it('a non-ok reviewer provider status is reported as REVIEWER_ERROR (still one call)', async () => {
    const { provider, calls } = trackedProvider(approveReview(), 'transient');
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: true });
    expect(r.verdict).toBe('REVIEWER_ERROR');
    expect(r.reviewer?.schemaValid).toBe(false);
    expect(r.reviewer?.review).toBeNull();
    expect(r.reviewerCalls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('is structurally read-only: provider.generate is the ONLY method ever touched, called at most once', async () => {
    const { provider, calls, accessed } = trackedProvider(approveReview());
    const r = await previewEmailReview({ draft: strongDraft, validationCtx, brief, provider, config, withReview: true });

    expect(r.verdict).toBe('REVIEW_APPROVABLE');
    expect(calls).toHaveLength(1); // never more than the single reviewer call (writer + this = 2 max per preview)
    // No persistence / lead-transition seam exists on the only collaborator; the preview cannot persist.
    expect([...accessed]).toEqual(['generate']);
  });
});

describe('isEmailReviewApprovable (shared gate)', () => {
  it('approves only when the decision is APPROVE, fabricationRisk is false, and every dimension passes', () => {
    expect(isEmailReviewApprovable(emailReviewSchema.parse(approveReview()))).toBe(true);
  });

  it('rejects when any single dimension is false or fabricationRisk is true', () => {
    expect(isEmailReviewApprovable(emailReviewSchema.parse(approveReview({ buyerLanguageOnly: false })))).toBe(false);
    expect(isEmailReviewApprovable(emailReviewSchema.parse(approveReview({ fabricationRisk: true })))).toBe(false);
    expect(isEmailReviewApprovable(emailReviewSchema.parse(approveReview({ decision: 'APPROVE_WITH_REVISIONS' })))).toBe(false);
  });
});
