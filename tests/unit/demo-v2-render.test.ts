import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import {
  COMPONENT_IDS, COMPONENT_SPECS, componentSpecsHash, requireComponent,
} from '../../src/domain/demo-v2/render/components.js';
import { REFERENCE_FAMILIES, compositionFor, tokensFor, VIEWPORTS, Z_INDEX } from '../../src/domain/demo-v2/render/design-system.js';
import { buildStylesheet } from '../../src/domain/demo-v2/render/stylesheet.js';
import { renderDemoV2, resolveComponentId, DEMO_V2_RENDERER_VERSION } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import {
  MOCK_REVIEW_FIXTURES, MockDemoV2VisualReviewProvider, assertNoAutomaticApproval,
  revisionPlanSchema, visualReviewSetHash,
} from '../../src/domain/demo-v2/render/visual-review.js';
import { reviewScreenshotSetHash } from '../../src/domain/demo-v2/render/review-package.js';
import { buildAcceptanceFixture, ACCEPTANCE_PLAN_SECTIONS } from '../../src/fixtures/demo-v2-render-fixture.js';
import { fictionalPng, imageSha256 } from '../../src/fixtures/demo-v2-images.js';

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

const render = async (family?: string) => {
  const { renderInput } = await buildAcceptanceFixture(manifests, { referenceFamily: family });
  return { result: renderDemoV2(renderInput), input: renderInput };
};

const checks = (result: Awaited<ReturnType<typeof render>>['result'], faqTopics: number) => runQualityChecks({
  documents: result.documents,
  primaryLanguage: result.primaryLanguage,
  supportedLanguages: result.supportedLanguages,
  bundledAssetPaths: result.files.map((file) => file.path),
  expectedAnchors: result.sectionAnchors,
  faqTopicCount: faqTopics,
});

describe('Demo V2 component registry', () => {
  it('declares every required component family with a complete contract', () => {
    const required = [
      'ConceptDisclosureBar', 'PremiumEditorialNavigation', 'MobileNavigation', 'LanguageSwitcher', 'SkipLink',
      'ArchitectureImageHero', 'EditorialSplitHero', 'CalmCareHero', 'LocationLedHero',
      'AppointmentActionDock', 'MobileAppointmentBar', 'CallEmergencyActions', 'ContactChoicePanel',
      'SpecialistTrustStrip', 'VerifiedHoursStrip', 'LocationProofStrip',
      'EditorialTreatmentIndex', 'GroupedTreatmentDiscovery', 'TreatmentSpotlight',
      'SpecialistPortraitRail', 'TeamEditorialGrid', 'DoctorFeature',
      'ArchitectureStory', 'InteriorGallery', 'LocationNarrative',
      'PatientJourneySteps', 'CalmCareStory', 'AnxiousPatientSection',
      'LocationHoursPanel', 'ContactPanel', 'DeterministicFaqConcierge',
      'FinalAppointmentCta', 'ContactFallback', 'PremiumClinicFooter',
    ];
    for (const id of required) {
      const spec = requireComponent(id);
      expect(spec.fallbackBehavior.length).toBeGreaterThan(0);
      expect(spec.responsive.length).toBeGreaterThan(0);
      expect(spec.accessibility.length).toBeGreaterThan(0);
      expect(spec.tokens.length).toBeGreaterThan(0);
      expect(spec.screenshotCases.length).toBeGreaterThan(0);
      expect(spec.supportedLanguages).toBe('ALL');
    }
    expect(COMPONENT_IDS).toEqual(expect.arrayContaining(required));
  });

  it('keeps the committed manifest in sync with the code-native specs', () => {
    expect(component.manifest.components.map((entry) => entry.id).sort())
      .toEqual([...COMPONENT_IDS].sort());
    for (const entry of component.manifest.components) {
      expect(entry.supportedDirections).toEqual(['LTR', 'RTL']);
    }
    expect(componentSpecsHash()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never allows a component to accept raw HTML', () => {
    const source = readFileSync('src/domain/demo-v2/render/render-html.ts', 'utf8');
    expect(source).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
    // every interpolated value goes through the escaper
    expect(source).toContain('const A = escapeHtml');
  });
});

describe('Demo V2 design system', () => {
  it('gives every reference family a distinct composition, not a recolour', () => {
    const signatures = REFERENCE_FAMILIES.map((family) => {
      const composition = compositionFor(family);
      return [composition.heroVariant, composition.treatmentVariant, composition.peopleVariant,
        composition.placeVariant, composition.heroLayout, composition.rhythm.join('-')].join('|');
    });
    expect(new Set(signatures).size).toBe(REFERENCE_FAMILIES.length);
    const accents = REFERENCE_FAMILIES.map((family) => tokensFor(family).colors.accent);
    expect(new Set(accents).size).toBeGreaterThan(3);
  });

  it('keeps the concierge below the mobile appointment bar', () => {
    expect(Number(Z_INDEX.conciergePanel)).toBeLessThan(Number(Z_INDEX.mobileBar));
  });

  it('emits reduced-motion and responsive rules for every family', () => {
    for (const family of REFERENCE_FAMILIES) {
      const css = buildStylesheet(family);
      expect(css).toContain('prefers-reduced-motion:reduce');
      expect(css).toContain('@media (max-width:1023.98px)');
      expect(css).toContain('overflow-x:hidden');
      expect(css).not.toMatch(/https?:\/\//);
    }
  });

  it('uses the required viewports', () => {
    expect(VIEWPORTS.DESKTOP).toEqual({ width: 1440, height: 1000 });
    expect(VIEWPORTS.TABLET).toEqual({ width: 1024, height: 1366 });
    expect(VIEWPORTS.MOBILE).toEqual({ width: 390, height: 844 });
  });
});

describe('Demo V2 deterministic renderer', () => {
  it('renders the acceptance fixture identically for identical inputs', async () => {
    const first = await render();
    const second = await render();
    expect(second.result.renderHash).toBe(first.result.renderHash);
    expect(second.result.documents[0]!.html).toBe(first.result.documents[0]!.html);
    expect(first.result.rendererVersion).toBe(DEMO_V2_RENDERER_VERSION);
  }, 30_000);

  it('renders all 14 planned sections in order with a self-contained bundle', async () => {
    const { result } = await render();
    expect(result.componentIds).toHaveLength(ACCEPTANCE_PLAN_SECTIONS.length);
    expect(result.files.some((file) => file.path === 'index.html')).toBe(true);
    expect(result.files.some((file) => file.path === 'en.html')).toBe(true);
    expect(result.files.some((file) => file.path.startsWith('assets/'))).toBe(true);
    for (const document of result.documents) {
      expect(document.html).toContain('Content-Security-Policy');
      expect(document.html).toContain('noindex');
      expect(document.html).toContain('dv2-disclosure');
      // no external resource loads
      expect(document.html).not.toMatch(/\bsrc="https?:\/\//);
      expect(document.html).not.toMatch(/<link[^>]+href="https?:\/\//);
    }
  });

  it('produces a structurally eligible render for every reference family', async () => {
    for (const family of REFERENCE_FAMILIES) {
      const { result, input } = await render(family);
      const quality = checks(result, input.faq.entries.length);
      expect(quality.blockers, `${family}: ${quality.blockers.map((b) => b.code).join(',')}`).toHaveLength(0);
      expect(quality.structurallyEligible).toBe(true);
    }
  }, 60_000);

  it('rejects an unsupported component family', () => {
    expect(() => resolveComponentId('marketing-carousel', 'premium-dental-editorial'))
      .toThrow('demo_v2_render_unsupported_component_family');
  });

  it('rejects unapproved assets, stale bindings, and tampered bytes', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    expect(() => renderDemoV2({
      ...renderInput,
      assets: renderInput.assets.map((binding) => ({ ...binding, reuseApproved: false })),
    })).toThrow('demo_v2_render_asset_not_reuse_approved');

    expect(() => renderDemoV2({
      ...renderInput,
      assets: renderInput.assets.map((binding) => ({
        ...binding, selection: { ...binding.selection, boundAssetRecordHash: 'f'.repeat(64) },
      })),
    })).toThrow('demo_v2_render_asset_binding_stale');

    expect(() => renderDemoV2({
      ...renderInput,
      assets: renderInput.assets.map((binding) => ({ ...binding, bytes: Buffer.from('tampered') })),
    })).toThrow('demo_v2_render_asset_content_hash_mismatch');
  });

  it('rejects a stale translation binding and refuses to render a partial English page', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    expect(() => renderDemoV2({
      ...renderInput,
      translation: { ...renderInput.translation!, sourceContentHash: 'a'.repeat(64) },
    })).toThrow('demo_v2_render_stale_translation_binding');

    // Unreviewed English must fall back to the complete primary language only.
    const unreviewed = renderDemoV2({ ...renderInput, translationReviewed: false });
    expect(unreviewed.supportedLanguages).toEqual(['de']);
    expect(unreviewed.documents).toHaveLength(1);
    // the switcher MARKUP must be absent (the inlined CSS/script always mention the selectors)
    expect(unreviewed.documents[0]!.html).not.toContain('<div class="dv2-lang"');
  });

  it('verifies every bundled asset hash and never hotlinks', async () => {
    const { result, input } = await render();
    for (const binding of input.assets) {
      const file = result.files.find((candidate) => candidate.path === `assets/${binding.asset.id}.png`)!;
      expect(imageSha256(file.bytes)).toBe(binding.asset.contentHash);
    }
    expect(result.usedAssetHashes.length).toBeGreaterThan(0);
  });

  it('applies focal points and intrinsic dimensions to every image', async () => {
    const { result } = await render();
    for (const document of result.documents) {
      for (const tag of document.html.match(/<img[^>]*>/g) ?? []) {
        expect(tag).toMatch(/width="\d+"/);
        expect(tag).toMatch(/height="\d+"/);
        expect(tag).toMatch(/alt="/);
        // focal positioning is applied via a hashed class + style rule, never an inline attribute
        expect(tag).not.toMatch(/style=/);
        const cls = /class="(dv2-fp-[^"]+)"/.exec(tag)?.[1];
        expect(cls, tag).toBeTruthy();
        expect(document.html).toMatch(new RegExp(`\\.${cls!.replace(/[-]/g, '\\$&')}\\{object-position:`));
      }
    }
  });

  it('generates deterministic fictional images', () => {
    const a = fictionalPng({ seed: 'x', width: 64, height: 48, hue: 100 });
    const b = fictionalPng({ seed: 'x', width: 64, height: 48, hue: 100 });
    expect(imageSha256(a)).toBe(imageSha256(b));
    expect(a.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

describe('Demo V2 multilingual behaviour', () => {
  it('renders German primary and complete English with correct lang/dir and a switcher', async () => {
    const { result } = await render();
    expect(result.primaryLanguage).toBe('de');
    expect(result.supportedLanguages).toEqual(['de', 'en']);
    const de = result.documents.find((doc) => doc.language === 'de')!.html;
    const en = result.documents.find((doc) => doc.language === 'en')!.html;
    expect(de).toContain('lang="de"');
    expect(de).toContain('dir="ltr"');
    expect(en).toContain('lang="en"');
    expect(de).toContain('dv2-lang');
    expect(en).toContain('dv2-lang');
    expect(de).toContain('Termin anfragen');
    expect(en).toContain('Request an appointment');
  });

  it('produces zero mixed-language output', async () => {
    const { result, input } = await render();
    const quality = checks(result, input.faq.entries.length);
    expect(quality.issues.filter((issue) => issue.code === 'mixed_language')).toHaveLength(0);
  });

  it('persists language locally without any network translation', async () => {
    const { result } = await render();
    const html = result.documents[0]!.html;
    expect(html).toContain('localStorage');
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|translate\.googleapis/);
  });
});

describe('Demo V2 FAQ concierge', () => {
  it('renders an accessible chatbot-style concierge bound to verified topics only', async () => {
    const { result, input } = await render();
    const html = result.documents[0]!.html;
    expect(input.faq.entries.length).toBeGreaterThan(3);
    expect(html).toContain('dv2-concierge__launcher');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('dv2-faq-data');
    // no free-form input, no data collection, no diagnosis
    expect(html).not.toMatch(/<input|<textarea|<form/);
    for (const entry of input.faq.entries) {
      expect(html).toContain(entry.topic);
      expect(entry.answer).not.toMatch(/diagnos|prescrib|we recommend/i);
    }
  });

  it('omits the launcher completely when no verified topic exists', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    const result = renderDemoV2({
      ...renderInput,
      faq: { ...renderInput.faq, entries: [], suggestedQuestionKeys: [] },
    });
    expect(result.documents[0]!.html).not.toContain('class="dv2-concierge__launcher"');
    expect(result.documents[0]!.html).not.toContain('<script type="application/json" id="dv2-faq-data">');
  });
});

describe('Demo V2 deterministic quality checks', () => {
  it('flags mixed language, missing noindex, external resources, and broken anchors', () => {
    const bad = `<!doctype html><html lang="en"><head><title>x</title>
<link href="https://cdn.example/x.css"><meta http-equiv="Content-Security-Policy" content="x"></head>
<body><div class="dv2-disclosure">d</div><a class="dv2-skip" href="#main"></a><main id="main">
<h1>Termin und die Praxis</h1><a href="#nowhere">x</a><section></section></main></body></html>`;
    const result = runQualityChecks({
      documents: [{ language: 'en', path: 'en.html', html: bad }],
      primaryLanguage: 'en', supportedLanguages: ['en', 'de'],
      bundledAssetPaths: [], expectedAnchors: [], faqTopicCount: 0,
    });
    const codes = result.blockers.map((issue) => issue.code);
    expect(codes).toContain('missing_noindex');
    expect(codes).toContain('external_request');
    expect(codes).toContain('broken_internal_navigation');
    expect(codes).toContain('mixed_language');
    expect(codes).toContain('language_switcher_missing');
    expect(result.structurallyEligible).toBe(false);
  });

  it('does not claim visual excellence', () => {
    const source = readFileSync('src/domain/demo-v2/render/quality-checks.ts', 'utf8');
    expect(source).toContain('structurally eligible');
  });
});

describe('Demo V2 visual-review and revision contracts', () => {
  it('supports every mock fixture and never permits a live reviewer', async () => {
    for (const fixture of MOCK_REVIEW_FIXTURES) {
      const provider = new MockDemoV2VisualReviewProvider(fixture);
      const result = await provider.review({
        screenshotRefs: ['final-de-desktop.png'], referenceFamily: 'premium-dental-editorial',
        renderHash: 'a'.repeat(64), screenshotSetHash: 'b'.repeat(64),
      });
      expect(result.provider).toBe('mock');
      expect(result.costUsd).toBe(0);
      expect(['APPROVE', 'REVISE', 'REJECT']).toContain(result.decision);
      assertNoAutomaticApproval(result, provider.name);
    }
    expect(() => assertNoAutomaticApproval(
      { provider: 'mock', costUsd: 0 } as never, 'openai',
    )).toThrow('demo_v2_live_visual_reviewer_not_permitted_in_milestone_3a');
  });

  it('rejects a revision operation carrying markup, script, or contact details', () => {
    const base = {
      schemaVersion: 'demo-v2-revision-1' as const,
      boundRenderHash: 'c'.repeat(64),
      applied: false as const,
    };
    expect(revisionPlanSchema.safeParse({
      ...base,
      operations: [{
        operation: 'SPACING_DENSITY', targetSectionAnchor: 'hero',
        parameters: { density: 'comfortable' }, justification: 'more air',
        boundRenderHash: 'c'.repeat(64),
      }],
    }).success).toBe(true);
    expect(revisionPlanSchema.safeParse({
      ...base,
      operations: [{
        operation: 'APPROVED_COPY_ALTERNATIVE', targetSectionAnchor: 'hero',
        parameters: { copy: '<b>new</b>' }, justification: 'x', boundRenderHash: 'c'.repeat(64),
      }],
    }).success).toBe(false);
  });

  it('hashes review and screenshot sets deterministically', async () => {
    const provider = new MockDemoV2VisualReviewProvider('strong-premium-dental');
    const request = {
      screenshotRefs: ['final-de-desktop.png'], referenceFamily: 'x',
      renderHash: 'a'.repeat(64), screenshotSetHash: 'b'.repeat(64),
    };
    const one = await provider.review(request);
    const two = await provider.review(request);
    expect(visualReviewSetHash([one])).toBe(visualReviewSetHash([two]));

    const shots = [{
      kind: 'FINAL' as const, language: 'de', viewport: 'DESKTOP' as const,
      path: 'a.png', width: 1440, height: 1000, fileHash: 'd'.repeat(64),
    }];
    expect(reviewScreenshotSetHash(shots)).toBe(reviewScreenshotSetHash([...shots]));
  });
});

describe('Demo V2 side-effect safety', () => {
  it('has no deployment, Gmail, email, scheduling, or paid-provider path in any Milestone 3A file', () => {
    const files = [
      'src/domain/demo-v2/render/components.ts',
      'src/domain/demo-v2/render/design-system.ts',
      'src/domain/demo-v2/render/stylesheet.ts',
      'src/domain/demo-v2/render/runtime.ts',
      'src/domain/demo-v2/render/render-html.ts',
      'src/domain/demo-v2/render/renderer.ts',
      'src/domain/demo-v2/render/quality-checks.ts',
      'src/domain/demo-v2/render/visual-review.ts',
      'src/domain/demo-v2/render/review-package.ts',
      'src/fixtures/demo-v2-render-fixture.ts',
      'src/fixtures/demo-v2-images.ts',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(files).not.toMatch(/integrations\/(?:netlify|gmail|send)|schedule-service|nodemailer|drafts\.(?:create|send)/i);
    // a documented FUTURE reviewer may be named in a comment; no client may be imported or built
    expect(files).not.toMatch(/from ['"]openai['"]|new OpenAI\(|integrations\/llm|apiKey/);
    expect(files).not.toMatch(/from ['"]node:(?:http|https|net|tls|dgram)['"]/);
    expect(files).not.toMatch(/axios|node-fetch|undici|globalThis\.fetch/);
  });

  it('cannot express an approval or deployment-eligible decision', async () => {
    // The reviewer verdict vocabulary deliberately excludes lifecycle approval states.
    const provider = new MockDemoV2VisualReviewProvider('strong-premium-dental');
    const result = await provider.review({
      screenshotRefs: ['x.png'], referenceFamily: 'x', renderHash: 'a'.repeat(64), screenshotSetHash: 'b'.repeat(64),
    });
    expect(['APPROVE', 'REVISE', 'REJECT']).toContain(result.decision);
    expect(result.decision).not.toBe('AUTO_REVIEW_PASSED');
    const renderer = readFileSync('src/domain/demo-v2/render/renderer.ts', 'utf8');
    expect(renderer).not.toMatch(/HUMAN_APPROVED|AUTO_REVIEW_PASSED|deploymentEligible:\s*true/);
    const reviewPackage = readFileSync('src/domain/demo-v2/render/review-package.ts', 'utf8');
    expect(reviewPackage).toContain('deploymentEligible: z.literal(false)');
  });

  it('keeps every fixture reference fictional', () => {
    const fixture = readFileSync('src/fixtures/demo-v2-render-fixture.ts', 'utf8');
    expect(fixture).not.toMatch(/ku64|KU64/);
    for (const url of fixture.match(/https?:\/\/[^\s'"`]+/g) ?? []) {
      expect(url).toContain('.example');
    }
  });

  it('exposes all 34 component specs', () => {
    expect(COMPONENT_SPECS).toHaveLength(34);
  });
});
