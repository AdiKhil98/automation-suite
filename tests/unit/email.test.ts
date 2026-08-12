import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { emailReviewSchema, emailWriterSchema } from '../../src/domain/email/email-schema.js';
import {
  buildEmailContext,
  renderEmail,
  type EmailFinding,
  type EmailInputs,
} from '../../src/domain/email/email-render.js';
import { type EmailValidationContext, validateEmail } from '../../src/domain/email/email-validation.js';
import { resolveEmailLanguage } from '../../src/domain/email/email-language.js';
import { DEMO_URL_TOKEN, type EmailWriterOutput } from '../../src/domain/email/email-types.js';
import { worstCaseEmailInputTokens } from '../../src/domain/email/email-token-budget.js';
import {
  EmailWriterService,
  type EmailConfig,
  type EmailPersist,
  type EmailUnitOfWork,
} from '../../src/domain/email/email-writer-service.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadService } from '../../src/domain/leads/lead-service.js';
import { defaultMockEmailResponder } from '../../src/fixtures/mock-email-responses.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { type LlmRequest } from '../../src/integrations/llm/provider.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';

const fact = (id: string, factType: string, value: string): LeadFact => ({
  id,
  leadId: 'lead-1',
  factType: factType as LeadFact['factType'],
  value,
  normalizedValue: value.toLowerCase(),
  sourceType: 'website',
  sourceUrl: 'https://linden-dental.example/evidence',
  capturedAt: new Date('2026-07-23T10:00:00Z'),
  confidence: 1,
  supersededBy: null,
  supersededAt: null,
  isCurrent: true,
});

const finding = (id: string, ref: string): EmailFinding => ({
  id,
  findingRef: ref,
  category: 'CTA_CLARITY',
  safeForOutreach: true,
  observation: 'The appointment action is difficult to find on the main page.',
  recommendation: 'Make the appointment action visible earlier.',
});

const baseFacts = (): LeadFact[] => [
  fact('fact-business', 'business_name', 'Linden Dental'),
  fact('fact-city', 'city', 'Berlin'),
  fact('fact-services', 'services', 'Implantology|Whitening'),
];

const inputs = (overrides: Partial<EmailInputs> = {}): EmailInputs => ({
  facts: baseFacts(),
  findings: [finding('finding-cta', 'F1'), finding('finding-other', 'F2')],
  demo: null,
  ...overrides,
});

const validationContext = (
  language: 'en' | 'de' = 'en',
  demoAllowed = false,
  approvedDemoFindingIds: string[] = [],
): EmailValidationContext => ({
  availableEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services', 'finding-cta', 'finding-other']),
  factEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services']),
  acceptedFindingIds: new Set(['finding-cta', 'finding-other']),
  approvedDemoFindingIds: new Set(approvedDemoFindingIds),
  demoLinkAllowed: demoAllowed,
  language,
});

const strongEnglish = (): EmailWriterOutput =>
  EMAIL_COPY_FIXTURES.find((fixture) => fixture.name === 'strong English business email')!.writer;

const reviewJson = (overrides: Record<string, unknown> = {}) => ({
  decision: 'APPROVE',
  fabricationRisk: false,
  subjectSpecific: true,
  subjectCuriosityGap: true,
  openingSpecific: true,
  businessRelevanceClear: true,
  urgencySupported: true,
  competitorClaimsSupported: true,
  humanStylePass: true,
  punctuationPass: true,
  singlePrimaryCta: true,
  sufficientlyPersonalized: true,
  evidenceSupported: true,
  demoAligned: true,
  persuasive: true,
  problems: [],
  requiredRevisions: [],
  ...overrides,
});

describe('Cold Email Copy Standard schemas', () => {
  it('requires the exact writer and reviewer contracts', () => {
    expect(emailWriterSchema.safeParse(strongEnglish()).success).toBe(true);
    expect(emailReviewSchema.safeParse(reviewJson()).success).toBe(true);
    expect(emailWriterSchema.safeParse({ ...strongEnglish(), subject_options: ['one', 'two'] }).success).toBe(false);
    const withoutCuriosity: Record<string, unknown> = { ...reviewJson() };
    delete withoutCuriosity.subjectCuriosityGap;
    expect(emailReviewSchema.safeParse(withoutCuriosity).success).toBe(false);
  });
});

describe('Cold Email Copy Standard fixtures', () => {
  for (const fixture of EMAIL_COPY_FIXTURES) {
    it(fixture.name, () => {
      expect(fixture.businessDomain.endsWith('.example')).toBe(true);
      const result = validateEmail(
        fixture.writer,
        validationContext(
          fixture.language,
          fixture.demoAllowed ?? false,
          fixture.approvedDemoFindingIds ?? [],
        ),
      );
      expect(result.ok).toBe(fixture.expectedOk);
      if (fixture.expectedViolation) expect(result.violations).toContain(fixture.expectedViolation);
    });
  }

  it('rejects excessive length, markdown, emoji, repeated commas, and an emitted demo token', () => {
    const cases: Array<[Partial<EmailWriterOutput>, string]> = [
      [{ email_body: `${Array.from({ length: 121 }, () => 'word').join(' ')}\n\nFinal sentence.` }, 'body_too_long:123'],
      [{ email_body: 'The booking action is hidden.\n\n- This is a markdown bullet.' }, 'contains_markdown'],
      [{ email_body: 'The booking action is hidden. 😊\n\nThat affects booking.' }, 'contains_emoji'],
      [{ email_body: 'The booking action is hidden,, today.\n\nThat affects booking.' }, 'contains_repeated_commas'],
      [{ email_body: `The approved concept uses ${DEMO_URL_TOKEN}.\n\nThat affects booking.` }, 'model_emitted_demo_url_token'],
    ];
    for (const [overrides, violation] of cases) {
      const result = validateEmail({ ...strongEnglish(), ...overrides }, validationContext());
      expect(result.violations, violation).toContain(violation);
    }
  });
});

describe('revealing-subject denylist (high precision)', () => {
  const withSubjects = (options: [string, string, string], selected: string): EmailWriterOutput =>
    ({ ...strongEnglish(), subject_options: options, selected_subject: selected });
  const filler: [string, string] = ['Neutral filler subject alpha', 'Neutral filler subject beta'];

  it('flags subjects that summarize the finding or pitch', () => {
    const revealing = [
      'Improve your online booking',
      'Website booking suggestion',
      'Direct booking opportunity',
      "Fresh Dental's appointment booking path",
    ];
    for (const subject of revealing) {
      const result = validateEmail(withSubjects([subject, ...filler], filler[0]), validationContext());
      expect(result.violations, subject).toContain('subject_reveals_finding:1');
    }
  });

  it('does not flag curiosity-gap subjects (prefers false negatives)', () => {
    const safe = [
      "Something I noticed on Fresh Dental's website",
      'One thing I noticed on your site',
      'Quick question about Fresh Dental',
      "This caught my eye on Fresh Dental's site",
      'Small observation about Fresh Dental',
    ];
    for (const subject of safe) {
      const result = validateEmail(withSubjects([subject, ...filler], subject), validationContext());
      expect(result.violations.some((v) => v.startsWith('subject_reveals_finding')), subject).toBe(false);
    }
  });
});

describe('email rendering and language', () => {
  it('renders one deterministic CTA and tracks exact evidence IDs', () => {
    const rendered = renderEmail(strongEnglish(), inputs());
    expect(rendered.subject).toBe(strongEnglish().selected_subject);
    expect(rendered.ctaKind).toBe('reply');
    expect(rendered.body).toContain('reply and I will share the details.');
    expect(rendered.body).not.toMatch(/[\u2013\u2014]|--/);
    expect(rendered.factInputs.map((item) => item.factId)).toContain('fact-business');
    expect(rendered.findingInputs.map((item) => item.findingId)).toContain('finding-cta');
  });

  it('renders a named greeting only from a verified contact fact', () => {
    const withName = inputs({ facts: [...baseFacts(), fact('fact-contact', 'contact_name', 'Dr. Meyer')] });
    expect(renderEmail(strongEnglish(), withName).body.startsWith('Hello Dr. Meyer,')).toBe(true);
    expect(renderEmail(strongEnglish(), inputs()).body.startsWith('Hello,')).toBe(true);
  });

  it('resolves and renders German consistently', () => {
    const germanWriter = EMAIL_COPY_FIXTURES.find((fixture) => fixture.name === 'strong German dental email')!.writer;
    const germanInputs = inputs({
      facts: [...baseFacts(), fact('fact-site', 'official_website_url', 'https://zahnarzt-linden.de/')],
    });
    expect(resolveEmailLanguage(germanInputs.facts)).toBe('de');
    const rendered = renderEmail(germanWriter, germanInputs);
    expect(rendered.body.startsWith('Hallo,')).toBe(true);
    expect(rendered.body).toContain('Beste Grüße');
  });

  it('keeps an approved concept URL as an unresolved deterministic token', () => {
    const writer: EmailWriterOutput = {
      ...strongEnglish(),
      email_body: [
        "Linden Dental's appointment action is difficult to find.",
        'The approved concept demonstrates a clearer path from patient interest to booking.',
      ].join('\n\n'),
      primary_cta: 'VIEW_CONCEPT',
      demo_alignment_result: 'PASS',
    };
    const demoInputs = inputs({
      demo: { id: 'demo-1', status: 'APPROVED', ctaKind: 'booking', approvedFindingRefs: ['F1'] },
    });
    expect(validateEmail(writer, buildEmailContext(demoInputs)).ok).toBe(true);
    const rendered = renderEmail(writer, demoInputs);
    expect(rendered.ctaKind).toBe('demo_link');
    expect(rendered.body).toContain(DEMO_URL_TOKEN);
    expect(rendered.hasDemoUrlPlaceholder).toBe(true);
  });
});

function fakeUow(sink: EmailPersist[], leadStatus = 'DEMO_READY'): EmailUnitOfWork {
  const leadService = { async transition() { /* no-op */ } } as unknown as LeadService;
  return {
    async transaction(fn) {
      return fn({
        leads: {
          async getById() {
            return { id: 'lead-1', status: leadStatus } as unknown as Lead;
          },
        } as never,
        leadService,
        emails: { async persist(record: EmailPersist) { sink.push(record); } },
        events: { async record() { /* no-op */ } },
      });
    },
  };
}

const config = (overrides: Partial<EmailConfig> = {}): EmailConfig => ({
  writerModel: 'gpt-5.6-sol',
  reviewerModel: 'gpt-5.6-terra',
  writerEffort: 'medium',
  reviewerEffort: 'medium',
  store: false,
  timeoutMs: 1_000,
  maxOutputTokens: 1_500,
  maxRetries: 0,
  maxCallsPerLead: 2,
  maxCostUsdPerLead: 0.2,
  worstCaseInputTokensPerCall: worstCaseEmailInputTokens(),
  ...overrides,
});

const serviceInput = (overrides: Record<string, unknown> = {}) => ({
  leadId: 'lead-1',
  facts: baseFacts(),
  findings: [finding('finding-cta', 'F1')],
  demo: null,
  opportunityScore: 60,
  ...overrides,
});

const logger = pino({ level: 'silent' });

describe('EmailWriterService quality gates', () => {
  it('approves mock copy but still routes it to human approval', async () => {
    const sink: EmailPersist[] = [];
    const service = new EmailWriterService({
      provider: new MockLlmProvider(defaultMockEmailResponder),
      uow: fakeUow(sink),
      logger,
      config: config(),
    });
    const result = await service.write(serviceInput(), 'run-1');
    expect(result.outcome).toBe('APPROVED_READY');
    expect(sink[0]!.routeTo).toBe('READY_FOR_HUMAN_APPROVAL');
    expect(sink[0]!.email?.status).toBe('APPROVED');
  });

  it('parks aligned approved-demo copy until URL deployment and second human review', async () => {
    const sink: EmailPersist[] = [];
    const service = new EmailWriterService({
      provider: new MockLlmProvider(defaultMockEmailResponder),
      uow: fakeUow(sink),
      logger,
      config: config(),
    });
    const result = await service.write(serviceInput({
      demo: { id: 'demo-1', status: 'APPROVED', ctaKind: 'booking', approvedFindingRefs: ['F1'] },
    }), 'run-1');
    expect(result.outcome).toBe('APPROVED_WAITING_URL');
    expect(sink[0]!.routeTo).toBe('WAITING_FOR_DEMO_URL');
  });

  it('does not approve unchanged copy when reviewer requests revisions', async () => {
    const responder = (request: LlmRequest, index: number) =>
      request.task === 'email_write'
        ? defaultMockEmailResponder(request, index)
        : { rawJson: reviewJson({
          decision: 'APPROVE_WITH_REVISIONS',
          persuasive: false,
          requiredRevisions: ['Make the business consequence clearer.'],
        }) };
    const service = new EmailWriterService({
      provider: new MockLlmProvider(responder),
      uow: fakeUow([]),
      logger,
      config: config(),
    });
    expect((await service.write(serviceInput(), 'run-1')).outcome).toBe('REVIEW_REJECTED');
  });

  it('does not approve when the reviewer flags a missing subject curiosity gap', async () => {
    const responder = (request: LlmRequest, index: number) =>
      request.task === 'email_write'
        ? defaultMockEmailResponder(request, index)
        : { rawJson: reviewJson({ subjectCuriosityGap: false }) };
    const service = new EmailWriterService({
      provider: new MockLlmProvider(responder),
      uow: fakeUow([]),
      logger,
      config: config(),
    });
    expect((await service.write(serviceInput(), 'run-1')).outcome).toBe('REVIEW_REJECTED');
  });

  it('stops before reviewer cost when deterministic validation fails', async () => {
    const responder = (request: LlmRequest, index: number) => {
      if (request.task !== 'email_write') return defaultMockEmailResponder(request, index);
      const base = defaultMockEmailResponder(request, index).rawJson as EmailWriterOutput;
      return { rawJson: { ...base, email_body: 'Visit https://unsafe.example now.\n\nThat affects booking.' } };
    };
    const provider = new MockLlmProvider(responder);
    const service = new EmailWriterService({
      provider,
      uow: fakeUow([]),
      logger,
      config: config(),
    });
    expect((await service.write(serviceInput(), 'run-1')).outcome).toBe('VALIDATION_FAILED');
    expect(provider.calls).toHaveLength(1);
  });

  it('blocks a paid provider before a call when projected cost exceeds the cap', async () => {
    const provider = {
      name: 'openai',
      async generate(request: LlmRequest) {
        return {
          status: 'ok' as const,
          rawJson: request.task === 'email_write' ? strongEnglish() : reviewJson(),
          refusal: null,
          incompleteReason: null,
          provider: 'openai',
          requestedModel: request.model,
          resolvedModel: request.model,
          requestId: 'request-1',
          responseId: 'response-1',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
            estimatedCostUsd: 0.01,
          },
          latencyMs: 1,
          imageDetail: null,
        };
      },
    };
    const service = new EmailWriterService({
      provider,
      uow: fakeUow([]),
      logger,
      config: config({ maxCostUsdPerLead: 0.01 }),
    });
    const result = await service.write(serviceInput(), 'run-1');
    expect(result.outcome).toBe('BUDGET_BLOCKED');
    expect(result.callsMade).toBe(0);
  });
});
