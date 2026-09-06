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
  singleObservation: true,
  buyerLanguageOnly: true,
  conversationNotAudit: true,
  confidentObservation: true,
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

describe('cta_in_model_body (click carve-out for hyphenated compounds)', () => {
  it('still rejects model-authored click CTAs', () => {
    const ctaBodies = [
      'The booking action is hidden.\n\nClick here to fix it.',
      'The booking action is hidden.\n\nJust click this link when ready.',
      'The booking action is hidden.\n\nClick below to see the change.',
    ];
    for (const email_body of ctaBodies) {
      const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
      expect(result.violations, email_body).toContain('cta_in_model_body');
    }
  });

  it('does not flag hyphenated compounds / technical nouns that contain "click"', () => {
    const safeBodies = [
      "Your WhatsApp destination does not match the number in the site's click-to-call links.\n\nStandardising those targets removes ambiguity at that step.",
      'The homepage relies on one-click booking that points to an outdated number.\n\nAligning it with the published number would remove the mismatch.',
      'The click-through path from the header goes to a stale contact page.\n\nPointing it at the current details would keep the routes consistent.',
    ];
    for (const email_body of safeBodies) {
      const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
      expect(result.violations, email_body).not.toContain('cta_in_model_body');
    }
  });
});

describe('cta_in_model_body (visit requires a recipient-directed object)', () => {
  it('still rejects recipient-directed visit CTAs', () => {
    const ctaBodies = [
      'The booking action is hidden.\n\nVisit our site to see the fix.',
      'The booking action is hidden.\n\nWhen you are ready, visit us.',
      'The booking action is hidden.\n\nVisit this link for the details.',
      'The booking action is hidden.\n\nVisit your dashboard to review it.',
    ];
    for (const email_body of ctaBodies) {
      const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
      expect(result.violations, email_body).toContain('cta_in_model_body');
    }
  });

  it('does not flag intransitive "visit" in ordinary prose', () => {
    const safeBodies = [
      'The published hours do not line up across the page.\n\nThat matters when a patient is deciding when to visit or call.',
      'The contact details differ between the header and the footer.\n\nA patient may not know which number to use before they visit.',
    ];
    for (const email_body of safeBodies) {
      const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
      expect(result.violations, email_body).not.toContain('cta_in_model_body');
    }
  });
});

describe('excessive_colons (clock-time carve-out)', () => {
  it('does not count H:MM / HH:MM clock-time colons', () => {
    const email_body = [
      'The visible schedule lists Monday until 19:00, Saturday until 17:00 and Sunday until 14:00, while the FAQ gives Monday to Friday 09:00 to 18:00 and Saturday 09:00 to 15:00.',
      'Aligning those hours would make availability clearer.',
    ].join('\n\n');
    const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
    expect(result.violations).not.toContain('excessive_colons');
  });

  it('still flags three or more genuine stylistic colons', () => {
    const email_body = 'One issue stands out: the hours, the contact route: unclear, and the label: vague.\n\nThat is worth a look.';
    const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
    expect(result.violations).toContain('excessive_colons');
  });

  it('still flags stylistic colons even when clock times are also present', () => {
    const email_body = 'Two things stand out: the hours listed as 09:00 to 17:00, the route: unclear, and the label: vague.\n\nWorth aligning.';
    const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
    expect(result.violations).toContain('excessive_colons');
  });

  it('does not flag two stylistic colons alongside several clock times', () => {
    const email_body = 'Two notes: the hours run 09:00 to 17:00 and 18:00 to 19:00, and one label: vague.\n\nWorth aligning.';
    const result = validateEmail({ ...strongEnglish(), email_body }, validationContext());
    expect(result.violations).not.toContain('excessive_colons');
  });
});

describe('Norwood canary revalidation (both false positives removed)', () => {
  // The exact writer draft the paid Norwood canary produced previously failed the deterministic
  // gate on cta_in_model_body ("visit or call") and excessive_colons (six HH:MM opening hours).
  // With both narrow fixes it must now validate cleanly so the reviewer can run.
  const norwoodWriter: EmailWriterOutput = {
    ...strongEnglish(),
    subject_options: [
      'Something I noticed on Norwood Road Dental Clinic’s site',
      'A question about the opening hours on your site',
      'The two schedules on your Norwood Road page',
    ],
    selected_subject: 'Something I noticed on Norwood Road Dental Clinic’s site',
    selected_subject_reason:
      'It signals a specific observation without revealing which detail, so the recipient is curious enough to open.',
    email_body: [
      'The hours shown on Norwood Road Dental Clinic’s page do not line up. The visible schedule lists Monday until 19:00, Saturday until 17:00 and Sunday until 14:00, while the FAQ gives Monday to Friday 09:00 to 18:00 and Saturday 09:00 to 15:00.',
      'Because the page also says appointments can be booked by phone seven days a week, it is unclear whether either schedule refers to clinic opening or telephone-booking hours.',
      'Clear hours matter when a patient is deciding when to visit or call.',
    ].join('\n\n'),
    evidence_ids: ['3d62f702-ffe1-4573-930b-4fe24edd75d2', '4e8a7b19-775e-47a5-98b1-1248c285759f'],
    strategic_angle:
      'Highlight one patient-facing ambiguity in the clinic’s published hours and invite a conversation about the details.',
    business_relevance:
      'Patients need clear clinic and telephone-booking hours when deciding when to visit or call.',
    urgency_basis:
      'The conflicting schedules are currently visible within the patient journey and concern practical access information.',
    competitor_evidence_used: 'NONE',
    primary_cta: 'REPLY_FOR_DETAILS',
    prohibited_phrase_scan: 'PASS',
    punctuation_scan: 'PASS',
    genericity_score: 15,
    human_style_result: 'PASS',
    demo_alignment_result: 'NOT_APPLICABLE',
  };

  const norwoodContext: EmailValidationContext = {
    availableEvidenceIds: new Set([
      '3d62f702-ffe1-4573-930b-4fe24edd75d2',
      '4e8a7b19-775e-47a5-98b1-1248c285759f',
    ]),
    factEvidenceIds: new Set(['3d62f702-ffe1-4573-930b-4fe24edd75d2']),
    acceptedFindingIds: new Set(['4e8a7b19-775e-47a5-98b1-1248c285759f']),
    approvedDemoFindingIds: new Set<string>(),
    demoLinkAllowed: false,
    language: 'en',
  };

  it('passes the deterministic copy gate with no violations', () => {
    const result = validateEmail(norwoodWriter, norwoodContext);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
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

describe('Day-1 single-observation quality backstop', () => {
  it('fails a technical mini-audit that leaks implementation jargon', () => {
    const miniAudit: EmailWriterOutput = {
      ...strongEnglish(),
      email_body: [
        "Diamond Smile's homepage call button points to a tel: link that has an encoded space (%20) in the href.",
        'The phone target also carries a leading space, so tapping it does not dial on mobile.',
      ].join('\n\n'),
    };
    const result = validateEmail(miniAudit, validationContext());
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('contains_implementation_jargon');
  });

  it('passes a plain buyer-language single observation about the same issue', () => {
    const plain: EmailWriterOutput = {
      ...strongEnglish(),
      email_body: [
        "Diamond Smile's call button does not connect when a visitor taps it on a phone.",
        'That quietly turns people away at the moment they are ready to get in touch.',
      ].join('\n\n'),
    };
    expect(validateEmail(plain, validationContext()).ok).toBe(true);
  });

  it('still allows one justified qualifier', () => {
    const oneQualifier: EmailWriterOutput = {
      ...strongEnglish(),
      email_body: [
        "Diamond Smile's call button might not connect when a visitor taps it on a phone.",
        'That quietly turns people away at the moment they are ready to get in touch.',
      ].join('\n\n'),
    };
    expect(validateEmail(oneQualifier, validationContext()).ok).toBe(true);
  });

  it('does not ban ordinary words like click, test, or verify', () => {
    const ordinary: EmailWriterOutput = {
      ...strongEnglish(),
      email_body: [
        "Diamond Smile's call button does not connect when a visitor taps it on a phone.",
        'A quick test from a phone shows the number does not open the dialer as expected.',
      ].join('\n\n'),
    };
    const result = validateEmail(ordinary, validationContext());
    expect(result.violations).not.toContain('contains_implementation_jargon');
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

  it('renders a named greeting only from a verified contact fact AND a PERSONAL_VERIFIED recipient', () => {
    // Knowing the owner's name is necessary but no longer sufficient: the greeting is now gated on
    // the resolved recipient too, so a generic business inbox is never addressed as a person.
    const nameFacts = [...baseFacts(), fact('fact-contact', 'contact_name', 'Dr. Meyer')];
    const personal = inputs({ facts: nameFacts });
    personal.recipient = { contactType: 'PERSONAL_VERIFIED', email: 'meyer@praxis.example', intendedDecisionMakers: [] };
    expect(renderEmail(strongEnglish(), personal).body.startsWith('Hello Dr. Meyer,')).toBe(true);

    const generic = inputs({ facts: nameFacts });
    generic.recipient = { contactType: 'GENERIC_OFFICIAL', email: 'info@praxis.example', intendedDecisionMakers: [{ fullName: 'Dr. Meyer', title: 'Principal' }] };
    expect(renderEmail(strongEnglish(), generic).body.startsWith('Hello,')).toBe(true);

    // No recipient contract at all: fail closed, stay neutral.
    expect(renderEmail(strongEnglish(), inputs({ facts: nameFacts })).body.startsWith('Hello,')).toBe(true);
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

  for (const flag of ['singleObservation', 'buyerLanguageOnly', 'conversationNotAudit', 'confidentObservation'] as const) {
    it(`does not approve when the reviewer fails ${flag}`, async () => {
      const responder = (request: LlmRequest, index: number) =>
        request.task === 'email_write'
          ? defaultMockEmailResponder(request, index)
          : { rawJson: reviewJson({ [flag]: false }) };
      const service = new EmailWriterService({
        provider: new MockLlmProvider(responder),
        uow: fakeUow([]),
        logger,
        config: config(),
      });
      expect((await service.write(serviceInput(), 'run-1')).outcome).toBe('REVIEW_REJECTED');
    });
  }

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

describe('EmailWriterService — no-demo OPPORTUNITY_READY path', () => {
  // A uow that records the exact transition sequence the writer requests.
  function spyingUow(sink: EmailPersist[], leadStatus: string, transitions: string[]): EmailUnitOfWork {
    const leadService = { async transition(_id: string, to: string) { transitions.push(to); } } as unknown as LeadService;
    return {
      async transaction(fn) {
        return fn({
          leads: { async getById() { return { id: 'lead-1', status: leadStatus } as unknown as Lead; } } as never,
          leadService,
          emails: { async persist(record: EmailPersist) { sink.push(record); } },
          events: { async record() { /* no-op */ } },
        });
      },
    };
  }

  it('advances an OPPORTUNITY_READY lead (demo=null) to READY_FOR_HUMAN_APPROVAL', async () => {
    const sink: EmailPersist[] = [];
    const transitions: string[] = [];
    const service = new EmailWriterService({
      provider: new MockLlmProvider(defaultMockEmailResponder),
      uow: spyingUow(sink, 'OPPORTUNITY_READY', transitions),
      logger,
      config: config(),
    });
    const result = await service.write(serviceInput(), 'run-1');
    expect(result.outcome).toBe('APPROVED_READY');
    expect(sink[0]!.routeTo).toBe('READY_FOR_HUMAN_APPROVAL');
    // No demo → no {{DEMO_URL}} placeholder, reply-only email.
    expect(sink[0]!.email?.hasDemoUrlPlaceholder).toBe(false);
    // Same advance sequence as the demo-bearing states.
    expect(transitions).toEqual(['EMAIL_DRAFTED', 'EMAIL_APPROVED', 'READY_FOR_HUMAN_APPROVAL']);
  });

  it('routes a rejected OPPORTUNITY_READY draft to EMAIL_REVIEW_FAILED', async () => {
    const sink: EmailPersist[] = [];
    const transitions: string[] = [];
    // Reviewer rejects → REVIEW_REJECTED → EMAIL_REVIEW_FAILED.
    const responder = (request: LlmRequest, index: number) =>
      request.task === 'email_write'
        ? defaultMockEmailResponder(request, index)
        : { rawJson: reviewJson({ decision: 'REJECT', persuasive: false }) };
    const service = new EmailWriterService({
      provider: new MockLlmProvider(responder),
      uow: spyingUow(sink, 'OPPORTUNITY_READY', transitions),
      logger,
      config: config(),
    });
    const result = await service.write(serviceInput(), 'run-1');
    expect(result.outcome).toBe('REVIEW_REJECTED');
    expect(transitions).toEqual(['EMAIL_DRAFTED', 'EMAIL_REVIEW_FAILED']);
  });
});

describe('no-demo email cannot leak a demo claim (validation fences)', () => {
  it('rejects a VIEW_CONCEPT CTA when no demo is allowed', () => {
    const out = { ...strongEnglish(), primary_cta: 'VIEW_CONCEPT' as const };
    const result = validateEmail(out, validationContext('en', false));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('demo_cta_without_approved_demo');
  });

  it('rejects a demo/prototype mention in the body when no demo is allowed', () => {
    const out = { ...strongEnglish(), email_body: `${strongEnglish().email_body} I can show you a quick prototype.` };
    const result = validateEmail(out, validationContext('en', false));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('mentions_demo_without_approved_demo');
  });
});
