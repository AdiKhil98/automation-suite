import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { orchestrateDemoV2Fixture, type DemoV2FixtureInput } from '../domain/demo-v2/orchestration-service.js';
import { type RenderAssetBinding, type RenderInput, type TeamVisualMode } from '../domain/demo-v2/render/renderer.js';
import { assetSelectionProposalSchema } from '../domain/demo-v2/orchestration-types.js';
import { type AllowedAssetCategory } from '../domain/demo-v2/render/components.js';
import { demoV2Hash } from '../domain/demo-v2/hash.js';
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

/**
 * The five committed, context-readable fictional clinic photographs used by THIS fictional
 * acceptance fixture (the German premium demo). They are synthetic, locally supplied fixture
 * imagery — not real clinic or patient photography — tracked under design-library and read directly
 * from disk. The tracked design-library files are the single source of truth; nothing is ever
 * sourced from the gitignored demos/ output. The FR/HE/AR multilang fixtures keep the deterministic
 * `fictionalClinicImages` pack above; this replacement is scoped to the fictional acceptance demo.
 */
export const FICTIONAL_CLINIC_ASSET_PROVENANCE =
  'synthetic, locally supplied fictional fixture imagery (design-library/fictional-clinic-assets); no real clinic, patient, person, or address';

const CLINIC_ASSET_DIR = 'design-library/fictional-clinic-assets';

export type ClinicPhotoKey = 'hero' | 'story' | 'treatment' | 'team' | 'location';

interface ClinicPhotoSpec {
  key: ClinicPhotoKey;
  /** Tracked source file under {@link CLINIC_ASSET_DIR}; the single source of truth. */
  file: string;
  /** Fictional CDN path used as the page <img src> and by asset discovery. */
  path: string;
  /**
   * EXPLICIT asset category, stored here rather than inferred from the PNG filename. The build
   * asserts production discovery classifies the image to exactly this category and fails closed
   * otherwise, so the five images land deterministically in their intended sections:
   * HERO→hero, CLINIC_INTERIOR→clinic story/reception, TREATMENT→treatment, TEAM→team,
   * EXTERIOR→location/interior gallery.
   */
  category: AllowedAssetCategory;
  /** Native-language (German) alt text; also the discovery classification signal. */
  altDe: string;
}

/**
 * hero-interior → hero / clinic interior; reception-story → practice story / reception;
 * treatment-room → treatment; team-group → Team; entrance-exterior → location / exterior / gallery.
 */
export const CLINIC_PHOTO_SPECS: readonly ClinicPhotoSpec[] = [
  { key: 'hero', file: 'hero-interior.png', path: '/media/praxis-hero.png', category: 'HERO',
    altDe: 'Heller, einladender Empfangsbereich der Praxis' },
  { key: 'story', file: 'reception-story.png', path: '/media/empfang-innenansicht.png', category: 'CLINIC_INTERIOR',
    altDe: 'Innenansicht des Empfangs- und Wartebereichs' },
  { key: 'treatment', file: 'treatment-room.png', path: '/media/behandlungszimmer.png', category: 'TREATMENT',
    altDe: 'Modernes Behandlungszimmer mit Behandlungsstuhl' },
  { key: 'team', file: 'team-group.png', path: '/media/praxisteam.png', category: 'TEAM',
    altDe: 'Das Praxisteam im Empfangsbereich' },
  { key: 'location', file: 'entrance-exterior.png', path: '/media/praxis-fassade.png', category: 'EXTERIOR',
    altDe: 'Eingang und Fassade der Praxis von außen' },
] as const;

export interface ClinicPhoto {
  url: string;
  bytes: Buffer;
  width: number;
  height: number;
  /** SHA-256 of the actual file bytes read from disk. */
  hash: string;
  category: AllowedAssetCategory;
  altDe: string;
  /** Recorded provenance: synthetic, locally supplied fictional fixture imagery. */
  provenance: string;
}

let photoCache: Record<ClinicPhotoKey, ClinicPhoto> | null = null;

/** Read a PNG's intrinsic dimensions from its IHDR chunk (big-endian uint32 at offsets 16/20). */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('fixture_clinic_asset_not_png');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Load the five tracked clinic photographs, reading the actual bytes and computing a SHA-256 hash
 * over them. Cached per process (byte-stable) so repeated fixture builds do not re-read from disk.
 */
export function fictionalClinicPhotos(): Record<ClinicPhotoKey, ClinicPhoto> {
  if (photoCache) return photoCache;
  const out = {} as Record<ClinicPhotoKey, ClinicPhoto>;
  for (const spec of CLINIC_PHOTO_SPECS) {
    const bytes = readFileSync(resolve(CLINIC_ASSET_DIR, spec.file));
    const { width, height } = pngDimensions(bytes);
    out[spec.key] = {
      url: `${BASE}${spec.path}`, bytes, width, height, hash: imageSha256(bytes),
      category: spec.category, altDe: spec.altDe, provenance: FICTIONAL_CLINIC_ASSET_PROVENANCE,
    };
  }
  photoCache = out;
  return photoCache;
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
  const photos = fictionalClinicPhotos();
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
      // Each <img> alt is the explicit native-language description that production asset-discovery
      // classifies from; buildAcceptanceFixture asserts the resulting category matches the EXPLICIT
      // category stored on each photo spec (fail-closed), so the five images are never mis-placed.
      html: `<html lang="de"><head></head><body><main>`
        + `<section><h1>Zahnarztpraxis Lindenhof</h1>`
        + `<img src="${photos.hero.url}" alt="${photos.hero.altDe}"></section>`
        + `<section><img src="${photos.story.url}" alt="${photos.story.altDe}"></section>`
        + `<section><img src="${photos.treatment.url}" alt="${photos.treatment.altDe}"></section>`
        + `<section><figure><img src="${photos.team.url}" alt="${photos.team.altDe}">`
        + `<figcaption>Verifiziertes Praxisteam</figcaption></figure></section>`
        + `<section><img src="${photos.location.url}" alt="${photos.location.altDe}"></section>`
        + `</main></body></html>`,
    }],
    officialWebsiteUrl: BASE,
    approvedCdnHosts: [],
    assetFetchResults: Object.fromEntries(Object.values(photos).map((photo) => [photo.url, {
      finalUrl: photo.url, redirectUrls: [] as string[], mimeType: 'image/png',
      bytes: photo.bytes.length, width: photo.width, height: photo.height, contentHash: photo.hash,
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
}, options: {
  referenceFamily?: string;
  planSections?: readonly { order: number; componentFamily: string }[];
  /**
   * DoctorFeature presentation mode. Default `group-photo` is the fictional demo's canonical form:
   * it features the approved verified TEAM group photograph in the team section (the five-photo pack
   * has no DOCTOR portrait). `text-only` and `doctor-portrait` remain supported for renderer
   * coverage. This is an explicit config value, never inferred.
   */
  teamVisualMode?: TeamVisualMode;
} = {}): Promise<AcceptanceFixture> {
  const teamVisualMode: TeamVisualMode = options.teamVisualMode ?? 'group-photo';
  const input = germanClinicFixtureInput(manifests);
  const orchestration = await orchestrateDemoV2Fixture(input);
  const photos = fictionalClinicPhotos();
  const bytesByHash = new Map<string, Buffer>(
    Object.values(photos).map((photo) => [photo.hash, photo.bytes]),
  );

  // Fail closed if production asset-discovery ever classifies a fixture photo differently from its
  // EXPLICIT stored category. Categories are declared on CLINIC_PHOTO_SPECS, never inferred from the
  // PNG filename; this assertion keeps the declared category authoritative and the five images
  // deterministically placed in their intended sections.
  for (const photo of Object.values(photos)) {
    const discovered = orchestration.assets.find((candidate) => candidate.contentHash === photo.hash);
    if (!discovered) throw new Error(`fixture_clinic_asset_not_discovered:${photo.url}`);
    if (discovered.category !== photo.category) {
      throw new Error(`fixture_clinic_asset_category_mismatch:${photo.url}:${discovered.category}!=${photo.category}`);
    }
  }

  const assets: RenderAssetBinding[] = orchestration.selections.map((selection) => {
    const asset = orchestration.assets.find((candidate) => candidate.id === selection.assetId)!;
    const bytes = bytesByHash.get(asset.contentHash);
    if (!bytes) throw new Error(`fixture_asset_bytes_missing:${asset.id}`);
    // Fictional human reuse approval — a real lead requires an explicit operator decision.
    return { selection, asset, bytes, reuseApproved: true };
  });

  // Group-photo mode: feature the verified TEAM group photograph in the team section. It is a real
  // discovered candidate (SHA-256-bound, first-party, SUITABLE). With the five-photo pack it is
  // already among the deterministic selections, so we keep it as-is; only when an older selection
  // budget caps it out do we add the explicit approval selection below. Either way the intentional
  // decision is to feature the group photo and never a DOCTOR portrait (there is none), and the
  // record/content hash bindings are preserved so deterministic allocation governs what is bundled.
  if (teamVisualMode === 'group-photo') {
    const team = orchestration.assets.find((candidate) => candidate.category === 'TEAM'
      && candidate.quality === 'SUITABLE' && candidate.availability === 'AVAILABLE'
      && (candidate.ownership === 'FIRST_PARTY' || candidate.ownership === 'APPROVED_FIRST_PARTY_CDN'));
    if (!team) throw new Error('fixture_group_photo_team_asset_missing');
    const bytes = bytesByHash.get(team.contentHash);
    if (!bytes) throw new Error(`fixture_group_photo_team_bytes_missing:${team.id}`);
    const alreadySelected = assets.some((binding) => binding.asset.id === team.id);
    if (!alreadySelected) {
    const base = {
      id: `selection-${team.id}`,
      selectionKey: 'team-and-specialist-presentation-group',
      assetId: team.id,
      intendedSection: 'team and specialist presentation',
      intendedUse: 'verified team group photograph',
      desktopCrop: { mode: 'cover' as const, aspectRatio: 1.5 },
      mobileCrop: { mode: 'cover' as const, aspectRatio: 1.2 },
      focalPoint: { x: 0.5, y: 0.45 },
      overlayGuidance: 'No text overlay.',
      contrastRequirement: 'WCAG AA text contrast when text is present.',
      fallbackBehavior: 'Use a layout without photography; never replace with unrelated third-party imagery.',
      justification: 'Approved verified TEAM group photograph featured in the team section; no DOCTOR portrait exists in the pack.',
      boundAssetRecordHash: team.recordHash,
      status: 'REUSE_REVIEW_REQUIRED' as const,
    };
    const selection = assetSelectionProposalSchema.parse({ ...base, selectionHash: demoV2Hash(base) });
    assets.push({ selection, asset: team, bytes, reuseApproved: true });
    }
  }

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
    teamVisualMode,
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
