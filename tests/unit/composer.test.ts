import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LocalComposerDebugStore, type ComposerDebugRecord } from '../../src/integrations/demo/composer-debug-store.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadService } from '../../src/domain/leads/lead-service.js';
import {
  type DemoDesignSpec,
} from '../../src/domain/demo/composer/design-spec.js';
import { designReviewSchema, designSpecSchema, DESIGN_SPEC_JSON_SCHEMA, DESIGN_REVIEW_JSON_SCHEMA } from '../../src/domain/demo/composer/composer-schema.js';
import { buildSpecContext, composeDemo } from '../../src/domain/demo/composer/compose.js';
import { validateDesignSpec } from '../../src/domain/demo/composer/spec-validation.js';
import { BODY_COMPONENTS, FOOTERS, HEADERS } from '../../src/domain/demo/composer/components.js';
import { worstCaseComposerInputTokens } from '../../src/domain/demo/composer/composer-token-budget.js';
import {
  DemoComposerService,
  type ComposerAcceptedFinding,
  type ComposerConfig,
  type ComposerPersist,
  type ComposerUnitOfWork,
} from '../../src/domain/demo/composer/demo-composer-service.js';
import { MockLlmProvider } from '../../src/integrations/llm/mock-llm.js';
import { type LlmProvider, type LlmRequest, type LlmResult } from '../../src/integrations/llm/provider.js';
import { defaultMockComposerResponder } from '../../src/fixtures/mock-composer-responses.js';

let n = 0;
function fact(factType: string, value: string): LeadFact {
  n += 1;
  return {
    id: `f-${n}`, leadId: 'lead-1', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
    sourceType: 'website', sourceUrl: null, capturedAt: new Date(), confidence: 1,
    supersededBy: null, supersededAt: null, isCurrent: true,
  };
}

const richFacts = (): LeadFact[] => [
  fact('business_name', 'Zahnärzte am Ufer'),
  fact('city', 'Berlin'),
  fact('phone', '+49 30 1234567'),
  fact('contact_email', 'info@example.de'),
  fact('formatted_address', 'Uferstr. 1, Berlin'),
  fact('services', 'Implantology|Whitening|Checkups'),
  fact('opening_hours', 'Mon 9-17;Tue 9-17'),
  fact('official_website_url', 'https://example.de/'),
];

const finding = (ref: string, category = 'CTA_CLARITY', safe = true): ComposerAcceptedFinding => ({
  id: `af-${ref}`, findingRef: ref, category, safeForOutreach: safe, observation: `obs ${ref}`, recommendation: `rec ${ref}`,
});

interface ReviewShape {
  decision: 'APPROVE' | 'REVISE' | 'REJECT';
  fabricationRisk: boolean;
  evidenceConsistent: boolean;
  ctaHonest: boolean;
  revisionRequiresNewFacts: boolean;
  revisionRequiresNewClaims: boolean;
  revisionRequiresCtaChange: boolean;
  problems: string[];
}
const review = (over: Partial<ReviewShape> = {}): ReviewShape => ({
  decision: 'APPROVE', fabricationRisk: false, evidenceConsistent: true, ctaHonest: true,
  revisionRequiresNewFacts: false, revisionRequiresNewClaims: false, revisionRequiresCtaChange: false, problems: [], ...over,
});

function validSpec(overrides: Partial<DemoDesignSpec> = {}): DemoDesignSpec {
  return {
    visualDirection: 'CLEAN_CLINICAL',
    heroStrategy: 'CLARITY_FIRST',
    headerVariant: 'header-a',
    footerVariant: 'footer-a',
    primaryCtaIntent: 'call',
    primaryCtaLabelKey: 'CALL_US',
    secondaryCtaEnabled: false,
    sections: [
      { componentId: 'hero-a', order: 1, addressesFindingRef: 'F1', factKeys: ['business_name', 'city'], messagingEmphasis: 'CLARITY' },
      { componentId: 'services-a', order: 2, addressesFindingRef: null, factKeys: ['services'], messagingEmphasis: 'PROFESSIONALISM' },
      { componentId: 'contact-a', order: 3, addressesFindingRef: null, factKeys: ['phone', 'address'], messagingEmphasis: 'CONVENIENCE' },
    ],
    mobilePriority: ['hero-a', 'contact-a'],
    rationale: 'test',
    ...overrides,
  };
}

describe('composer schema', () => {
  it('parses a valid spec and a valid review', () => {
    expect(designSpecSchema.safeParse(validSpec()).success).toBe(true);
    expect(designReviewSchema.safeParse(review()).success).toBe(true);
  });
  it('rejects an unknown component id / enum', () => {
    const bad = validSpec({ visualDirection: 'NEON' as DemoDesignSpec['visualDirection'] });
    expect(designSpecSchema.safeParse(bad).success).toBe(false);
  });
  it('strict JSON schemas forbid additional properties', () => {
    expect(DESIGN_SPEC_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(DESIGN_REVIEW_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('spec validation', () => {
  const ctx = () => buildSpecContext(richFacts(), ['F1', 'F2']);

  it('accepts a well-formed spec', () => {
    expect(validateDesignSpec(validSpec(), ctx()).ok).toBe(true);
  });
  it('rejects a hero that is not first', () => {
    const spec = validSpec({
      sections: [
        { componentId: 'contact-a', order: 1, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
        { componentId: 'hero-a', order: 2, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'CLARITY' },
      ],
      mobilePriority: [],
    });
    expect(validateDesignSpec(spec, ctx()).violations).toContain('hero_not_first');
  });
  it('rejects a duplicate section type and a missing contact section', () => {
    const spec = validSpec({
      sections: [
        { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'CLARITY' },
        { componentId: 'services-b', order: 2, addressesFindingRef: null, factKeys: ['services'], messagingEmphasis: 'CLARITY' },
        { componentId: 'services-a', order: 3, addressesFindingRef: null, factKeys: ['services'], messagingEmphasis: 'CLARITY' },
      ],
      mobilePriority: [],
    });
    const v = validateDesignSpec(spec, ctx()).violations;
    expect(v).toContain('duplicate_section_type:services');
    expect(v).toContain('contact_section_required');
  });
  it('rejects an unknown finding ref and an unavailable fact key', () => {
    const spec = validSpec({
      sections: [
        { componentId: 'hero-a', order: 1, addressesFindingRef: 'F9', factKeys: ['booking_url'], messagingEmphasis: 'CLARITY' },
        { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
      ],
      mobilePriority: [],
    });
    const v = validateDesignSpec(spec, ctx()).violations;
    expect(v).toContain('unknown_finding_ref:F9');
    expect(v.some((x) => x.startsWith('unavailable_fact_key'))).toBe(true);
  });
  it('rejects a booking CTA intent when no booking URL is verified', () => {
    const spec = validSpec({ primaryCtaIntent: 'booking', primaryCtaLabelKey: 'BOOK_APPOINTMENT' });
    expect(validateDesignSpec(spec, ctx()).violations).toContain('cta_intent_not_achievable:booking');
  });
  it('rejects a label key that does not match the intent', () => {
    const spec = validSpec({ primaryCtaIntent: 'scroll', primaryCtaLabelKey: 'CALL_US' });
    expect(validateDesignSpec(spec, ctx()).violations.some((x) => x.startsWith('cta_label_intent_mismatch'))).toBe(true);
  });
  it('rejects a services section without a services fact', () => {
    const noServices = richFacts().filter((f) => f.factType !== 'services');
    const c = buildSpecContext(noServices, ['F1']);
    expect(validateDesignSpec(validSpec(), c).violations).toContain('services_section_without_services_fact');
  });
});

describe('components render safe markup', () => {
  const sample = composeDemo(validSpec({ sections: [
    { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'CLARITY' },
    { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
  ], mobilePriority: [] }), { facts: richFacts(), findings: [] });

  it('every body/header/footer component emits no script/on-handler', () => {
    const cta = { label: 'Get in touch', href: '#contact' };
    const input = { content: sample.built!.content, emphasis: 'CLARITY' as const, heroStrategy: 'CLARITY_FIRST' as const, cta, secondaryCtaHtml: '' };
    for (const render of Object.values(BODY_COMPONENTS)) {
      const html = render(input);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son\w+=/i);
    }
    for (const h of Object.values(HEADERS)) expect(h('Practice', true)).not.toMatch(/<script/i);
    for (const f of Object.values(FOOTERS)) expect(f('Practice', 'Concept redesign disclosure')).not.toMatch(/<script/i);
  });
});

describe('composeDemo (deterministic render)', () => {
  it('renders a complete, secure page from a valid spec', () => {
    const r = composeDemo(validSpec(), { facts: richFacts(), findings: [finding('F1')] });
    expect(r.outcome).toBe('DEMO_COMPOSED');
    const b = r.built!;
    expect(b.html).toContain('Zahnärzte am Ufer');
    expect(b.html).toContain('noindex,nofollow,noarchive');
    expect(b.html).toContain('Content-Security-Policy');
    expect(b.html.toLowerCase()).toContain('concept redesign');
    expect(b.html).toContain('class="cta"');
    expect(b.ctaKind).toBe('tel');
    // Provenance: business name + CTA phone traced to facts; the addressed finding tracked.
    expect(b.factInputs.some((fi) => fi.field === 'business_name')).toBe(true);
    expect(b.factInputs.some((fi) => fi.field === 'cta.href')).toBe(true);
    expect(b.findingInputs.map((f) => f.findingRef)).toContain('F1');
    // Deterministic: identical inputs → identical hash.
    const r2 = composeDemo(validSpec(), { facts: richFacts(), findings: [finding('F1')] });
    expect(r2.built!.contentHash).toBe(b.contentHash);
  });

  it('returns SPEC_INVALID for a spec referencing unavailable facts', () => {
    const noServices = richFacts().filter((f) => f.factType !== 'services');
    const r = composeDemo(validSpec(), { facts: noServices, findings: [finding('F1')] });
    expect(r.outcome).toBe('SPEC_INVALID');
    expect(r.built).toBeUndefined();
  });

  it('escapes malicious fact values (no injection)', () => {
    const evil = [
      fact('business_name', '<script>window.x=1</script>"><img src=x onerror=alert(1)>'),
      fact('city', 'Berlin'),
      fact('phone', '+49 30 1234567'),
    ];
    const spec = validSpec({ sections: [
      { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: ['business_name', 'city'], messagingEmphasis: 'CLARITY' },
      { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
    ], mobilePriority: [] });
    const r = composeDemo(spec, { facts: evil, findings: [] });
    expect(r.outcome).toBe('DEMO_COMPOSED');
    expect(r.built!.html).not.toMatch(/<script/i);
    expect(r.built!.html).toContain('&lt;script&gt;');
  });

  it('drops services provenance when no services section is chosen', () => {
    const spec = validSpec({ sections: [
      { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'CLARITY' },
      { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
    ], mobilePriority: [] });
    const r = composeDemo(spec, { facts: richFacts(), findings: [] });
    expect(r.built!.factInputs.some((fi) => fi.field === 'services')).toBe(false);
    expect(r.built!.html).not.toContain('id="services"');
  });
});

describe('composer token budget', () => {
  it('is a small, fixed text-only bound', () => {
    const t = worstCaseComposerInputTokens();
    expect(t).toBeGreaterThan(3000);
    expect(t).toBeLessThan(12000);
  });
});

// --- Service orchestration (mock provider; zero paid calls) ---

function fakeUow(sink: ComposerPersist[], leadStatus = 'OPPORTUNITY_READY'): ComposerUnitOfWork {
  const transitions: string[] = [];
  const leadService = { async transition(_id: string, to: string) { transitions.push(to); } } as unknown as LeadService;
  return {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'lead-1', status: leadStatus } as unknown as Lead; } } as never,
        leadService,
        composer: { async persist(r: ComposerPersist) { sink.push(r); } },
        events: { async record() { /* noop */ } },
      });
    },
  };
}

const baseConfig = (over: Partial<ComposerConfig> = {}): ComposerConfig => ({
  generatorModel: 'gpt-5.6-sol', reviewerModel: 'gpt-5.6-terra', generatorEffort: 'medium', reviewerEffort: 'medium',
  store: false, timeoutMs: 1000, maxOutputTokens: 2500, maxRetries: 0, maxCallsPerDemo: 2, maxCostUsdPerDemo: 0.35,
  worstCaseInputTokensPerCall: worstCaseComposerInputTokens(), templateId: 'composer-v1', templateVersion: 'composer-tpl-1', ...over,
});

const logger = pino({ level: 'silent' });

describe('DemoComposerService (mock)', () => {
  it('composes a demo end-to-end and reaches DEMO_COMPOSED', async () => {
    const sink: ComposerPersist[] = [];
    const provider = new MockLlmProvider(defaultMockComposerResponder);
    const svc = new DemoComposerService({ provider, uow: fakeUow(sink), writer: { async write() { return '/demos/lead-1'; } }, logger, config: baseConfig() });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('DEMO_COMPOSED');
    expect(r.demoPath).toBe('/demos/lead-1');
    expect(r.costUsd).toBe(0);
    const p = sink[0]!;
    expect(p.demo?.status).toBe('GENERATED_PENDING_REVIEW');
    expect(p.designSpec).not.toBeNull();
    expect(p.modelCalls).toHaveLength(2);
    expect(p.modelCalls.map((m) => m.purpose)).toEqual(['demo_design', 'demo_design_review']);
  });

  it('rejects when the reviewer flags fabrication risk', async () => {
    const sink: ComposerPersist[] = [];
    const responder = (req: LlmRequest, i: number) => req.task === 'demo_design'
      ? defaultMockComposerResponder(req, i)
      : { rawJson: review({ decision: 'REJECT', fabricationRisk: true, problems: ['fabricated services'] }) };
    const svc = new DemoComposerService({ provider: new MockLlmProvider(responder), uow: fakeUow(sink), writer: { async write() { return '/x'; } }, logger, config: baseConfig() });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('REVIEW_REJECTED');
    expect(sink[0]!.demo).toBeNull();
  });

  it('returns SPEC_INVALID (before the reviewer) when the generator cites an unavailable fact', async () => {
    const sink: ComposerPersist[] = [];
    const badSpec = validSpec({ sections: [
      { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: ['booking_url'], messagingEmphasis: 'CLARITY' },
      { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
    ], mobilePriority: [] });
    const responder = (req: LlmRequest) => req.task === 'demo_design' ? { rawJson: badSpec } : { rawJson: review() };
    const provider = new MockLlmProvider(responder);
    const svc = new DemoComposerService({ provider, uow: fakeUow(sink), writer: { async write() { return '/x'; } }, logger, config: baseConfig() });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('SPEC_INVALID');
    // Reviewer was never called — only the generator ran.
    expect(provider.calls).toHaveLength(1);
  });

  it('accepts a REVISE whose revisions are deterministically applicable (no new facts/claims/CTA change)', async () => {
    const sink: ComposerPersist[] = [];
    const responder = (req: LlmRequest, i: number) => req.task === 'demo_design'
      ? defaultMockComposerResponder(req, i)
      : { rawJson: review({ decision: 'REVISE', problems: ['tighten hero copy'] }) };
    const svc = new DemoComposerService({ provider: new MockLlmProvider(responder), uow: fakeUow(sink), writer: { async write() { return '/demos/lead-1'; } }, logger, config: baseConfig() });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('DEMO_COMPOSED');
  });

  it('rejects a REVISE that requires new facts, and rejects fabricationRisk / REJECT regardless of decision', async () => {
    const cases: Array<[ReviewShape, string]> = [
      [review({ decision: 'REVISE', revisionRequiresNewFacts: true }), 'revise-needs-new-facts'],
      [review({ decision: 'REVISE', revisionRequiresCtaChange: true }), 'revise-needs-cta-change'],
      [review({ decision: 'APPROVE', fabricationRisk: true }), 'approve-but-fabrication'],
      [review({ decision: 'REJECT' }), 'reject'],
    ];
    for (const [rev] of cases) {
      const sink: ComposerPersist[] = [];
      const responder = (req: LlmRequest, i: number) => req.task === 'demo_design' ? defaultMockComposerResponder(req, i) : { rawJson: rev };
      const svc = new DemoComposerService({ provider: new MockLlmProvider(responder), uow: fakeUow(sink), writer: { async write() { return '/x'; } }, logger, config: baseConfig() });
      const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
      expect(r.outcome).toBe('REVIEW_REJECTED');
    }
  });

  it('does NOT let evidenceConsistent=false or ctaHonest=false independently veto an APPROVE (code already guarantees them)', async () => {
    const sink: ComposerPersist[] = [];
    const responder = (req: LlmRequest, i: number) => req.task === 'demo_design'
      ? defaultMockComposerResponder(req, i)
      : { rawJson: review({ evidenceConsistent: false, ctaHonest: false }) };
    const svc = new DemoComposerService({ provider: new MockLlmProvider(responder), uow: fakeUow(sink), writer: { async write() { return '/demos/lead-1'; } }, logger, config: baseConfig() });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('DEMO_COMPOSED');
  });

  it('records a diagnostics entry on BOTH a composed and a rejected run', async () => {
    const records: Array<{ outcome: string; spec: unknown; review: unknown }> = [];
    const debug = { async record(rec: { outcome: string; spec: unknown; review: unknown }) { records.push(rec); } };
    // Composed run.
    const okSvc = new DemoComposerService({ provider: new MockLlmProvider(defaultMockComposerResponder), uow: fakeUow([]), writer: { async write() { return '/demos/lead-1'; } }, logger, config: baseConfig(), debug });
    await okSvc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    // Rejected run.
    const rejResponder = (req: LlmRequest, i: number) => req.task === 'demo_design' ? defaultMockComposerResponder(req, i) : { rawJson: review({ decision: 'REJECT' }) };
    const rejSvc = new DemoComposerService({ provider: new MockLlmProvider(rejResponder), uow: fakeUow([]), writer: { async write() { return '/x'; } }, logger, config: baseConfig(), debug });
    await rejSvc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-2');

    expect(records.map((r) => r.outcome).sort()).toEqual(['DEMO_COMPOSED', 'REVIEW_REJECTED']);
    // Both entries carry the generated spec + the reviewer verdict.
    for (const rec of records) { expect(rec.spec).not.toBeNull(); expect(rec.review).not.toBeNull(); }
  });

  it('blocks on the per-demo budget for a real provider when projected cost exceeds the cap', async () => {
    const sink: ComposerPersist[] = [];
    // A non-mock provider name forces the worst-case projection path in canCall.
    const stub: LlmProvider = {
      name: 'openai',
      async generate(req: LlmRequest): Promise<LlmResult> {
        return {
          status: 'ok', rawJson: req.task === 'demo_design' ? validSpec() : review(),
          refusal: null, incompleteReason: null, provider: 'openai', requestedModel: req.model, resolvedModel: req.model,
          requestId: 'r', responseId: 'r', usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, estimatedCostUsd: 0.01 }, latencyMs: 1, imageDetail: null,
        };
      },
    };
    const svc = new DemoComposerService({ provider: stub, uow: fakeUow(sink), writer: { async write() { return '/x'; } }, logger, config: baseConfig({ maxCostUsdPerDemo: 0.05 }) });
    const r = await svc.compose({ leadId: 'lead-1', facts: richFacts(), opportunityScore: 60, findings: [finding('F1')] }, 'run-1');
    expect(r.outcome).toBe('BUDGET_BLOCKED');
    expect(r.callsMade).toBe(0);
  });
});

describe('LocalComposerDebugStore', () => {
  const mkRec = (over: Partial<ComposerDebugRecord> = {}): ComposerDebugRecord => ({
    leadId: 'lead-1', runId: 'run-1', outcome: 'REVIEW_REJECTED', spec: { visualDirection: 'CLEAN_CLINICAL' }, review: { decision: 'REJECT' },
    violations: [], costUsd: 0.03, callsMade: 2, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(), ...over,
  });

  it('writes a retained record file with the spec + reviewer verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'composer-dbg-'));
    try {
      const store = new LocalComposerDebugStore(dir);
      await store.record(mkRec());
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
      const parsed = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as ComposerDebugRecord;
      expect(parsed.outcome).toBe('REVIEW_REJECTED');
      expect(parsed.spec).not.toBeNull();
      expect(parsed.review).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleanupExpired removes only expired records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'composer-dbg-'));
    try {
      const store = new LocalComposerDebugStore(dir);
      await store.record(mkRec({ leadId: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() }));
      await store.record(mkRec({ leadId: 'fresh', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      const removed = await store.cleanupExpired();
      expect(removed).toBe(1);
      expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
