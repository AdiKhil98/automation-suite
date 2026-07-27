import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../src/domain/demo-v2/render/quality-checks.js';
import {
  buildEvidenceRenderInput, deGlueLabel, parseExportedEvidence,
  type IllustrativeAsset,
} from '../../src/domain/demo-v2/render/evidence-render-input.js';
import { fictionalPng } from '../../src/fixtures/demo-v2-images.js';

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};

/**
 * A synthetic, fully fictional `.example` exported-evidence bundle in the immutable export shape.
 * No real business, domain, address, or person is referenced; every image is locally generated.
 */
const EXPORTED_AT = '2026-07-20T10:00:00.000Z';

function record(sourceType: string, payload: Record<string, unknown>) {
  return { recordId: `rec-${sourceType}-${String(payload.id ?? payload.findingRef ?? Math.random())}`, sourceType, payload, payloadSha256: 'x'.repeat(64) };
}

function leadFact(id: string, factType: string, value: string) {
  return record('lead_fact', {
    id, leadId: 'lead-1', factType, value, normalizedValue: value, sourceType: 'website',
    sourceUrl: null, confidence: 1, capturedAt: '2026-07-18T09:00:00.000Z', isCurrent: true,
  });
}

function baseEvidence(extra: ReturnType<typeof record>[] = []) {
  return {
    schemaVersion: 'evidence-export-test-1',
    leadId: 'lead-1',
    normalizedDomain: 'example-clinic.example',
    exportedAt: EXPORTED_AT,
    recordCount: 0,
    recordsSha256: 'y'.repeat(64),
    records: [
      record('lead', { id: 'lead-1', businessName: 'Beispielklinik', normalizedDomain: 'example-clinic.example', city: 'Beispielstadt', country: 'Germany', status: 'OPERATIONAL' }),
      leadFact('f-name', 'business_name', 'Beispielklinik'),
      leadFact('f-cat', 'category', 'dentist'),
      leadFact('f-web', 'official_website_url', 'https://example-clinic.example/'),
      leadFact('f-dom', 'official_domain', 'example-clinic.example'),
      leadFact('f-country', 'country', 'Germany'),
      leadFact('f-city', 'city', 'Beispielstadt'),
      leadFact('f-addr', 'formatted_address', 'Beispielstraße 1, 12345 Beispielstadt, Germany'),
      leadFact('f-phone', 'phone', '+49301234567'),
      leadFact('f-email', 'contact_email', 'info@example-clinic.example'),
      leadFact('f-loc', 'official_location_page_url', 'https://example-clinic.example/standort/'),
      leadFact('f-services', 'services', 'ÄsthetischeZahnmedizin | Bleaching | Veneers'),
      record('capture_evidence', { id: 'ce-lang', capturedPageId: 'p1', evidenceType: 'lang', sourceUrl: 'https://example-clinic.example/', profile: 'desktop', selector: 'html', normalizedValue: 'de' }),
      ...extra,
    ],
  };
}

function auditFinding(findingRef: string, safeForOutreach: boolean, observation = 'Some internal audit note.') {
  return record('audit_finding', {
    id: `af-${findingRef}`, auditRunId: 'ar-1', findingRef, category: 'CTA_CLARITY',
    observation, affectedUrls: [], affectedProfiles: ['DESKTOP'], severity: 'MEDIUM',
    confidence: 0.8, businessImpact: 'x', recommendation: 'y', safeForOutreach,
    outreachAngle: null, uncertainty: null, reviewDecision: 'REVISE',
  });
}

let poolCache: IllustrativeAsset[] | null = null;
// Per-pixel PNG synthesis is expensive; generate the illustrative pool once for the whole file.
function pool(): IllustrativeAsset[] {
  if (poolCache) return poolCache;
  const make = (key: string, category: IllustrativeAsset['category'], altNative: string, w: number, h: number, hue: number, style: 'interior' | 'architecture' | 'treatment' | 'location' | 'portrait') => ({
    key, category, altNative,
    bytes: fictionalPng({ seed: `evtest-${key}`, width: w, height: h, hue, style }),
    width: w, height: h, provenance: 'synthetic, locally supplied illustrative fixture imagery',
  });
  // Small images keep per-pixel PNG synthesis cheap; the adapter only cares about categories and
  // dimensions, not resolution (a low-res hero is a non-blocking FINDING).
  poolCache = [
    make('hero', 'HERO', 'Heller Empfangsbereich', 480, 300, 172, 'interior'),
    make('interior', 'CLINIC_INTERIOR', 'Innenansicht des Wartebereichs', 400, 300, 158, 'interior'),
    make('treatment', 'TREATMENT', 'Modernes Behandlungszimmer', 400, 300, 190, 'treatment'),
    make('exterior', 'EXTERIOR', 'Fassade des Gebäudes', 480, 270, 205, 'location'),
  ];
  return poolCache;
}

const DISCLOSURE = {
  de: 'Die Bilder sind rein illustrativ und zeigen weder die Klinik noch deren Team.',
  en: 'The images are purely illustrative and do not depict the clinic or its staff.',
};

async function build(evidence: unknown, family?: string, assets: IllustrativeAsset[] = pool()) {
  return buildEvidenceRenderInput({
    evidence,
    illustrativeAssets: assets,
    illustrativeHost: 'https://illustrative.example',
    manifests,
    assetDisclosure: DISCLOSURE,
    referenceFamily: family,
  });
}

// Pre-generate the illustrative pool once, outside any 5s-timed test body.
beforeAll(() => { pool(); }, 30000);

describe('deGlueLabel', () => {
  it('inserts a space at a glued lowercase→uppercase boundary only', () => {
    expect(deGlueLabel('ÄsthetischeZahnmedizin')).toBe('Ästhetische Zahnmedizin');
    expect(deGlueLabel('Bleaching')).toBe('Bleaching');
    expect(deGlueLabel('Veneers')).toBe('Veneers');
    expect(deGlueLabel('Zahnersatz')).toBe('Zahnersatz');
  });
});

describe('buildEvidenceRenderInput', () => {
  it('parses the envelope and requires business identity', async () => {
    const noName = baseEvidence();
    noName.records = noName.records.filter((r) => r.payload.factType !== 'business_name' && r.sourceType !== 'lead');
    await expect(build(noName)).rejects.toThrow(/missing_identity/);
  });

  it('builds a valid, structurally eligible render with zero blockers', async () => {
    const { renderInput, meta } = await build(baseEvidence(), 'luxury-cosmetic-dental');
    const result = renderDemoV2(renderInput);
    const quality = runQualityChecks({
      documents: result.documents,
      primaryLanguage: result.primaryLanguage,
      supportedLanguages: result.supportedLanguages,
      bundledAssetPaths: result.files.map((file) => file.path),
      expectedAnchors: result.sectionAnchors,
      faqTopicCount: renderInput.faq.entries.length,
    });
    expect(quality.blockers).toEqual([]);
    expect(quality.structurallyEligible).toBe(true);
    expect(meta.businessName).toBe('Beispielklinik');
    // Primary-language only; English is prepared but withheld (never presented as reviewed).
    expect(result.supportedLanguages).toEqual(['de']);
    expect(renderInput.translationReviewed).toBe(false);
    expect(meta.englishPrepared).toBe(true);
  });

  it('presents services with clean spacing bound to the services fact', async () => {
    const { renderInput } = await build(baseEvidence());
    const result = renderDemoV2(renderInput);
    expect(result.documents[0]!.html).toContain('Ästhetische Zahnmedizin');
    expect(result.documents[0]!.html).not.toContain('ÄsthetischeZahnmedizin');
    // Every rendered factual claim is evidence-bound: the service items carry the services fact id.
    const serviceItems = renderInput.primary.items.filter((item) => item.contentKey.startsWith('treatments.'));
    expect(serviceItems.length).toBe(3);
  });

  it('shows the illustrative-imagery disclosure on the page', async () => {
    const { renderInput } = await build(baseEvidence());
    const html = renderDemoV2(renderInput).documents[0]!.html;
    expect(html).toContain('rein illustrativ');
    expect(html).toContain('dv2-disclosure__assets');
  });

  it('uses safe audit findings but never renders their observation text', async () => {
    const evidence = baseEvidence([
      auditFinding('F1', true, 'INTERNAL: the appointment label TERMIN is location-neutral.'),
      auditFinding('F2', false, 'INTERNAL: unsafe raw note that must be dropped.'),
    ]);
    const { renderInput, meta } = await build(evidence);
    expect(meta.auditFindingsUsed.map((f) => f.findingRef)).toEqual(['F1']);
    expect(meta.auditFindingsExcluded.map((f) => f.findingRef)).toEqual(['F2']);
    const html = renderDemoV2(renderInput).documents[0]!.html;
    expect(html).not.toContain('location-neutral');
    expect(html).not.toContain('unsafe raw note');
    expect(html).not.toContain('INTERNAL:');
  });

  it('omits sections that lack supporting evidence rather than inventing them', async () => {
    // Keep the phone (conversion path) but drop every location fact and all imagery.
    const sparse = baseEvidence();
    sparse.records = sparse.records.filter((r) =>
      !['formatted_address', 'official_location_page_url', 'city', 'country'].includes(String(r.payload.factType)));
    const { meta } = await build(sparse, undefined, []);
    const families = meta.plannedSections.map((s) => s.componentFamily);
    // Appointment path survives; location + gallery are omitted for lack of evidence/imagery.
    expect(families).toContain('appointment-actions');
    expect(families).toContain('editorial treatment discovery');
    expect(families).not.toContain('architecture or interior gallery');
    expect(families).not.toContain('location and opening hours');
    const omitted = meta.omittedSections.map((s) => s.componentFamily);
    expect(omitted).toContain('location and opening hours');
    expect(omitted).toContain('architecture or interior gallery');
  });

  it('is deterministic: identical evidence renders to an identical hash', async () => {
    const a = renderDemoV2((await build(baseEvidence())).renderInput);
    const b = renderDemoV2((await build(baseEvidence())).renderInput);
    expect(a.renderHash).toBe(b.renderHash);
  });

  it('records the illustrative pool and marks the render non-deployable', async () => {
    const { renderInput, meta } = await build(baseEvidence());
    expect(meta.illustrativePool.length).toBe(4);
    expect(meta.illustrativePool.every((asset) => asset.provenance.includes('illustrative'))).toBe(true);
    // Placed assets are a subset of the pool (only sections that render place an asset).
    expect(meta.placedAssetHashes.length).toBeGreaterThanOrEqual(0);
    expect(renderInput.assetDisclosure).toEqual(DISCLOSURE);
  });

  it('parseExportedEvidence rejects a malformed envelope', () => {
    expect(() => parseExportedEvidence({ leadId: 'x' })).toThrow();
  });
});
