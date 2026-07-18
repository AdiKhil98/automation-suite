import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadService } from '../../src/domain/leads/lead-service.js';
import { emailReviewSchema, emailWriterSchema } from '../../src/domain/email/email-schema.js';
import { buildEmailContext, renderEmail, type EmailFinding, type EmailInputs } from '../../src/domain/email/email-render.js';
import { validateEmail } from '../../src/domain/email/email-validation.js';
import { resolveEmailLanguage } from '../../src/domain/email/email-language.js';
import { DEMO_URL_TOKEN, type EmailWriterOutput } from '../../src/domain/email/email-types.js';
import { worstCaseEmailInputTokens } from '../../src/domain/email/email-token-budget.js';
import {
  EmailWriterService, type EmailConfig, type EmailPersist, type EmailUnitOfWork,
} from '../../src/domain/email/email-writer-service.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { type LlmRequest } from '../../src/integrations/llm/provider.js';
import { defaultMockEmailResponder } from '../../src/fixtures/mock-email-responses.js';

let n = 0;
const fact = (factType: string, value: string): LeadFact => ({
  id: `f-${n++}`, leadId: 'lead-1', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
  sourceType: 'website', sourceUrl: null, capturedAt: new Date(), confidence: 1, supersededBy: null, supersededAt: null, isCurrent: true,
});
const baseFacts = (): LeadFact[] => [fact('business_name', 'Zahnärzte am Ufer'), fact('city', 'Berlin'), fact('services', 'Implantology|Whitening')];
const finding = (ref: string, safe = true): EmailFinding => ({ id: `af-${ref}`, findingRef: ref, category: 'CTA_CLARITY', safeForOutreach: safe, observation: `obs ${ref}`, recommendation: `rec ${ref}` });

const writerOut = (over: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
  subject: 'A quick note on your website', bodyParagraphs: ['A couple of small things could make it easier for patients to get in touch.'],
  greetingStyle: 'NEUTRAL', ctaKind: 'reply', ctaLabelKey: 'REPLY_TO_LEARN_MORE', signoffKey: 'BEST_REGARDS',
  factRefs: ['business_name'], findingRefs: ['F1'], ...over,
});
const inputs = (over: Partial<EmailInputs> = {}): EmailInputs => ({ facts: baseFacts(), findings: [finding('F1')], demo: null, ...over });
const ctxOf = (i = inputs()) => buildEmailContext(i);

const reviewJson = (over: Record<string, unknown> = {}) => ({
  decision: 'APPROVE', fabricationRisk: false, personalizationSupported: true, claimHonest: true,
  revisionRequiresNewFacts: false, revisionRequiresNewClaims: false, revisionRequiresCtaChange: false, problems: [], ...over,
});

describe('email schema', () => {
  it('parses valid writer + reviewer output', () => {
    expect(emailWriterSchema.safeParse(writerOut()).success).toBe(true);
    expect(emailReviewSchema.safeParse(reviewJson()).success).toBe(true);
  });
});

describe('email validation', () => {
  it('accepts a clean reply email', () => {
    expect(validateEmail(writerOut(), ctxOf()).ok).toBe(true);
  });
  it('rejects URLs, metrics, performance claims, urgency, familiarity, insults', () => {
    const cases: [string, string][] = [
      ['Visit https://example.com today', 'contains_url'],
      ['You could get 30% more patients', 'contains_metric_claim'],
      ['This will boost your revenue', 'contains_performance_claim'],
      ['Act now, last chance!', 'contains_urgency'],
      ['As we discussed on our call', 'contains_fake_familiarity'],
      ['Your current site is terrible', 'contains_insult'],
    ];
    for (const [para, code] of cases) {
      const v = validateEmail(writerOut({ bodyParagraphs: [para], findingRefs: [] }), ctxOf());
      expect(v.violations, para).toContain(code);
    }
  });
  it('rejects a finding ref that is not accepted, and an unavailable fact ref', () => {
    const v = validateEmail(writerOut({ findingRefs: ['F9'], factRefs: ['contact_name'] }), ctxOf());
    expect(v.violations).toContain('finding_ref_not_accepted:F9');
    expect(v.violations).toContain('unavailable_fact_ref:contact_name');
  });
  it('rejects a demo_link CTA and any demo mention when no approved demo exists', () => {
    const v = validateEmail(writerOut({ ctaKind: 'demo_link', ctaLabelKey: 'SEE_THE_CONCEPT', bodyParagraphs: ['I built a quick demo for you.'] }), ctxOf());
    expect(v.violations).toContain('demo_link_without_approved_demo');
    expect(v.violations).toContain('mentions_demo_without_approved_demo');
  });
  it('rejects the model emitting the demo URL token itself', () => {
    const withDemo = inputs({ demo: { id: 'd1', status: 'APPROVED', ctaKind: 'booking' } });
    const v = validateEmail(writerOut({ bodyParagraphs: [`See it: ${DEMO_URL_TOKEN}`] }), ctxOf(withDemo));
    expect(v.violations).toContain('model_emitted_demo_url_token');
  });
  it('rejects an over-long body', () => {
    const long = Array.from({ length: 130 }, () => 'word').join(' ');
    expect(validateEmail(writerOut({ bodyParagraphs: [long] }), ctxOf()).violations.some((x) => x.startsWith('body_too_long'))).toBe(true);
  });
});

describe('email language consistency', () => {
  const deFacts = (): LeadFact[] => [...baseFacts(), fact('official_website_url', 'https://zahnaerzte-am-ufer.de/')];

  it('resolves German from a .de site and English by default', () => {
    expect(resolveEmailLanguage(deFacts())).toBe('de');
    expect(resolveEmailLanguage(baseFacts())).toBe('en');
  });
  it('renders greeting, CTA and signoff in the resolved language (German)', () => {
    const de = inputs({ facts: deFacts() });
    const body = renderEmail(writerOut({ bodyParagraphs: ['Die Terminbuchung könnte deutlicher sein.'] }), de).body;
    expect(body.startsWith('Hallo,')).toBe(true);
    expect(body).toContain('Beste Grüße');
    expect(body).toContain('antworten Sie einfach');
    expect(body).not.toContain('Best regards,');
  });
  it('rejects a German target with an English body (mixed language)', () => {
    const de = inputs({ facts: deFacts() });
    const v = validateEmail(writerOut({ bodyParagraphs: ['You could make the booking clearer for your patients.'] }), ctxOf(de));
    expect(v.violations).toContain('mixed_language:expected_de');
  });
  it('rejects an English target with a German body', () => {
    const v = validateEmail(writerOut({ bodyParagraphs: ['Die Buchung könnte für Ihre Patienten klarer sein.'] }), ctxOf());
    expect(v.violations).toContain('mixed_language:expected_en');
  });
  it('accepts a consistent German email', () => {
    const de = inputs({ facts: deFacts() });
    expect(validateEmail(writerOut({ subject: 'Anregung zur Website', bodyParagraphs: ['Die Terminbuchung könnte deutlicher hervorgehoben werden.'], findingRefs: [] }), ctxOf(de)).ok).toBe(true);
  });
});

describe('email render', () => {
  it('neutral greeting + reply CTA + signoff + sender token; provenance tracked', () => {
    const r = renderEmail(writerOut(), inputs());
    expect(r.body.startsWith('Hello,')).toBe(true);
    expect(r.body).toContain('Best regards,');
    expect(r.body).toContain('{{SENDER_NAME}}');
    expect(r.hasDemoUrlPlaceholder).toBe(false);
    expect(r.factInputs.some((fi) => fi.field === 'body.business_name')).toBe(true);
    expect(r.findingInputs.map((f) => f.findingRef)).toContain('F1');
  });
  it('NAMED greeting only when a verified contact-name fact exists', () => {
    expect(renderEmail(writerOut({ greetingStyle: 'NAMED' }), inputs()).body.startsWith('Hello,')).toBe(true); // no name fact
    const withName = inputs({ facts: [...baseFacts(), fact('contact_name', 'Dr. Meyer')] });
    expect(renderEmail(writerOut({ greetingStyle: 'NAMED' }), withName).body.startsWith('Hello Dr. Meyer,')).toBe(true);
  });
  it('demo_link email keeps the {{DEMO_URL}} token (not send-ready)', () => {
    const withDemo = inputs({ demo: { id: 'd1', status: 'APPROVED', ctaKind: 'booking' } });
    const r = renderEmail(writerOut({ ctaKind: 'demo_link', ctaLabelKey: 'SEE_THE_CONCEPT' }), withDemo);
    expect(r.body).toContain(DEMO_URL_TOKEN);
    expect(r.hasDemoUrlPlaceholder).toBe(true);
  });
});

// --- Service orchestration (mock provider) ---

function fakeUow(sink: EmailPersist[], leadStatus = 'DEMO_READY'): EmailUnitOfWork {
  const leadService = { async transition() { /* noop */ } } as unknown as LeadService;
  return {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'lead-1', status: leadStatus } as unknown as Lead; } } as never,
        leadService,
        emails: { async persist(r: EmailPersist) { sink.push(r); } },
        events: { async record() { /* noop */ } },
      });
    },
  };
}
const cfg = (over: Partial<EmailConfig> = {}): EmailConfig => ({
  writerModel: 'gpt-5.6-sol', reviewerModel: 'gpt-5.6-terra', writerEffort: 'medium', reviewerEffort: 'medium', store: false,
  timeoutMs: 1000, maxOutputTokens: 1500, maxRetries: 0, maxCallsPerLead: 2, maxCostUsdPerLead: 0.2,
  worstCaseInputTokensPerCall: worstCaseEmailInputTokens(), ...over,
});
const logger = pino({ level: 'silent' });
const svcInput = (over = {}) => ({ leadId: 'lead-1', facts: baseFacts(), findings: [finding('F1')], demo: null, opportunityScore: 60, ...over });

describe('EmailWriterService (mock)', () => {
  it('drafts + approves a reply email → APPROVED_READY, routes to READY_FOR_HUMAN_APPROVAL', async () => {
    const sink: EmailPersist[] = [];
    const svc = new EmailWriterService({ provider: new MockLlmProvider(defaultMockEmailResponder), uow: fakeUow(sink), logger, config: cfg() });
    const r = await svc.write(svcInput(), 'run-1');
    expect(r.outcome).toBe('APPROVED_READY');
    expect(r.costUsd).toBe(0);
    expect(sink[0]!.email?.status).toBe('APPROVED');
    expect(sink[0]!.routeTo).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(sink[0]!.email?.hasDemoUrlPlaceholder).toBe(false);
  });

  it('approved demo_link email parks at WAITING_FOR_DEMO_URL', async () => {
    const sink: EmailPersist[] = [];
    const svc = new EmailWriterService({ provider: new MockLlmProvider(defaultMockEmailResponder), uow: fakeUow(sink), logger, config: cfg() });
    const r = await svc.write(svcInput({ demo: { id: 'd1', status: 'APPROVED', ctaKind: 'booking' } }), 'run-1');
    expect(r.outcome).toBe('APPROVED_WAITING_URL');
    expect(sink[0]!.routeTo).toBe('WAITING_FOR_DEMO_URL');
    expect(sink[0]!.email?.hasDemoUrlPlaceholder).toBe(true);
  });

  it('rejects when the reviewer flags a dishonest claim', async () => {
    const sink: EmailPersist[] = [];
    const responder = (req: LlmRequest, i: number) => req.task === 'email_write' ? defaultMockEmailResponder(req, i) : { rawJson: reviewJson({ decision: 'REJECT', claimHonest: false }) };
    const svc = new EmailWriterService({ provider: new MockLlmProvider(responder), uow: fakeUow(sink), logger, config: cfg() });
    const r = await svc.write(svcInput(), 'run-1');
    expect(r.outcome).toBe('REVIEW_REJECTED');
    expect(sink[0]!.email?.status).toBe('REVIEW_FAILED');
    expect(sink[0]!.routeTo).toBe('EMAIL_REVIEW_FAILED');
  });

  it('fails deterministic validation before the reviewer when the writer emits a URL', async () => {
    const sink: EmailPersist[] = [];
    const responder = (req: LlmRequest) => req.task === 'email_write'
      ? { rawJson: writerOut({ bodyParagraphs: ['Check https://example.com'] }) }
      : { rawJson: reviewJson() };
    const provider = new MockLlmProvider(responder);
    const svc = new EmailWriterService({ provider, uow: fakeUow(sink), logger, config: cfg() });
    const r = await svc.write(svcInput(), 'run-1');
    expect(r.outcome).toBe('VALIDATION_FAILED');
    expect(provider.calls).toHaveLength(1); // reviewer never called
  });

  it('blocks on the per-lead budget for a real provider when projected cost exceeds the cap', async () => {
    const sink: EmailPersist[] = [];
    const stub = {
      name: 'openai',
      async generate(req: LlmRequest) {
        return { status: 'ok' as const, rawJson: req.task === 'email_write' ? writerOut() : reviewJson(), refusal: null, incompleteReason: null,
          provider: 'openai', requestedModel: req.model, resolvedModel: req.model, requestId: 'r', responseId: 'r',
          usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, estimatedCostUsd: 0.01 }, latencyMs: 1, imageDetail: null };
      },
    };
    const svc = new EmailWriterService({ provider: stub, uow: fakeUow(sink), logger, config: cfg({ maxCostUsdPerLead: 0.01 }) });
    const r = await svc.write(svcInput(), 'run-1');
    expect(r.outcome).toBe('BUDGET_BLOCKED');
    expect(r.callsMade).toBe(0);
  });

  it('records diagnostics on both approved and rejected runs', async () => {
    const records: { outcome: string; draft: unknown; review: unknown }[] = [];
    const debug = { async record(rec: { outcome: string; draft: unknown; review: unknown }) { records.push(rec); } };
    const ok = new EmailWriterService({ provider: new MockLlmProvider(defaultMockEmailResponder), uow: fakeUow([]), logger, config: cfg(), debug });
    await ok.write(svcInput(), 'run-1');
    const rejResponder = (req: LlmRequest, i: number) => req.task === 'email_write' ? defaultMockEmailResponder(req, i) : { rawJson: reviewJson({ decision: 'REJECT' }) };
    const rej = new EmailWriterService({ provider: new MockLlmProvider(rejResponder), uow: fakeUow([]), logger, config: cfg(), debug });
    await rej.write(svcInput(), 'run-2');
    expect(records.map((r) => r.outcome).sort()).toEqual(['APPROVED_READY', 'REVIEW_REJECTED']);
    for (const r of records) expect(r.draft).not.toBeNull();
  });
});
