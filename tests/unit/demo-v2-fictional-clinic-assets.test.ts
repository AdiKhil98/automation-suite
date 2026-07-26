import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2, type RenderInput } from '../../src/domain/demo-v2/render/renderer.js';
import { requireComponent } from '../../src/domain/demo-v2/render/components.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import {
  buildAcceptanceFixture, fictionalClinicPhotos, fictionalClinicImages,
  CLINIC_PHOTO_SPECS, FICTIONAL_CLINIC_ASSET_PROVENANCE, type ClinicPhotoKey,
} from '../../src/fixtures/demo-v2-render-fixture.js';

/**
 * Integration of the five committed, context-readable fictional clinic photographs into the Demo
 * Engine V2 acceptance fixture. These are structural (browser-free) assertions on deterministic
 * render output — they never launch a browser and never run any paid/live visual review.
 *
 * The images are synthetic, locally supplied fictional fixture imagery (no real clinic or patient).
 */

const ASSET_DIR = 'design-library/fictional-clinic-assets';

/** The intended tracked source file, /media path, and explicit section for each photo key. */
const EXPECTED: Record<ClinicPhotoKey, { file: string; path: string; category: string; component: string }> = {
  hero: { file: 'hero-interior.png', path: '/media/praxis-hero.png', category: 'HERO', component: 'ArchitectureImageHero' },
  story: { file: 'reception-story.png', path: '/media/empfang-innenansicht.png', category: 'CLINIC_INTERIOR', component: 'CalmCareStory' },
  treatment: { file: 'treatment-room.png', path: '/media/behandlungszimmer.png', category: 'TREATMENT', component: 'TreatmentSpotlight' },
  team: { file: 'team-group.png', path: '/media/praxisteam.png', category: 'TEAM', component: 'DoctorFeature' },
  location: { file: 'entrance-exterior.png', path: '/media/praxis-fassade.png', category: 'EXTERIOR', component: 'InteriorGallery' },
};
const KEYS = Object.keys(EXPECTED) as ClinicPhotoKey[];

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

let input: RenderInput;
let result: ReturnType<typeof renderDemoV2>;
beforeAll(async () => {
  const built = await buildAcceptanceFixture(manifests); // default is the canonical group-photo demo
  input = built.renderInput;
  result = renderDemoV2(input);
  // Warm the (slow, per-pixel) synthetic pack once so the "no abstract asset" assertion is instant.
  fictionalClinicImages();
}, 60_000);

/** Map every rendered asset id → its clinic-photo key (via content hash). */
function idToKey(): Map<string, ClinicPhotoKey> {
  const photos = fictionalClinicPhotos();
  const hashToKey = new Map<string, ClinicPhotoKey>(KEYS.map((k) => [photos[k].hash, k]));
  const out = new Map<string, ClinicPhotoKey>();
  for (const binding of input.assets) {
    const key = hashToKey.get(binding.asset.contentHash);
    if (key) out.set(binding.asset.id, key);
  }
  return out;
}

/** component id → asset keys it renders in the DE document. */
function placement(): Map<string, ClinicPhotoKey[]> {
  const map = idToKey();
  const de = result.documents.find((d) => d.language === 'de')!.html;
  const out = new Map<string, ClinicPhotoKey[]>();
  for (const block of de.split('data-dv2-component="').slice(1)) {
    const cid = block.slice(0, block.indexOf('"'));
    const keys = [...block.matchAll(/assets\/(asset-[0-9a-f]+)\.png/g)]
      .map((m) => map.get(m[1]!)).filter((k): k is ClinicPhotoKey => Boolean(k));
    if (keys.length) out.set(cid, [...(out.get(cid) ?? []), ...keys]);
  }
  return out;
}

describe('Demo V2 fictional clinic assets — load & explicit categories', () => {
  it('loads all five tracked assets from their intended design-library paths', () => {
    const photos = fictionalClinicPhotos();
    for (const spec of CLINIC_PHOTO_SPECS) {
      expect(EXPECTED[spec.key].file).toBe(spec.file);
      expect(spec.path).toBe(EXPECTED[spec.key].path);
      expect(photos[spec.key].url.endsWith(spec.path)).toBe(true);
      // Bytes are the actual tracked file, not a generated blob.
      const onDisk = readFileSync(resolve(ASSET_DIR, spec.file));
      expect(Buffer.compare(photos[spec.key].bytes, onDisk)).toBe(0);
      expect(photos[spec.key].provenance).toBe(FICTIONAL_CLINIC_ASSET_PROVENANCE);
    }
    expect(CLINIC_PHOTO_SPECS.map((s) => s.key).sort()).toEqual([...KEYS].sort());
  });

  it('assigns the correct EXPLICIT category to each asset (stored, not filename-inferred)', () => {
    for (const spec of CLINIC_PHOTO_SPECS) {
      expect(spec.category).toBe(EXPECTED[spec.key].category);
    }
    // The category a binding actually carries into the renderer matches the explicit spec.
    const photos = fictionalClinicPhotos();
    const hashToKey = new Map(KEYS.map((k) => [photos[k].hash, k]));
    for (const binding of input.assets) {
      const key = hashToKey.get(binding.asset.contentHash);
      if (!key) continue;
      expect(binding.asset.category).toBe(EXPECTED[key].category);
    }
  });

  it('computes each SHA-256 from the actual file bytes', () => {
    const photos = fictionalClinicPhotos();
    for (const spec of CLINIC_PHOTO_SPECS) {
      const expected = createHash('sha256').update(readFileSync(resolve(ASSET_DIR, spec.file))).digest('hex');
      expect(photos[spec.key].hash).toBe(expected);
    }
  });
});

describe('Demo V2 fictional clinic assets — rendering', () => {
  it('renders all five assets, each in its intended section', () => {
    const place = placement();
    for (const key of KEYS) {
      const comp = EXPECTED[key].component;
      expect(place.get(comp), `${key} must render in ${comp}`).toEqual([key]);
    }
    // Every intended section carries a real, hash-addressed <img> (never a blank frame).
    const de = result.documents.find((d) => d.language === 'de')!.html;
    for (const key of KEYS) {
      const cid = EXPECTED[key].component;
      const block = new RegExp(`<section[^>]*data-dv2-component="${cid}"[\\s\\S]*?</section>`).exec(de)?.[0] ?? '';
      expect(block).toMatch(/<img [^>]*src="assets\/[^"]+\.png"[^>]*width="\d+"[^>]*height="\d+"/);
    }
  });

  it('every rendered image sits in a section its category is eligible to place', () => {
    const map = idToKey();
    const de = result.documents.find((d) => d.language === 'de')!.html;
    for (const block of de.split('data-dv2-component="').slice(1)) {
      const cid = block.slice(0, block.indexOf('"'));
      const spec = requireComponent(cid);
      // The team feature draws the TEAM group photo (group-photo mode) rather than a DOCTOR portrait.
      const allowed = cid === 'DoctorFeature' ? [...spec.allowedAssetCategories, 'TEAM'] : spec.allowedAssetCategories;
      for (const m of block.matchAll(/assets\/(asset-[0-9a-f]+)\.png/g)) {
        const key = map.get(m[1]!);
        if (!key) continue;
        expect(allowed).toContain(EXPECTED[key].category);
      }
    }
  });

  it('selects none of the old abstract/generated fixture assets', () => {
    const abstract = new Set(Object.values(fictionalClinicImages()).map((image) => image.hash));
    for (const hash of result.usedAssetHashes) {
      expect(abstract.has(hash), `abstract asset ${hash} must not be selected`).toBe(false);
    }
    // The five used hashes are exactly the five real file hashes.
    const real = KEYS.map((k) => fictionalClinicPhotos()[k].hash).sort();
    expect([...result.usedAssetHashes].sort()).toEqual(real);
  });

  it('keeps files, counts, and usedAssetHashes consistent with the rendered assets', () => {
    const assetFiles = result.files.filter((f) => f.path.startsWith('assets/') && f.path.endsWith('.png'));
    expect(assetFiles).toHaveLength(5);
    expect(result.usedAssetHashes).toHaveLength(5);
    const fileHashes = assetFiles.map((f) => createHash('sha256').update(f.bytes).digest('hex')).sort();
    expect([...result.usedAssetHashes].sort()).toEqual(fileHashes);
    // Nothing advertised is missing from the bundle and nothing extra is bundled.
    expect(new Set(result.usedAssetHashes).size).toBe(5);
  });
});

describe('Demo V2 fictional clinic assets — language purity & switcher', () => {
  it('keeps DE German and EN English (no cross-language leakage)', () => {
    const de = result.documents.find((d) => d.language === 'de')!.html;
    const en = result.documents.find((d) => d.language === 'en')!.html;
    expect(de).toMatch(/<html[^>]*lang="de"/);
    expect(en).toMatch(/<html[^>]*lang="en"/);
    for (const term of ['Termin anfragen', 'Behandlungen', 'Häufige Fragen']) expect(de).toContain(term);
    for (const term of ['Request an appointment', 'Treatments', 'Common questions']) expect(en).toContain(term);
    for (const german of ['Termin anfragen', 'Behandlungen', 'Häufige Fragen', 'Zahnärztin']) {
      expect(en, `unexpected German leakage: ${german}`).not.toContain(german);
    }
    // Verified business name is allowed to stay.
    expect(en).toContain('Zahnarztpraxis Lindenhof');
  });

  it('renders the compact always-visible mobile header language switcher (commit 8a214e2)', () => {
    // The compact header langbar is present in both documents; the browser test asserts it is
    // actually visible in the default closed-menu mobile screenshot.
    for (const document of result.documents) {
      expect(document.html).toContain('dv2-nav__langbar');
      expect(document.html).toMatch(/dv2-nav__langbar[\s\S]*?dv2-lang/);
    }
  });
});

describe('Demo V2 fictional clinic assets — deterministic validation', () => {
  it('returns 0 blockers and 0 findings', () => {
    const quality = runQualityChecks({
      documents: result.documents,
      primaryLanguage: result.primaryLanguage,
      supportedLanguages: result.supportedLanguages,
      bundledAssetPaths: result.files.map((f) => f.path),
      expectedAnchors: result.sectionAnchors,
      faqTopicCount: input.faq.entries.length,
    });
    expect(quality.blockers).toEqual([]);
    expect(quality.issues.filter((issue) => issue.severity === 'FINDING')).toEqual([]);
    expect(quality.structurallyEligible).toBe(true);
  });
});
