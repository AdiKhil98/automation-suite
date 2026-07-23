import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAssetUsable } from '../../src/domain/demo-v2/asset-catalog.js';
import {
  discoverFirstPartyAssets,
  MockDemoV2AssetFetchProvider,
} from '../../src/domain/demo-v2/asset-discovery.js';
import { assertTranslationPreservesClaims } from '../../src/domain/demo-v2/content-orchestrator.js';
import { DemoV2ModelBudget, selectReferenceFamily } from '../../src/domain/demo-v2/creative-orchestrator.js';
import { buildFaqPackage, type DemoV2FaqTopic } from '../../src/domain/demo-v2/faq-package.js';
import { buildClinicIntelligence, type DemoV2RawSource } from '../../src/domain/demo-v2/intelligence-builder.js';
import { type ClinicIntelligenceData } from '../../src/domain/demo-v2/orchestration-types.js';
import { creativeBriefDataSchema, experiencePlanDataSchema } from '../../src/domain/demo-v2/orchestration-types.js';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { orchestrateDemoV2Fixture } from '../../src/domain/demo-v2/orchestration-service.js';
import { chooseCompleteLanguagePackage } from '../../src/domain/demo-v2/translation-package.js';
import {
  DEMO_V2_FIXTURE_NAMES,
  demoV2Fixture,
  demoV2NegativeFixture,
} from '../../src/fixtures/demo-v2-orchestration.js';

const component = parseComponentRegistry(JSON.parse(readFileSync(
  'design-library/component-registry.v1.json', 'utf8',
)) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync(
  'design-library/reference-library.v1.json', 'utf8',
)) as unknown);
const manifests = {
  componentVersion: component.manifest.version,
  componentHash: component.hash,
  referenceVersion: reference.manifest.version,
  referenceHash: reference.hash,
};

describe('Demo V2 Milestone 2 orchestration', () => {
  it.each(DEMO_V2_FIXTURE_NAMES)('builds the complete mock-only foundation for %s', async (name) => {
    const output = await orchestrateDemoV2Fixture(demoV2Fixture(name, manifests));
    const expectedLanguage = {
      'premium-german-dental': 'de',
      'english-specialist-clinic': 'en',
      'french-clinic': 'fr',
      'hebrew-rtl-clinic': 'he',
      'arabic-rtl-clinic': 'ar',
    }[name];
    expect(output.intelligence.package.primaryLanguage).toBe(expectedLanguage);
    expect(output.intelligence.package.primaryDirection).toBe(
      expectedLanguage === 'he' || expectedLanguage === 'ar' ? 'RTL' : 'LTR',
    );
    expect(output.content.package.status).toBe('READY');
    expect(output.report.providerState).toBe('MOCK_ONLY');
    expect(output.report.totalCostUsd).toBe(0);
    expect(output.report.lifecycle.at(-1)).toBe('HUMAN_REVIEW_REQUIRED');
    expect(output.report.lifecycle).not.toContain('RENDERING');
    expect(output.report.lifecycle).not.toContain('HUMAN_APPROVED');
    expect(output.experiencePlan.componentRegistryHash).toBe(component.hash);
    expect(output.experiencePlan.referenceLibraryHash).toBe(reference.hash);
    if (expectedLanguage === 'en') {
      expect(output.translation).toBeNull();
      expect(output.report.modelCalls).toHaveLength(1);
    } else {
      expect(output.translation?.language).toBe('en');
      expect(output.translation?.status).toBe('READY_FOR_REVIEW');
      expect(output.translation?.reviewStatus).toBe('NOT_REVIEWED');
      expect(output.experiencePlan.supportedLanguages).toContain('en');
      expect((output.experiencePlan.plan as { visibleEnglishSwitcher: boolean }).visibleEnglishSwitcher).toBe(true);
      expect(output.report.modelCalls).toHaveLength(2);
    }
  });

  it('is deterministic, version-fingerprinted, and binds every personalized content item', async () => {
    const fixture = demoV2Fixture('premium-german-dental', manifests);
    const first = await orchestrateDemoV2Fixture(fixture);
    const second = await orchestrateDemoV2Fixture(fixture);
    expect(second.report.fingerprints).toEqual(first.report.fingerprints);
    expect(second.assets.map((asset) => asset.recordHash)).toEqual(first.assets.map((asset) => asset.recordHash));
    const personalized = first.content.package.items.filter((item) =>
      item.claimClass === 'VERBATIM_FACT' || item.claimClass === 'EVIDENCE_BOUND_DERIVATION');
    expect(personalized.length).toBeGreaterThan(0);
    for (const item of personalized) {
      expect(first.content.bindings.some((binding) =>
        binding.contentItemId === item.id && binding.sourceIds.length > 0)).toBe(true);
    }
  });

  it('invalidates fingerprints and excludes stale evidence when exact inputs change', async () => {
    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    const original = await orchestrateDemoV2Fixture(fixture);
    const changed = structuredClone(fixture);
    changed.sources.find((source) => source.key === 'fact.services')!.value = 'Oral surgery';
    const revised = await orchestrateDemoV2Fixture(changed);
    expect(revised.report.fingerprints.intelligence).not.toBe(original.report.fingerprints.intelligence);

    const stale = structuredClone(fixture);
    stale.sources.find((source) => source.key === 'fact.opening_hours')!.capturedAt = '2020-01-01T00:00:00.000Z';
    const staleOutput = await orchestrateDemoV2Fixture(stale);
    expect(staleOutput.report.factsExcluded).toContain(
      stale.sources.find((source) => source.key === 'fact.opening_hours')!.id,
    );
    expect(staleOutput.report.missingInformation).toContain('verified opening hours');
  });

  it('blocks insufficient identity and contradictory opening hours', async () => {
    await expect(orchestrateDemoV2Fixture(demoV2NegativeFixture('insufficient', manifests)))
      .rejects.toThrow('demo_v2_intelligence_blocked');
    await expect(orchestrateDemoV2Fixture(demoV2NegativeFixture('contradictory-hours', manifests)))
      .rejects.toThrow('demo_v2_intelligence_blocked');
  });

  it('keeps unsupported staff roles out of content and lists unsupported claims', async () => {
    const output = await orchestrateDemoV2Fixture(demoV2NegativeFixture('unverified-staff-role', manifests));
    expect(output.content.package.items.some((item) => item.contentKey.startsWith('team.'))).toBe(false);
    expect(output.report.unsupportedClaimsBlocked).toContain('awards without verified evidence');
  });

  it('rejects third-party imagery, tiny photography, and deduplicates identical content hashes', async () => {
    const thirdParty = await orchestrateDemoV2Fixture(demoV2NegativeFixture('third-party-images', manifests));
    expect(thirdParty.assets).toHaveLength(0);
    expect(thirdParty.selections).toHaveLength(0);

    const tiny = await orchestrateDemoV2Fixture(demoV2NegativeFixture('no-usable-photography', manifests));
    expect(tiny.assets.every((asset) => asset.quality === 'UNSUITABLE')).toBe(true);
    expect(tiny.selections).toHaveLength(0);

    const duplicate = demoV2Fixture('english-specialist-clinic', manifests);
    const results = Object.values(duplicate.assetFetchResults);
    results[1]!.contentHash = results[0]!.contentHash;
    const deduped = await orchestrateDemoV2Fixture(duplicate);
    expect(deduped.assets).toHaveLength(1);
  });

  it('changes asset and selection bindings when bytes change; availability never grants reuse', async () => {
    const fixture = demoV2Fixture('premium-german-dental', manifests);
    const first = await orchestrateDemoV2Fixture(fixture);
    const changed = structuredClone(fixture);
    const changedUrl = Object.keys(changed.assetFetchResults)[0]!;
    changed.assetFetchResults[changedUrl]!.contentHash = 'a'.repeat(64);
    const second = await orchestrateDemoV2Fixture(changed);
    expect(second.assets.find((asset) => asset.directUrl === changedUrl)!.recordHash)
      .not.toBe(first.assets.find((asset) => asset.directUrl === changedUrl)!.recordHash);
    const selection = first.selections[0]!;
    expect(selection.status).toBe('REUSE_REVIEW_REQUIRED');
    expect(isAssetUsable({
      id: selection.id,
      assetId: selection.assetId,
      status: 'SELECTED',
      boundAssetRecordHash: selection.boundAssetRecordHash,
      selectionHash: selection.selectionHash,
    }, undefined)).toBe(false);
  });

  it('allows reviewed CDN assets and rejects unsafe DNS and redirect targets', async () => {
    const page = {
      id: 'safe-page',
      url: 'https://clinic.example/',
      captureEvidenceId: null,
      html: '<img src="https://media.clinic-cdn.example/interior.jpg" alt="clinic interior">',
    };
    const result = {
      finalUrl: 'https://media.clinic-cdn.example/interior.jpg',
      redirectUrls: [] as string[],
      mimeType: 'image/jpeg',
      bytes: 200_000,
      width: 1200,
      height: 800,
      contentHash: 'c'.repeat(64),
    };
    const safeResolver = async () => ['93.184.216.34'];
    const approved = await discoverFirstPartyAssets({
      pages: [page],
      officialWebsiteUrl: page.url,
      approvedCdnHosts: ['media.clinic-cdn.example'],
      provider: new MockDemoV2AssetFetchProvider(new Map([[result.finalUrl, result]])),
      resolver: safeResolver,
      now: new Date('2026-07-23T10:00:00.000Z'),
    });
    expect(approved[0]?.ownership).toBe('APPROVED_FIRST_PARTY_CDN');

    const redirected = await discoverFirstPartyAssets({
      pages: [page],
      officialWebsiteUrl: page.url,
      approvedCdnHosts: ['media.clinic-cdn.example'],
      provider: new MockDemoV2AssetFetchProvider(new Map([[
        result.finalUrl,
        { ...result, redirectUrls: ['http://127.0.0.1/private.jpg'] },
      ]])),
      resolver: safeResolver,
      now: new Date('2026-07-23T10:00:00.000Z'),
    });
    expect(redirected).toHaveLength(0);

    await expect(discoverFirstPartyAssets({
      pages: [page],
      officialWebsiteUrl: page.url,
      approvedCdnHosts: ['media.clinic-cdn.example'],
      provider: new MockDemoV2AssetFetchProvider(new Map([[result.finalUrl, result]])),
      resolver: async () => ['10.0.0.1'],
      now: new Date('2026-07-23T10:00:00.000Z'),
    })).rejects.toThrow();
  });

  it('prepares complete English but falls back to primary until exact human approval', async () => {
    const output = await orchestrateDemoV2Fixture(demoV2Fixture('french-clinic', manifests));
    expect(output.translation).not.toBeNull();
    expect(chooseCompleteLanguagePackage(output.content.package, 'en', output.translation ?? undefined))
      .toEqual({ language: 'fr', source: 'PRIMARY' });
    const partial = { ...output.translation!, records: output.translation!.records.slice(1) };
    expect(chooseCompleteLanguagePackage(output.content.package, 'en', partial))
      .toEqual({ language: 'fr', source: 'PRIMARY' });
    const stale = { ...output.translation!, sourceContentHash: 'b'.repeat(64) };
    expect(chooseCompleteLanguagePackage(output.content.package, 'en', stale))
      .toEqual({ language: 'fr', source: 'PRIMARY' });
  });

  it('blocks translated service-set drift', async () => {
    const output = await orchestrateDemoV2Fixture(demoV2Fixture('french-clinic', manifests));
    const service = output.content.package.items.find((item) => item.contentKind === 'SERVICE_NAME')!;
    const changedServices = structuredClone(output.translation!);
    changedServices.records.find((record) => record.sourceContentItemId === service.id)!.translatedText
      = 'Implant dentistry|Preventive care|Invented service';
    expect(() => assertTranslationPreservesClaims(output.content.package, changedServices))
      .toThrow('demo_v2_translation_changed_service_set');
  });

  it('preserves long German and French values as words instead of concatenating them', async () => {
    for (const name of ['premium-german-dental', 'french-clinic'] as const) {
      const fixture = demoV2Fixture(name, manifests);
      const services = fixture.sources.find((source) => source.key === 'fact.services')!;
      services.value = `${services.value}|Sehr lange verifizierte Behandlungsbezeichnung mit mehreren Wörtern`;
      const output = await orchestrateDemoV2Fixture(fixture);
      const item = output.content.package.items.find((candidate) => candidate.contentKind === 'SERVICE_NAME')!;
      expect(item.textValue).toContain(' ');
      expect(item.textValue).not.toMatch(/mehrerenWörtern/);
    }
  });

  it('rejects generic creative direction and invalid plans', async () => {
    const output = await orchestrateDemoV2Fixture(demoV2Fixture('french-clinic', manifests));
    const brief = output.creativeBrief.brief as Record<string, unknown>;
    expect(creativeBriefDataSchema.safeParse({ ...brief, artDirection: 'A clean modern website' }).success).toBe(false);
    const plan = output.experiencePlan.plan as Record<string, unknown>;
    expect(experiencePlanDataSchema.safeParse({ ...plan, visibleEnglishSwitcher: false }).success).toBe(false);
    expect(experiencePlanDataSchema.safeParse({ ...plan, mobileAppointmentPersistent: false }).success).toBe(false);
    const sections = (plan.sections as Array<Record<string, unknown>>).map((section) => ({
      ...section, componentFamily: 'generic-card',
    }));
    expect(experiencePlanDataSchema.safeParse({ ...plan, sections }).success).toBe(false);
  });

  // The configured USD ceiling is a forward contract only: every mock call records exactly $0, so
  // no zero-cost provider can ever breach it. It becomes enforceable when a paid provider exists.
  it('enforces one call per purpose and exact-fingerprint caching', async () => {
    const budget = new DemoV2ModelBudget(3);
    let executions = 0;
    const run = () => budget.run({
      purpose: 'TRANSLATION' as const,
      fingerprint: 'a'.repeat(64),
      model: 'gpt-5.6-terra',
      effort: 'medium' as const,
      execute: async () => { executions += 1; return { ok: true }; },
    });
    await run();
    await run();
    expect(executions).toBe(1);
    expect(budget.records.map((record) => record.cached)).toEqual([false, true]);
    await expect(budget.run({
      purpose: 'TRANSLATION',
      fingerprint: 'b'.repeat(64),
      model: 'gpt-5.6-terra',
      effort: 'medium',
      execute: async () => ({ ok: true }),
    })).rejects.toThrow('demo_v2_model_call_budget_exceeded');
  });

  it('contains no render, deployment, Gmail, scheduling, sending, or network side effect in ANY Milestone 2 file', () => {
    const sources = MILESTONE_2_FILES.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(sources).not.toMatch(/integrations\/(?:netlify|gmail|send)|schedule-service|demo-writer|playwright/i);
    expect(sources).not.toMatch(/from ['"]node:(?:http|https|net|dgram|tls)['"]/);
    expect(sources).not.toMatch(/axios|node-fetch|undici|superagent/i);
    expect(sources).not.toMatch(/globalThis\.fetch|window\.fetch|XMLHttpRequest/);
    expect(sources).not.toMatch(/drafts\.(?:create|send)|sendMail|nodemailer|smtp/i);
    expect(sources).not.toMatch(/\bopenai\b/i);
    // Only mock providers may exist in this milestone.
    expect(sources).not.toMatch(/class\s+\w*(?:Http|Live)\w*Provider/);
    expect(sources).toMatch(/MockDemoV2CreativeProvider/);
  });
});

/** Every file that makes up Milestone 2, including the CLI, fixtures, and persistence. */
const MILESTONE_2_FILES = [
  'src/domain/demo-v2/orchestration-service.ts',
  'src/domain/demo-v2/orchestration-types.ts',
  'src/domain/demo-v2/intelligence-builder.ts',
  'src/domain/demo-v2/content-orchestrator.ts',
  'src/domain/demo-v2/faq-package.ts',
  'src/domain/demo-v2/asset-discovery.ts',
  'src/domain/demo-v2/creative-orchestrator.ts',
  'src/cli/commands/demo-v2-orchestrate-fixture.ts',
  'src/fixtures/demo-v2-orchestration.ts',
  'src/persistence/repositories/demo-v2-orchestration.repo.ts',
];

describe('Demo V2 reference-family consistency', () => {
  it('uses ONE family across selections, brief, plan, and report for every fixture', async () => {
    for (const name of DEMO_V2_FIXTURE_NAMES) {
      const output = await orchestrateDemoV2Fixture(demoV2Fixture(name, manifests));
      const family = output.report.referenceFamily;
      const brief = output.creativeBrief.brief as { selectedReferenceFamily: string };
      const plan = output.experiencePlan.plan as { selectedReferenceFamily: string };
      expect(brief.selectedReferenceFamily).toBe(family);
      expect(plan.selectedReferenceFamily).toBe(family);
      expect(family).toBe(selectReferenceFamily(output.intelligence.data, output.assets));
      for (const selection of output.selections) {
        expect(selection.justification).toContain(family);
      }
    }
  });

  it('reaches luxury-cosmetic-dental and binds its selections to that same family', async () => {
    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    fixture.sources.find((source) => source.key === 'claim.positioning.primary')!.value =
      'Cosmetic dentistry presented with a verified clinic interior.';
    const output = await orchestrateDemoV2Fixture(fixture);
    expect(output.report.referenceFamily).toBe('luxury-cosmetic-dental');
    expect((output.creativeBrief.brief as { selectedReferenceFamily: string }).selectedReferenceFamily)
      .toBe('luxury-cosmetic-dental');
    expect(output.selections.length).toBeGreaterThan(0);
    for (const selection of output.selections) {
      expect(selection.justification).toContain('luxury-cosmetic-dental');
    }
  });

  it('scopes a figcaption to its own figure so a sibling caption cannot mis-classify an image', async () => {
    const output = await orchestrateDemoV2Fixture(demoV2Fixture('english-specialist-clinic', manifests));
    const interior = output.assets.find((asset) => asset.directUrl.includes('interior-hero'))!;
    const doctor = output.assets.find((asset) => asset.directUrl.includes('doctor-team'))!;
    // The interior image sits beside a <figure> captioned "Verified clinic team"; that caption
    // belongs to the doctor image only.
    expect(interior.nearbyCaption).toBeNull();
    expect(interior.category).toBe('CLINIC_INTERIOR');
    expect(doctor.nearbyCaption).toBe('Verified clinic team');
    expect(doctor.category).toBe('DOCTOR');
  });

  it('ignores irrelevant words in unrelated raw evidence when choosing the family', async () => {
    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    const baseline = (await orchestrateDemoV2Fixture(fixture)).report.referenceFamily;
    const noisy = structuredClone(fixture);
    // "family"/"children" appear only in an address, which is NOT design-direction evidence.
    noisy.sources.find((source) => source.key === 'fact.formatted_address')!.value =
      '12 Family Children Court, United Kingdom';
    const noisyFamily = (await orchestrateDemoV2Fixture(noisy)).report.referenceFamily;
    expect(noisyFamily).toBe(baseline);
    expect(noisyFamily).not.toBe('warm-family-dental');
  });

  it('never lets identifiers or keys decide the family — only evidence values', async () => {
    // Every source id in this fixture is prefixed "premium-german-dental-"; the word "premium"
    // must not pull the composition toward luxury-cosmetic-dental.
    const output = await orchestrateDemoV2Fixture(demoV2Fixture('premium-german-dental', manifests));
    expect(output.intelligence.data.positioning[0]?.sourceIds[0]).toContain('premium');
    expect(output.report.referenceFamily).not.toBe('luxury-cosmetic-dental');
    expect(output.report.referenceFamily).toBe('advanced-specialist-clinic');
  });

  it('produces zero selections when a newer version has no usable assets', async () => {
    const fixture = demoV2Fixture('english-specialist-clinic', manifests);
    const first = await orchestrateDemoV2Fixture(fixture);
    expect(first.selections.length).toBeGreaterThan(0);
    const emptied = structuredClone(fixture);
    emptied.version = 2;
    emptied.pages = [];
    emptied.assetFetchResults = {};
    const second = await orchestrateDemoV2Fixture(emptied);
    expect(second.selections).toHaveLength(0);
    expect(second.assets).toHaveLength(0);
  });
});

describe('deterministic FAQ concierge', () => {
  const CAPTURED = '2026-07-20T10:00:00.000Z';
  const raw = (key: string, value: string, accepted = true): DemoV2RawSource => ({
    id: `faq-src-${key}`,
    kind: key.startsWith('fact.') ? 'LEAD_FACT' : 'CAPTURE_EVIDENCE',
    role: 'OTHER',
    key,
    value,
    capturedAt: new Date(CAPTURED),
    direct: true,
    accepted,
  });
  const intelligenceFrom = (sources: DemoV2RawSource[]): ClinicIntelligenceData =>
    buildClinicIntelligence({
      id: 'faq-intel', artifactId: 'faq-artifact', version: 1, sources,
      now: new Date('2026-07-23T10:00:00.000Z'),
    }).data;
  const topicsOf = (sources: DemoV2RawSource[]): DemoV2FaqTopic[] =>
    buildFaqPackage({ intelligence: intelligenceFrom(sources), language: 'en' }).entries.map((entry) => entry.topic);

  const IDENTITY = [
    raw('fact.business_name', 'Northbridge Specialist Clinic'),
    raw('fact.official_website_url', 'https://specialist-en.example'),
  ];

  it('builds many evidence-bound topics, each carrying source ids, hashes, and an escalation target', () => {
    const pkg = buildFaqPackage({
      intelligence: intelligenceFrom([
        ...IDENTITY,
        raw('fact.booking_url', 'https://specialist-en.example/appointment'),
        raw('fact.formatted_address', '1 Example Street, United Kingdom'),
        raw('fact.opening_hours', 'Monday-Friday 08:00-17:00'),
        raw('fact.services', 'Implant dentistry|Oral surgery'),
        raw('fact.phone', '+49 30 555 0100'),
        raw('fact.contact_email', 'reception@specialist-en.example'),
        raw('fact.whatsapp_url', 'https://specialist-en.example/whatsapp'),
        raw('claim.emergency_contact', 'Urgent cases use the verified urgent line.'),
        raw('claim.concern.anxiety', 'Patients report anxiety before appointments.'),
        raw('claim.audience.family', 'The clinic describes care for children and families.'),
      ]),
      language: 'en',
    });
    const topics = pkg.entries.map((entry) => entry.topic);
    expect(topics).toEqual(expect.arrayContaining([
      'booking', 'locations', 'opening_hours', 'urgent_contact', 'first_visit',
      'treatment_discovery', 'anxious_patient', 'children_family', 'escalation',
    ]));
    for (const entry of pkg.entries) {
      expect(entry.supportingSourceIds.length).toBeGreaterThan(0);
      expect(entry.supportingSourceHashes).toHaveLength(entry.supportingSourceIds.length);
      for (const hash of entry.supportingSourceHashes) expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.entryHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(pkg.entries.find((entry) => entry.topic === 'escalation')?.escalationTarget).toBe('WHATSAPP');
    expect(pkg.entries.find((entry) => entry.topic === 'urgent_contact')?.escalationTarget).toBe('PHONE');
    expect(pkg.entries.find((entry) => entry.topic === 'booking')?.escalationTarget).toBe('APPOINTMENT');
    expect(pkg.suggestedQuestionKeys).toEqual(pkg.entries.map((entry) => entry.questionKey));
  });

  it('supports exactly one topic when only one evidence key exists', () => {
    expect(topicsOf([...IDENTITY, raw('fact.services', 'Implant dentistry')])).toEqual(['treatment_discovery']);
  });

  it('produces no entries at all when nothing supports a FAQ topic', () => {
    const pkg = buildFaqPackage({ intelligence: intelligenceFrom(IDENTITY), language: 'en' });
    expect(pkg.entries).toHaveLength(0);
    expect(pkg.suggestedQuestionKeys).toHaveLength(0);
    expect(pkg.omittedTopics).toHaveLength(10);
  });

  it('omits anxious-patient and urgent-contact topics when those claims are not accepted', () => {
    const topics = topicsOf([
      ...IDENTITY,
      raw('fact.phone', '+49 30 555 0100'),
      raw('claim.emergency_contact', 'Unverified urgent claim.', false),
      raw('claim.concern.anxiety', 'Unverified anxiety claim.', false),
    ]);
    expect(topics).not.toContain('urgent_contact');
    expect(topics).not.toContain('anxious_patient');
    expect(topics).toContain('escalation');
  });

  it('offers the supported-languages topic only when a second language is really supported', () => {
    const single = topicsOf([...IDENTITY, raw('capture.lang', 'de')]);
    expect(single).not.toContain('supported_languages');
    const multi = topicsOf([
      ...IDENTITY,
      raw('capture.lang', 'de'),
      raw('capture.text', 'The clinic explains the appointment and contact options.'),
    ]);
    expect(multi).toContain('supported_languages');
  });

  it('never emits diagnosis or treatment-recommendation language in any language', () => {
    for (const language of ['de', 'en', 'fr', 'he', 'ar'] as const) {
      const pkg = buildFaqPackage({
        intelligence: intelligenceFrom([...IDENTITY, raw('fact.booking_url', 'https://specialist-en.example/appointment')]),
        language,
      });
      expect(pkg.entries.length).toBeGreaterThan(0);
      for (const entry of pkg.entries) {
        expect(entry.answer).not.toMatch(/diagnos|prescrib|we recommend|treatment plan/i);
      }
    }
  });

  it('reaches the orchestrator, prepares English FAQ records, and preserves facts and escalation targets', async () => {
    const rich = await orchestrateDemoV2Fixture(demoV2NegativeFixture('faq-rich', manifests));
    expect(rich.report.faqTopics).toEqual(expect.arrayContaining(['booking', 'urgent_contact', 'anxious_patient', 'children_family']));
    expect(rich.report.faqOmittedTopics).toContain('supported_languages');

    const german = await orchestrateDemoV2Fixture(demoV2Fixture('premium-german-dental', manifests));
    const answer = german.content.package.items.find((item) => item.contentKey === 'faq.booking.answer')!;
    const record = german.translation!.records.find((item) => item.sourceContentItemId === answer.id)!;
    expect(record.status).toBe('TRANSLATED');
    expect(record.translatedText).toBe('Use the verified appointment option shown on this page.');
    expect(record.translatedText).not.toBe(answer.textValue);

    // The machine-readable escalation payload is never translated and never mutated.
    const structured = german.content.package.items.find((item) => item.contentKey === 'faq.suggested_questions')!;
    expect(structured.translatable).toBe(false);
    expect(german.translation!.records.some((item) => item.sourceContentItemId === structured.id)).toBe(false);
    expect((structured.structuredValue as { escalationTargets: Record<string, string> }).escalationTargets.booking)
      .toBe('APPOINTMENT');

    // A verified fact still passes through untouched.
    const hours = german.content.package.items.find((item) => item.contentKey === 'hours.value')!;
    const hoursRecord = german.translation!.records.find((item) => item.sourceContentItemId === hours.id)!;
    expect(hoursRecord.translatedText).toBe(hours.textValue);
    expect(() => assertTranslationPreservesClaims(german.content.package, german.translation!)).not.toThrow();
  });
});
