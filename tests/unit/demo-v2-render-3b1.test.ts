import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { REFERENCE_FAMILIES } from '../../src/domain/demo-v2/render/design-system.js';
import { typographyFor, buildTypographyCss, typographyHash, DEMO_V2_TYPOGRAPHY_VERSION } from '../../src/domain/demo-v2/render/typography.js';
import { runQualityChecks, DEMO_V2_MAX_FAQ_PREVIEW } from '../../src/domain/demo-v2/render/quality-checks.js';
import { pickFaqPreview, FAQ_PREVIEW_MAX } from '../../src/domain/demo-v2/render/render-html.js';
import { fictionalPng, imageSha256 } from '../../src/fixtures/demo-v2-images.js';
import { buildAcceptanceFixture } from '../../src/fixtures/demo-v2-render-fixture.js';
import { buildLanguageAcceptanceFixture, type AcceptanceLanguage } from '../../src/fixtures/demo-v2-multilang-fixture.js';

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

const checks = (res: Awaited<ReturnType<typeof buildAcceptanceFixture>>['renderInput'] extends never ? never : ReturnType<typeof renderDemoV2>, faqTopics: number) =>
  runQualityChecks({
    documents: res.documents, primaryLanguage: res.primaryLanguage, supportedLanguages: res.supportedLanguages,
    bundledAssetPaths: res.files.map((file) => file.path), expectedAnchors: res.sectionAnchors, faqTopicCount: faqTopics,
  });

describe('3B1 typography system', () => {
  it('gives every reference family a distinct, versioned pairing (not one universal font)', () => {
    const pairings = REFERENCE_FAMILIES.map((family) => {
      const t = typographyFor(family);
      return `${t.displayFont}|${t.bodyFont}`;
    });
    expect(new Set(pairings).size).toBeGreaterThanOrEqual(4);
    // display and body differ for the editorial/luxury families (serif display + sans body)
    expect(typographyFor('premium-dental-editorial').displayFont)
      .not.toBe(typographyFor('premium-dental-editorial').bodyFont);
    expect(typographyHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(DEMO_V2_TYPOGRAPHY_VERSION).toContain('typography');
  });

  it('uses no external font request and applies German hyphenation + French manual wrapping', () => {
    for (const family of REFERENCE_FAMILIES) {
      const de = buildTypographyCss(family, 'de');
      const fr = buildTypographyCss(family, 'fr');
      expect(de).not.toMatch(/https?:\/\/|@import|url\(/);
      expect(de).toContain('hyphens:auto');
      expect(fr).toContain('hyphens:manual');
      // no destructive universal breaking
      expect(de).not.toMatch(/overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-all/);
    }
  });

  it('swaps in RTL faces for Hebrew and Arabic', () => {
    expect(buildTypographyCss('premium-dental-editorial', 'he')).toMatch(/Narkisim|Arial Hebrew|Frank Ruehl/);
    expect(buildTypographyCss('premium-dental-editorial', 'ar')).toMatch(/Geeza Pro|Damascus|Arabic Typesetting/);
  });

  it('reads at ~16-18px body (rem-based clamp, never tiny fixed px)', () => {
    for (const family of REFERENCE_FAMILIES) {
      const t = typographyFor(family);
      expect(t.scale.body).toMatch(/rem/);
      expect(t.scale.body).not.toMatch(/0\.[0-8]\d*rem\)?$/);
    }
  });
});

describe('3B1 imagery', () => {
  it('generates deterministic structured images with real tonal range per style', () => {
    const a = fictionalPng({ seed: 's', width: 400, height: 260, hue: 170, style: 'interior' });
    const b = fictionalPng({ seed: 's', width: 400, height: 260, hue: 170, style: 'interior' });
    expect(imageSha256(a)).toBe(imageSha256(b));
    // different styles from the same seed differ (structure, not just hue)
    const portrait = fictionalPng({ seed: 's', width: 400, height: 260, hue: 170, style: 'portrait' });
    expect(imageSha256(portrait)).not.toBe(imageSha256(a));
  });

  it('places approved imagery in hero, story, team, and location sections', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    const result = renderDemoV2(renderInput);
    const html = result.documents[0]!.html;
    expect((html.match(/<img /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(result.usedAssetHashes.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('reserves a portrait for the team section (never starved by hero or clinic story)', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    const html = renderDemoV2(renderInput).documents[0]!.html;
    const teamSection = /data-dv2-component="(?:SpecialistPortraitRail|TeamEditorialGrid|DoctorFeature)"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(teamSection).toMatch(/<img /);
    expect(teamSection).toMatch(/dv2-person__name/);
  }, 30_000);
});

describe('3B1 FAQ preview reduction', () => {
  it('caps the inline preview and keeps every verified topic in the concierge', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    const result = renderDemoV2(renderInput);
    const html = result.documents[0]!.html;
    const previewCount = (html.match(/class="dv2-faq__item"/g) ?? []).length;
    expect(previewCount).toBeLessThanOrEqual(FAQ_PREVIEW_MAX);
    // all topics remain available as concierge suggestions
    for (const entry of renderInput.faq.entries) {
      expect(html).toContain(`data-dv2-topic="${entry.topic}"`);
    }
    expect(renderInput.faq.entries.length).toBeGreaterThan(FAQ_PREVIEW_MAX);
  });

  it('prioritises booking/first-visit/hours/urgent in the preview', () => {
    const entry = (topic: string) => ({ topic, question: `q-${topic}`, answer: `a-${topic}`, escalationTarget: 'NONE' });
    const preview = pickFaqPreview([entry('locations'), entry('urgent_contact'), entry('booking'), entry('supported_languages'), entry('first_visit')]);
    expect(preview).toHaveLength(4);
    expect(preview.map((e) => e.topic).slice(0, 3)).toEqual(['booking', 'first_visit', 'urgent_contact']);
  });
});

describe('3B1 multilingual acceptance (FR/HE/AR)', () => {
  const cases: { language: AcceptanceLanguage; dir: 'ltr' | 'rtl' }[] = [
    { language: 'fr', dir: 'ltr' }, { language: 'he', dir: 'rtl' }, { language: 'ar', dir: 'rtl' },
  ];
  it.each(cases)('renders $language with correct dir, English secondary, and zero blockers', async ({ language, dir }) => {
    const { renderInput } = await buildLanguageAcceptanceFixture(language, manifests);
    const result = renderDemoV2(renderInput);
    expect(result.primaryLanguage).toBe(language);
    expect(result.supportedLanguages).toEqual([language, 'en']);
    const primary = result.documents.find((doc) => doc.language === language)!.html;
    expect(primary).toContain(`lang="${language}"`);
    expect(primary).toContain(`dir="${dir}"`);
    expect(primary).toContain('<div class="dv2-lang"');
    const quality = checks(result, renderInput.faq.entries.length);
    expect(quality.blockers, quality.blockers.map((b) => b.code).join(',')).toHaveLength(0);
    expect(quality.issues.filter((i) => i.code === 'mixed_language')).toHaveLength(0);
  }, 30_000);

  it('falls back to complete primary-only and hides the switcher when English is withheld', async () => {
    const { renderInput } = await buildLanguageAcceptanceFixture('fr', manifests, { withEnglish: false });
    const result = renderDemoV2(renderInput);
    expect(result.supportedLanguages).toEqual(['fr']);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.html).not.toContain('<div class="dv2-lang"');
  }, 30_000);
});

describe('3B1 extended deterministic checks', () => {
  it('flags RTL docs without an RTL face, destructive breaks, and duplicate mobile bars', () => {
    const bad = `<!doctype html><html lang="he" dir="rtl"><head><title>x</title>
<meta http-equiv="Content-Security-Policy" content="x"><meta name="robots" content="noindex"></head>
<body><div class="dv2-disclosure">d</div><a class="dv2-skip" href="#main"></a><main id="main">
<style>body{overflow-wrap:anywhere}</style><h1>שלום</h1><a class="dv2-btn" href="#top">x</a>
<div class="dv2-mobilebar"></div><div class="dv2-mobilebar"></div>
<section data-rhythm="airy">a</section><section data-rhythm="tight">b</section>
<section data-rhythm="banded">c</section><section data-rhythm="airy">d</section><section data-rhythm="tight">e</section>
</main></body></html>`;
    const result = runQualityChecks({
      documents: [{ language: 'he', path: 'index.html', html: bad }],
      primaryLanguage: 'he', supportedLanguages: ['he'], bundledAssetPaths: [], expectedAnchors: [], faqTopicCount: 0,
    });
    const codes = result.blockers.map((issue) => issue.code);
    expect(codes).toContain('missing_rtl_typography');
    expect(codes).toContain('destructive_word_break');
    expect(codes).toContain('duplicate_mobile_cta');
  });

  it('exposes the FAQ preview density limit', () => {
    expect(DEMO_V2_MAX_FAQ_PREVIEW).toBe(FAQ_PREVIEW_MAX);
  });
});
