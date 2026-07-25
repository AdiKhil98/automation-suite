import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import { buildStylesheet } from '../../src/domain/demo-v2/render/stylesheet.js';
import { buildTypographyCss } from '../../src/domain/demo-v2/render/typography.js';
import {
  renderDocument, type RenderAsset, type RenderModel, type RenderSection,
} from '../../src/domain/demo-v2/render/render-html.js';
import { buildAcceptanceFixture, fictionalClinicImages } from '../../src/fixtures/demo-v2-render-fixture.js';

/**
 * Regressions for the fictional Demo V2 visual-composition polish pass. These are structural
 * (string/DOM-free) assertions on deterministic render output — they never launch a browser and
 * never run any paid/live visual review.
 */

const FAMILY = 'luxury-cosmetic-dental';

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

async function renderLuxuryOnce() {
  // The fictional demo bundle: luxury family with the intentional text-only doctor feature.
  const { renderInput } = await buildAcceptanceFixture(manifests, { referenceFamily: FAMILY, textOnlyDoctorFeature: true });
  const result = renderDemoV2(renderInput);
  const de = result.documents.find((document) => document.language === 'de')!;
  const en = result.documents.find((document) => document.language === 'en')!;
  const quality = runQualityChecks({
    documents: result.documents,
    primaryLanguage: result.primaryLanguage,
    supportedLanguages: result.supportedLanguages,
    bundledAssetPaths: result.files.map((file) => file.path),
    expectedAnchors: result.sectionAnchors,
    faqTopicCount: renderInput.faq.entries.length,
  });
  return { result, de: de.html, en: en.html, quality };
}

// Building the fictional fixture is deterministic but not free; render once and reuse.
let cached: Awaited<ReturnType<typeof renderLuxuryOnce>> | null = null;
async function renderLuxury() {
  if (!cached) cached = await renderLuxuryOnce();
  return cached;
}
beforeAll(async () => { await renderLuxury(); }, 60_000);

/** Extract the innerHTML of the first section carrying a given component id. */
function section(html: string, componentId: string): string {
  const match = new RegExp(`<section[^>]*data-dv2-component="${componentId}"[\\s\\S]*?</section>`).exec(html);
  return match?.[0] ?? '';
}

describe('Demo V2 visual polish — deterministic validation stays clean', () => {
  it('renders with 0 blockers and 0 findings', async () => {
    const { quality } = await renderLuxury();
    expect(quality.blockers).toEqual([]);
    expect(quality.issues.filter((issue) => issue.severity === 'FINDING')).toEqual([]);
    expect(quality.structurallyEligible).toBe(true);
  });
});

describe('Demo V2 team portrait presentation', () => {
  it('the fictional demo (textOnlyDoctorFeature) renders the polished text-only doctor feature', async () => {
    const { de } = await renderLuxury();
    const team = section(de, 'DoctorFeature');
    // Intentional text-only path for this fictional demo: name + role, no portrait figure.
    expect(team).toContain('dv2-feature--text');
    expect(team).toContain('dv2-person__name');
    expect(team).toContain('Dr. Beispiel');
    expect(team).toContain('dv2-person__role');
    expect(team).toContain('Zahnärztin');
    // No portrait, no empty/reserved image box, no blank figure, no stranded grid card.
    expect(team).not.toContain('dv2-feature__portrait');
    expect(team).not.toContain('<figure');
    expect(team).not.toContain('<img');
    expect(team).not.toContain('dv2-people');
  });

  it('excludes the unused doctor portrait from files, usedAssetHashes, and counts', async () => {
    const { result } = await renderLuxury();
    const doctorHash = fictionalClinicImages().doctor.hash;
    const pngHashes = result.files
      .filter((file) => file.path.startsWith('assets/') && file.path.endsWith('.png'))
      .map((file) => createHash('sha256').update(file.bytes).digest('hex'));
    // The approved portrait is never placed: absent from the bundled asset files and the hash list.
    expect(pngHashes).not.toContain(doctorHash);
    expect(result.usedAssetHashes).not.toContain(doctorHash);
    // usedAssetHashes advertises exactly the assets actually bundled — nothing extra, nothing missing.
    expect([...result.usedAssetHashes].sort()).toEqual([...pngHashes].sort());
  });

  it('flag false preserves the approved framed doctor portrait beside name and role', async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests, {
      referenceFamily: FAMILY, textOnlyDoctorFeature: false,
    });
    const result = renderDemoV2(renderInput);
    const de = result.documents.find((document) => document.language === 'de')!.html;
    const team = section(de, 'DoctorFeature');
    expect(team).toContain('dv2-feature__portrait');
    expect(team).toMatch(/<figure class="dv2-feature__portrait"><img [^>]*src="assets\/[^"]+\.png"/);
    expect(team).not.toContain('dv2-feature--text');
    expect(team).toContain('Dr. Beispiel');
    expect(team).toContain('Zahnärztin');
    // The approved portrait is now genuinely placed, bundled, and advertised.
    expect(result.usedAssetHashes).toContain(fictionalClinicImages().doctor.hash);
  });

  it('never renders a blank asset box — a figure only exists when it wraps a real image', async () => {
    const { de, en } = await renderLuxury();
    for (const html of [de, en]) {
      expect(html).not.toMatch(/<figure[^>]*>\s*<\/figure>/);
      for (const figure of html.matchAll(/<figure[^>]*>([\s\S]*?)<\/figure>/g)) {
        expect(figure[1]).toContain('<img ');
      }
    }
  });

  it('fails closed to a polished text-only feature (name/role, no figure) when no portrait exists', () => {
    const model = teamOnlyModel([]);
    const html = renderDocument(model);
    const team = section(html, 'DoctorFeature');
    expect(team).toContain('dv2-feature--text');
    expect(team).not.toContain('<figure');
    expect(team).not.toContain('<img');
    // Still carries the name/role so it is never an empty team section.
    expect(team).toContain('dv2-person__name');
    expect(team).toContain('Dr. Beispiel');
    expect(team).toContain('Zahnärztin');
  });

  it('renders the framed portrait feature when a hash-verified portrait exists', () => {
    const model = teamOnlyModel([portraitAsset()]);
    const team = section(renderDocument(model), 'DoctorFeature');
    expect(team).toContain('dv2-feature__portrait');
    expect(team).toContain('<img ');
    expect(team).not.toContain('dv2-feature--text');
  });
});

describe('Demo V2 gallery heading/content proximity', () => {
  it('collapses a single-asset InteriorGallery to a connected feature layout (no sparse grid)', async () => {
    const { de } = await renderLuxury();
    const place = section(de, 'InteriorGallery');
    expect(place).toContain('dv2-gallery--feature');
    // Heading and the approved image live in the same section, so they stay visually connected.
    expect(place).toMatch(/<h2>[^<]+<\/h2>\s*<div class="dv2-gallery dv2-gallery--feature">/);
    expect(place).toContain('<img ');
  });
});

describe('Demo V2 content-driven section heights', () => {
  it('imposes no fixed or minimum heights on the team or place layouts', () => {
    const css = buildStylesheet(FAMILY);
    for (const selector of ['.dv2-feature', '.dv2-feature__portrait', '.dv2-gallery', '.dv2-gallery--feature', '.dv2-person']) {
      const rule = new RegExp(`\\${selector}\\{[^}]*\\}`, 'g');
      for (const block of css.match(rule) ?? []) {
        expect(block, `${selector} must not force height`).not.toMatch(/min-height|height:\s*\d/);
      }
    }
  });
});

describe('Demo V2 typography readability', () => {
  it('sets a comfortable luxury body size and line height', () => {
    const css = buildTypographyCss(FAMILY, 'de');
    // Body clamp minimum is at least ~1.08rem (17px+) and line height is generous.
    expect(css).toMatch(/--ty-body:clamp\(1\.0[89]rem|--ty-body:clamp\(1\.1/);
    expect(css).toMatch(/--lh-body:1\.7/);
  });
});

describe('Demo V2 English language purity', () => {
  it('keeps navigation, CTA, labels, and alt text fully English on en.html', async () => {
    const { en } = await renderLuxury();
    expect(en).toMatch(/<html[^>]*lang="en"/);
    for (const term of ['Request an appointment', 'Treatments', 'Team', 'Clinic', 'Common questions', 'Skip to content']) {
      expect(en, `expected English term: ${term}`).toContain(term);
    }
    // No German leakage in the English document.
    for (const german of ['Termin anfragen', 'Behandlungen', 'Häufige Fragen', 'Öffnungszeiten', 'Zahnärztin']) {
      expect(en, `unexpected German leakage: ${german}`).not.toContain(german);
    }
    // The German business name is allowed to remain as the verified business name.
    expect(en).toContain('Zahnarztpraxis Lindenhof');
  });

  it('reports no mixed_language blocker for either document', async () => {
    const { quality } = await renderLuxury();
    expect(quality.issues.filter((issue) => issue.code === 'mixed_language')).toEqual([]);
  });
});

// ---- helpers -------------------------------------------------------------------------------------

function portraitAsset(): RenderAsset {
  return {
    id: 'asset-test-portrait', category: 'DOCTOR', href: 'assets/asset-test-portrait.png',
    alt: 'Dr. Beispiel, Zahnärztin', altEnglish: 'Dr. Beispiel, dentist',
    width: 1200, height: 1500, focalX: 0.5, focalY: 0.4, contentHash: 'x'.repeat(64),
  };
}

/** A minimal RenderModel that renders only a DoctorFeature team section, for fallback testing. */
function teamOnlyModel(assets: RenderAsset[]): RenderModel {
  const teamSection: RenderSection = {
    order: 1, componentId: 'DoctorFeature', contentKeys: [], assets, rhythm: 'airy', anchor: 'team',
  };
  return {
    language: 'de', direction: 'LTR', referenceFamily: FAMILY, businessName: 'Zahnarztpraxis Lindenhof',
    content: { 'team.verified': 'Dr. Beispiel, Zahnärztin', 'navigation.team': 'Team' },
    faq: [], sections: [teamSection], alternate: null, selfLanguageLabel: 'DE',
    labels: { team: 'Team', skip: 'Zum Inhalt springen' },
    appointmentHref: null, contactHref: null, urgentHref: null, locationHref: null, whatsappHref: null,
    styleHash: 'a', scriptHash: 'b', css: buildStylesheet(FAMILY), script: '',
    typographyCss: buildTypographyCss(FAMILY, 'de'),
  };
}
