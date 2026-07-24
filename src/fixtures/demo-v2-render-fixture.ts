import { orchestrateDemoV2Fixture, type DemoV2FixtureInput } from '../domain/demo-v2/orchestration-service.js';
import { type RenderAssetBinding, type RenderInput } from '../domain/demo-v2/render/renderer.js';
import { fictionalPng, imageSha256 } from './demo-v2-images.js';

/**
 * The Milestone 3A acceptance fixture: a polished FICTIONAL German dental clinic.
 *
 * Everything here is invented `.example` data with locally generated imagery. No real clinic,
 * person, address, or photograph is referenced, and nothing in this file reaches an external
 * service. The fictional "reuse approved" flags stand in for the human asset decision that a real
 * lead would require.
 */

const BASE = 'https://praxis-lindenhof.example';
const CAPTURED = '2026-07-20T10:00:00.000Z';
const NOW = '2026-07-24T10:00:00.000Z';

const IMAGES = {
  interior: { path: '/media/praxis-interior.png', width: 1600, height: 1000, hue: 172, style: 'interior' as const },
  architecture: { path: '/media/praxis-architektur.png', width: 1400, height: 1050, hue: 158, style: 'architecture' as const },
  doctor: { path: '/media/team-portrait.png', width: 1200, height: 1500, hue: 26, style: 'portrait' as const },
  team: { path: '/media/praxis-team.png', width: 1600, height: 1100, hue: 30, style: 'interior' as const },
  treatment: { path: '/media/behandlung.png', width: 1500, height: 1000, hue: 190, style: 'treatment' as const },
  location: { path: '/media/praxis-eingang.png', width: 1600, height: 900, hue: 205, style: 'location' as const },
} as const;

export interface GeneratedImage { url: string; bytes: Buffer; width: number; height: number; hash: string }

let imageCache: Record<keyof typeof IMAGES, GeneratedImage> | null = null;

export function fictionalClinicImages(): Record<keyof typeof IMAGES, GeneratedImage> {
  // Deterministic and large (per-pixel PNG synthesis) — cache so repeated fixture builds in a
  // single process (tests, multi-language renders) do not regenerate the same bytes.
  if (imageCache) return imageCache;
  const build = (key: keyof typeof IMAGES): GeneratedImage => {
    const spec = IMAGES[key];
    const bytes = fictionalPng({ seed: `lindenhof-${key}`, width: spec.width, height: spec.height, hue: spec.hue, style: spec.style });
    return { url: `${BASE}${spec.path}`, bytes, width: spec.width, height: spec.height, hash: imageSha256(bytes) };
  };
  imageCache = {
    interior: build('interior'), architecture: build('architecture'), doctor: build('doctor'),
    team: build('team'), treatment: build('treatment'), location: build('location'),
  };
  return imageCache;
}

/** The exact 14-section experience plan for the acceptance fixture. */
export const ACCEPTANCE_PLAN_SECTIONS = [
  { order: 1, componentFamily: 'disclosure' },
  { order: 2, componentFamily: 'navigation' },
  { order: 3, componentFamily: 'image-led hero' },
  { order: 4, componentFamily: 'appointment-actions' },
  { order: 5, componentFamily: 'trust strip' },
  { order: 6, componentFamily: 'editorial treatment discovery' },
  { order: 7, componentFamily: 'clinic story' },
  { order: 8, componentFamily: 'team and specialist presentation' },
  { order: 9, componentFamily: 'architecture or interior gallery' },
  { order: 10, componentFamily: 'patient journey' },
  { order: 11, componentFamily: 'deterministic FAQ concierge' },
  { order: 12, componentFamily: 'location and opening hours' },
  { order: 13, componentFamily: 'final CTA' },
  { order: 14, componentFamily: 'footer' },
] as const;

export function germanClinicFixtureInput(manifests: {
  componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string;
}): DemoV2FixtureInput {
  const images = fictionalClinicImages();
  const source = (
    id: string,
    kind: 'LEAD_FACT' | 'AUDIT_FINDING' | 'CAPTURE_EVIDENCE',
    role: 'IDENTITY' | 'CONTENT' | 'AUDIT' | 'LANGUAGE' | 'ASSET_CONTEXT' | 'CONTACT' | 'CLAIM',
    key: string,
    value: string,
    direct = true,
  ) => ({ id: `lindenhof-${id}`, kind, role, key, value, capturedAt: CAPTURED, direct, accepted: true });

  return {
    fixtureId: 'lindenhof-premium-de',
    sources: [
      source('business', 'LEAD_FACT', 'IDENTITY', 'fact.business_name', 'Zahnarztpraxis Lindenhof'),
      source('website', 'LEAD_FACT', 'IDENTITY', 'fact.official_website_url', BASE),
      source('domain', 'LEAD_FACT', 'IDENTITY', 'fact.official_domain', 'praxis-lindenhof.example'),
      source('country', 'LEAD_FACT', 'IDENTITY', 'fact.country', 'Deutschland'),
      source('address', 'LEAD_FACT', 'CONTACT', 'fact.formatted_address', 'Lindenhofstraße 12, 10999 Beispielstadt, Deutschland'),
      source('phone', 'LEAD_FACT', 'CONTACT', 'fact.phone', '+49 30 555 0100'),
      source('email', 'LEAD_FACT', 'CONTACT', 'fact.contact_email', 'praxis@praxis-lindenhof.example'),
      source('booking', 'LEAD_FACT', 'CONTACT', 'fact.booking_url', `${BASE}/termin`),
      source('hours', 'LEAD_FACT', 'CONTENT', 'fact.opening_hours', 'Montag bis Freitag 08:00-18:00, Samstag nach Vereinbarung'),
      source('services', 'LEAD_FACT', 'CONTENT', 'fact.services', 'Implantologie|Prophylaxe|Parodontologie|Ästhetische Zahnheilkunde'),
      source('lang', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.lang', 'de'),
      source('text', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.text', 'Die Praxis und der Termin stehen im Mittelpunkt der Behandlung und der Beratung.'),
      source('finding', 'AUDIT_FINDING', 'AUDIT', 'audit.appointment_path', 'Die verifizierte Terminmöglichkeit ist auf der bestehenden Seite schwer zu finden.', false),
      source('positioning', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.positioning.primary', 'Ruhige Praxis mit verifizierter Architektur und persönlicher Betreuung.', false),
      source('concern', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.concern.orientation', 'Patientinnen und Patienten wünschen klare praktische Orientierung vor der Terminanfrage.', false),
      source('anxiety', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.concern.anxiety', 'Viele Patientinnen und Patienten berichten von Anspannung vor einem Zahnarztbesuch.', false),
      source('family', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.audience.family', 'Die Praxis beschreibt die Betreuung von Kindern und Familien.', false),
      source('emergency', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.emergency_contact', 'Dringende Anliegen werden über die verifizierte Telefonnummer aufgenommen.', false),
      source('atmosphere', 'CAPTURE_EVIDENCE', 'ASSET_CONTEXT', 'capture.atmosphere.interior', 'Die verifizierten Aufnahmen zeigen helle, ruhige Praxisräume.', false),
      source('strength-termin', 'CAPTURE_EVIDENCE', 'CLAIM', 'capture.strength.appointment', 'Die Terminanfrage ist auf der bestehenden Seite verifiziert hinterlegt.', false),
      source('strength-transparenz', 'CAPTURE_EVIDENCE', 'CLAIM', 'capture.strength.transparency', 'Öffnungszeiten, Adresse und Kontakt sind vollständig verifiziert.', false),
      source('team', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.team.verified', 'Dr. Beispiel, Zahnärztin', false),
    ],
    pages: [{
      id: 'lindenhof-page-home',
      url: BASE,
      captureEvidenceId: null,
      html: `<html lang="de"><head></head><body><main>`
        + `<section><h1>Zahnarztpraxis Lindenhof</h1>`
        + `<img src="${images.interior.url}" alt="Innenansicht der ruhigen Praxisräume"></section>`
        + `<section><img src="${images.architecture.url}" alt="Fassade und Architektur der Praxis"></section>`
        + `<section><figure><img src="${images.doctor.url}" alt="Dr. Beispiel, Zahnärztin">`
        + `<figcaption>Verifiziertes Praxisteam</figcaption></figure></section>`
        + `<section><img src="${images.team.url}" alt="Praxisteam im Empfangsbereich"></section>`
        + `<section><img src="${images.treatment.url}" alt="Behandlungssituation im Behandlungszimmer"></section>`
        + `<section><img src="${images.location.url}" alt="Standort und Eingang der Praxis"></section>`
        + `</main></body></html>`,
    }],
    officialWebsiteUrl: BASE,
    approvedCdnHosts: [],
    assetFetchResults: Object.fromEntries(Object.values(images).map((image) => [image.url, {
      finalUrl: image.url, redirectUrls: [] as string[], mimeType: 'image/png',
      bytes: image.bytes.length, width: image.width, height: image.height, contentHash: image.hash,
    }])),
    componentRegistry: { version: manifests.componentVersion, hash: manifests.componentHash },
    referenceLibrary: { version: manifests.referenceVersion, hash: manifests.referenceHash },
    now: NOW,
    // Fictional English for this fixture's evidence-derived German prose, so the prepared English
    // package is complete and the page is never mixed-language.
    translationGlossary: {
      'Ruhige Praxis mit verifizierter Architektur und persönlicher Betreuung.':
        'A calm practice with verified architecture and personal care.',
      'Die verifizierten Aufnahmen zeigen helle, ruhige Praxisräume.':
        'The verified photographs show bright, calm practice rooms.',
      'Die Terminanfrage ist auf der bestehenden Seite verifiziert hinterlegt.':
        'The appointment request is verifiably documented on the existing site.',
      'Öffnungszeiten, Adresse und Kontakt sind vollständig verifiziert.':
        'Opening hours, address and contact details are fully verified.',
      'Dr. Beispiel, Zahnärztin': 'Dr. Beispiel, dentist',
      'Montag bis Freitag 08:00-18:00, Samstag nach Vereinbarung':
        'Monday to Friday 08:00-18:00, Saturday by arrangement',
      'Lindenhofstraße 12, 10999 Beispielstadt, Deutschland':
        'Lindenhofstrasse 12, 10999 Beispielstadt, Germany',
      'Implantologie|Prophylaxe|Parodontologie|Ästhetische Zahnheilkunde':
        'Implant dentistry|Preventive care|Periodontology|Aesthetic dentistry',
    },
  };
}

export interface AcceptanceFixture {
  renderInput: RenderInput;
  orchestration: Awaited<ReturnType<typeof orchestrateDemoV2Fixture>>;
}

/**
 * Build the complete Milestone 3A render input from the Milestone 2 orchestration output, so the
 * rendered page inherits real evidence bindings, hashes, and the deterministic FAQ package.
 */
export async function buildAcceptanceFixture(manifests: {
  componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string;
}, options: { referenceFamily?: string; planSections?: readonly { order: number; componentFamily: string }[] } = {}): Promise<AcceptanceFixture> {
  const input = germanClinicFixtureInput(manifests);
  const orchestration = await orchestrateDemoV2Fixture(input);
  const images = fictionalClinicImages();
  const bytesByHash = new Map<string, Buffer>(
    Object.values(images).map((image) => [image.hash, image.bytes]),
  );

  const assets: RenderAssetBinding[] = orchestration.selections.map((selection) => {
    const asset = orchestration.assets.find((candidate) => candidate.id === selection.assetId)!;
    const bytes = bytesByHash.get(asset.contentHash);
    if (!bytes) throw new Error(`fixture_asset_bytes_missing:${asset.id}`);
    // Fictional human reuse approval — a real lead requires an explicit operator decision.
    return { selection, asset, bytes, reuseApproved: true };
  });

  const renderInput: RenderInput = {
    artifactId: 'artifact-lindenhof-premium-de',
    referenceFamily: options.referenceFamily ?? orchestration.report.referenceFamily,
    businessName: 'Zahnarztpraxis Lindenhof',
    primary: orchestration.content.package,
    translation: orchestration.translation,
    // The fictional English package is treated as human-reviewed for this acceptance fixture.
    translationReviewed: true,
    faq: orchestration.content.faq,
    planSections: options.planSections ?? ACCEPTANCE_PLAN_SECTIONS,
    assets,
    intelligenceHash: orchestration.intelligence.package.packageHash,
    creativeBriefHash: orchestration.creativeBrief.briefHash,
    experiencePlanHash: orchestration.experiencePlan.planHash,
    componentRegistryVersion: manifests.componentVersion,
    componentRegistryHash: manifests.componentHash,
    referenceLibraryVersion: manifests.referenceVersion,
    referenceLibraryHash: manifests.referenceHash,
    channels: {
      bookingUrl: `${BASE}/termin`,
      phone: '+49 30 555 0100',
      email: 'praxis@praxis-lindenhof.example',
      whatsappUrl: null,
      locationUrl: null,
    },
  };
  return { renderInput, orchestration };
}
