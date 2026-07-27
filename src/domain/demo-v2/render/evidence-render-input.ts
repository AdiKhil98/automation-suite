import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  orchestrateDemoV2Fixture,
  type DemoV2FixtureInput,
  type DemoV2OrchestrationOutput,
} from '../orchestration-service.js';
import { type RenderAssetBinding, type RenderInput } from './renderer.js';
import { type AllowedAssetCategory, ASSET_CATEGORIES } from './components.js';
import { type DemoV2RawSource } from '../intelligence-builder.js';

/**
 * Generic adapter: turn an already-exported, redacted evidence bundle into the deterministic Demo V2
 * render input.
 *
 * This module is business-agnostic. It knows nothing about any specific lead, domain, or clinic: it
 * parses the immutable export envelope, maps the whitelisted records onto the existing Milestone 2
 * orchestration input, and returns the Milestone 3A render input. Every rendered factual claim it
 * produces stays bound to the exact exported record id that authorized it (services → the services
 * lead-fact, address → the address lead-fact, and so on), because it feeds the same deterministic,
 * evidence-gated content pipeline the fictional fixture uses.
 *
 * Two things it deliberately does NOT do:
 * - It never invents content. A section is planned only when the evidence supports its required
 *   content; sparse evidence yields a shorter, honest page rather than filler.
 * - It never sources first-party photography from the export (the export carries none by
 *   construction). Imagery is supplied by the caller as an explicit ILLUSTRATIVE asset pool together
 *   with a per-language disclosure, so the render can never be mistaken for real premises or staff.
 *
 * It performs no network, database, deployment, screenshot, Sol, Gmail, email, or scheduling work.
 * All model access is the existing bounded mock orchestration (zero paid calls).
 */

// --------------------------------------------------------------- export schema

const exportedRecordSchema = z.object({
  recordId: z.string().min(1),
  sourceType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

/** Permissive envelope schema — the export owns the authoritative shape; we read a safe subset. */
export const exportedEvidenceSchema = z.object({
  schemaVersion: z.string().min(1),
  leadId: z.string().min(1),
  normalizedDomain: z.string().min(1),
  /** Fixed export timestamp; used as the deterministic clock so renders are byte-reproducible. */
  exportedAt: z.string().min(1),
  records: z.array(exportedRecordSchema).min(1),
});
export type ExportedEvidence = z.infer<typeof exportedEvidenceSchema>;

export function parseExportedEvidence(raw: unknown): ExportedEvidence {
  return exportedEvidenceSchema.parse(raw);
}

// --------------------------------------------------------------- illustrative assets

/**
 * A single illustrative image the caller supplies for the render. It is NOT sourced from the
 * exported evidence and must never be presented as a real photograph of the business. `provenance`
 * is recorded verbatim in the meta report.
 */
export interface IllustrativeAsset {
  /** Stable key, used to derive a deterministic first-party asset URL and id namespace. */
  key: string;
  category: AllowedAssetCategory;
  /** Native (primary-language) alt text; also the discovery classification signal. */
  altNative: string;
  bytes: Buffer;
  width: number;
  height: number;
  /** Recorded provenance string (e.g. "synthetic, locally supplied illustrative imagery"). */
  provenance: string;
}

// --------------------------------------------------------------- options / result

export interface EvidenceManifests {
  componentVersion: string;
  componentHash: string;
  referenceVersion: string;
  referenceHash: string;
}

export interface BuildEvidenceRenderInputOptions {
  /** Raw parsed export JSON (validated here). */
  evidence: unknown;
  /** Illustrative image pool (host-consistent). Every rendered image is drawn from this pool. */
  illustrativeAssets: readonly IllustrativeAsset[];
  /** Fictional first-party host the illustrative assets live on (never a real business site). */
  illustrativeHost: string;
  manifests: EvidenceManifests;
  /**
   * Per-language illustrative-imagery disclosure shown inside the concept disclosure bar. Each
   * string should avoid the marker words of the other supported languages.
   */
  assetDisclosure: Readonly<Record<string, string>>;
  /** Deterministic "now" for staleness/orchestration; defaults to the export's records. */
  now?: string;
  artifactId?: string;
  /** Optional presentation overrides (exact extracted label → cleaned label). */
  serviceLabelOverrides?: Readonly<Record<string, string>>;
  /** Optional forced reference family; defaults to the deterministically selected one. */
  referenceFamily?: string;
}

export interface EvidenceRenderMeta {
  schemaVersion: string;
  leadId: string;
  normalizedDomain: string;
  businessName: string;
  usedFactTypes: readonly string[];
  serviceLabels: { raw: string; presented: string }[];
  auditFindingsUsed: { findingRef: string; category: string; severity: string; safeForOutreach: boolean }[];
  auditFindingsExcluded: { findingRef: string; reason: string }[];
  illustrativePool: { key: string; category: string; provenance: string }[];
  placedAssetHashes: readonly string[];
  plannedSections: readonly { order: number; componentFamily: string }[];
  omittedSections: readonly { componentFamily: string; reason: string }[];
  faqTopics: readonly string[];
  faqOmittedTopics: readonly string[];
  languageRendered: string;
  englishPrepared: boolean;
  englishWithheldReason: string | null;
}

export interface EvidenceRenderInputResult {
  renderInput: RenderInput;
  orchestration: DemoV2OrchestrationOutput;
  meta: EvidenceRenderMeta;
}

// --------------------------------------------------------------- helpers

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Insert a space at a glued lowercase→uppercase boundary so a concatenated label
 * ("ÄsthetischeZahnmedizin") is presented with clean spacing ("Ästhetische Zahnmedizin"). This is a
 * general presentation cleanup — it changes spacing only, never the words themselves.
 */
export function deGlueLabel(value: string): string {
  return value
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Deterministic per-factType ordering so `first(...)` resolves to the intended assertion. */
const FACT_RANK: Record<string, number> = {
  business_name: 10, category: 11, official_website_url: 12, official_domain: 13, domain: 14,
  formatted_address: 20, city: 21, country: 22, official_location_page_url: 23,
  phone: 30, contact_email: 31, contact_form_url: 32, booking_url: 33,
  services: 40, opening_hours: 41,
};

/** Fact roles for the source records (informational; placement is by key prefix). */
const FACT_ROLE: Record<string, DemoV2RawSource['role']> = {
  business_name: 'IDENTITY', category: 'IDENTITY', official_website_url: 'IDENTITY',
  official_domain: 'IDENTITY', domain: 'IDENTITY',
  formatted_address: 'CONTACT', city: 'CONTACT', country: 'CONTENT',
  official_location_page_url: 'CONTACT', phone: 'CONTACT', contact_email: 'CONTACT',
  contact_form_url: 'CONTACT', booking_url: 'CONTACT', services: 'CONTENT', opening_hours: 'CONTENT',
};

interface Fact { id: string; factType: string; value: string; capturedAt: string }

function isCurrent(payload: Record<string, unknown>): boolean {
  return payload.isCurrent === undefined || payload.isCurrent === true;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// --------------------------------------------------------------- main

export async function buildEvidenceRenderInput(
  options: BuildEvidenceRenderInputOptions,
): Promise<EvidenceRenderInputResult> {
  const evidence = parseExportedEvidence(options.evidence);
  const records = evidence.records;

  // ---- collect the current lead facts we understand (unknown factTypes are ignored, never invented)
  const factByType = new Map<string, Fact>();
  // The export's own timestamp is the deterministic clock (never wall-clock), so a given evidence
  // file always renders to a byte-identical bundle and stable hashes.
  const exportedAt = str(options.now) ?? evidence.exportedAt;
  for (const record of records) {
    if (record.sourceType !== 'lead_fact') continue;
    const payload = record.payload;
    if (!isCurrent(payload)) continue;
    const factType = str(payload.factType);
    const value = str(payload.value);
    if (!factType || !value || !(factType in FACT_RANK)) continue;
    const id = str(payload.id) ?? record.recordId;
    const capturedAt = str(payload.capturedAt) ?? exportedAt;
    // First current value wins deterministically (records already whitelisted + redacted).
    if (!factByType.has(factType)) factByType.set(factType, { id, factType, value, capturedAt });
  }

  const businessName = factByType.get('business_name')?.value;
  const officialWebsite = factByType.get('official_website_url')?.value
    ?? factByType.get('official_domain')?.value;
  if (!businessName || !officialWebsite) {
    throw new Error('demo_v2_evidence_render_missing_identity');
  }

  const now = str(options.now) ?? exportedAt;
  const artifactId = options.artifactId ?? `artifact-evidence-${evidence.leadId}`;
  const fixtureId = `evidence-${evidence.leadId}`;

  // ---- build the orchestration sources from whitelisted evidence -----------
  const sources: DemoV2FixtureInput['sources'] = [];
  const usedFactTypes: string[] = [];
  const serviceLabels: { raw: string; presented: string }[] = [];

  const overrides = options.serviceLabelOverrides ?? {};
  for (const fact of [...factByType.values()].sort((a, b) => (FACT_RANK[a.factType]! - FACT_RANK[b.factType]!))) {
    let value = fact.value;
    if (fact.factType === 'services') {
      // Present each verified service name with clean spacing; binding stays on the services fact.
      const presented = fact.value.split('|').map((raw) => {
        const trimmed = raw.trim();
        const cleaned = overrides[trimmed] ?? deGlueLabel(trimmed);
        if (trimmed !== '') serviceLabels.push({ raw: trimmed, presented: cleaned });
        return cleaned;
      }).filter((name) => name !== '');
      value = presented.join('|');
      if (value === '') continue;
    }
    const rank = FACT_RANK[fact.factType]!;
    sources.push({
      id: `ev-${String(rank).padStart(2, '0')}-${fact.factType}`,
      kind: 'LEAD_FACT',
      role: FACT_ROLE[fact.factType] ?? 'CONTENT',
      key: `fact.${fact.factType}`,
      value,
      capturedAt: fact.capturedAt,
      direct: true,
      accepted: true,
    });
    usedFactTypes.push(fact.factType);
  }

  // ---- language signal: only from a real captured `lang` record --------------
  const langRecord = records.find((record) =>
    record.sourceType === 'capture_evidence' && record.payload.evidenceType === 'lang'
    && str(record.payload.normalizedValue) !== null);
  if (langRecord) {
    sources.push({
      id: 'ev-05-lang',
      kind: 'CAPTURE_EVIDENCE',
      role: 'LANGUAGE',
      key: 'capture.lang',
      value: str(langRecord.payload.normalizedValue)!,
      capturedAt: now,
      direct: true,
      accepted: true,
    });
  }

  // ---- accepted audit findings (informational; never rendered as visitor text) ----
  const auditFindingsUsed: EvidenceRenderMeta['auditFindingsUsed'] = [];
  const auditFindingsExcluded: EvidenceRenderMeta['auditFindingsExcluded'] = [];
  for (const record of records) {
    if (record.sourceType !== 'audit_finding') continue;
    const payload = record.payload;
    const findingRef = str(payload.findingRef) ?? record.recordId;
    const observation = str(payload.observation);
    const category = str(payload.category) ?? 'GENERAL';
    const severity = str(payload.severity) ?? 'LOW';
    const safeForOutreach = payload.safeForOutreach === true;
    if (!safeForOutreach || !observation) {
      auditFindingsExcluded.push({ findingRef, reason: !safeForOutreach ? 'not safe for outreach' : 'no observation' });
      continue;
    }
    sources.push({
      id: `ev-audit-${findingRef}`,
      kind: 'AUDIT_FINDING',
      role: 'AUDIT',
      key: `audit.${findingRef.toLowerCase()}`,
      value: observation,
      capturedAt: now,
      direct: false,
      accepted: true,
    });
    auditFindingsUsed.push({ findingRef, category, severity, safeForOutreach });
  }

  // ---- illustrative asset pool: fictional first-party pages + fetch results ----
  const host = options.illustrativeHost.replace(/\/+$/, '');
  const assetUrl = (asset: IllustrativeAsset): string => `${host}/illustrative/${asset.key}.png`;
  const assetHtml = options.illustrativeAssets
    .map((asset) => `<section><img src="${assetUrl(asset)}" alt="${asset.altNative}"></section>`)
    .join('');
  const pages: DemoV2FixtureInput['pages'] = [{
    id: `${fixtureId}-home`,
    url: host,
    captureEvidenceId: null,
    html: `<html lang="de"><head></head><body><main>${assetHtml}</main></body></html>`,
  }];
  const assetFetchResults: DemoV2FixtureInput['assetFetchResults'] = Object.fromEntries(
    options.illustrativeAssets.map((asset) => [assetUrl(asset), {
      finalUrl: assetUrl(asset), redirectUrls: [] as string[], mimeType: 'image/png',
      bytes: asset.bytes.length, width: asset.width, height: asset.height, contentHash: sha256(asset.bytes),
    }]),
  );

  const orchestration = await orchestrateDemoV2Fixture({
    fixtureId,
    artifactId,
    sources,
    pages,
    officialWebsiteUrl: host,
    approvedCdnHosts: [],
    assetFetchResults,
    componentRegistry: { version: options.manifests.componentVersion, hash: options.manifests.componentHash },
    referenceLibrary: { version: options.manifests.referenceVersion, hash: options.manifests.referenceHash },
    now,
  });

  // ---- bind approved illustrative assets (hash-verified) ---------------------
  const bytesByHash = new Map<string, Buffer>(
    options.illustrativeAssets.map((asset) => [sha256(asset.bytes), asset.bytes]),
  );
  const assets: RenderAssetBinding[] = orchestration.selections.map((selection) => {
    const asset = orchestration.assets.find((candidate) => candidate.id === selection.assetId)!;
    const bytes = bytesByHash.get(asset.contentHash);
    if (!bytes) throw new Error(`demo_v2_evidence_render_asset_bytes_missing:${asset.id}`);
    // Explicit reuse approval for the ILLUSTRATIVE pool (disclosed as illustrative, never as real).
    return { selection, asset, bytes, reuseApproved: true };
  });

  // ---- deterministic, honest plan: a section only when evidence supports it ---
  const content = orchestration.content.package;
  const has = (prefix: string): boolean => content.items.some((item) =>
    item.contentKey.startsWith(prefix) && item.textValue !== null && item.textValue.trim() !== '');
  const interiorCategories: readonly AllowedAssetCategory[] = ['CLINIC_INTERIOR', 'EXTERIOR', 'HERO', 'LOCATION'];
  const hasInteriorAsset = options.illustrativeAssets.some((asset) => interiorCategories.includes(asset.category));
  const faqTopicCount = orchestration.content.faq.entries.length;

  const candidateSections: { family: string; include: boolean; reason: string }[] = [
    { family: 'disclosure', include: true, reason: 'mandatory' },
    { family: 'navigation', include: true, reason: 'mandatory' },
    { family: 'image-led hero', include: has('hero.heading'), reason: 'verified business name' },
    { family: 'appointment-actions', include: has('appointment.verified_method'), reason: 'verified appointment/contact channel' },
    { family: 'editorial treatment discovery', include: has('treatments.'), reason: 'verified treatment names' },
    { family: 'architecture or interior gallery', include: hasInteriorAsset || has('location.value'), reason: 'illustrative interior imagery or verified address' },
    { family: 'location and opening hours', include: has('location.value') || has('hours.value'), reason: 'verified address or hours' },
    { family: 'deterministic FAQ concierge', include: faqTopicCount > 0, reason: 'evidence-supported FAQ topics' },
    { family: 'final CTA', include: has('appointment.verified_method'), reason: 'verified appointment/contact channel' },
    { family: 'footer', include: true, reason: 'mandatory' },
  ];
  const planSections = candidateSections
    .filter((section) => section.include)
    .map((section, index) => ({ order: index + 1, componentFamily: section.family }));
  const omittedSections = candidateSections
    .filter((section) => !section.include)
    .map((section) => ({ componentFamily: section.family, reason: `omitted: no ${section.reason}` }));

  const referenceFamily = options.referenceFamily ?? orchestration.report.referenceFamily;

  const renderInput: RenderInput = {
    artifactId,
    referenceFamily,
    businessName,
    primary: content,
    // English is mock-prepared but never presented as human-reviewed here, so the render is
    // primary-language only (no unreviewed secondary language is offered).
    translation: orchestration.translation,
    translationReviewed: false,
    faq: orchestration.content.faq,
    planSections,
    teamVisualMode: 'text-only',
    assets,
    intelligenceHash: orchestration.intelligence.package.packageHash,
    creativeBriefHash: orchestration.creativeBrief.briefHash,
    experiencePlanHash: orchestration.experiencePlan.planHash,
    componentRegistryVersion: options.manifests.componentVersion,
    componentRegistryHash: options.manifests.componentHash,
    referenceLibraryVersion: options.manifests.referenceVersion,
    referenceLibraryHash: options.manifests.referenceHash,
    channels: {
      bookingUrl: factByType.get('booking_url')?.value ?? null,
      phone: factByType.get('phone')?.value ?? null,
      email: factByType.get('contact_email')?.value ?? null,
      whatsappUrl: null,
      locationUrl: factByType.get('official_location_page_url')?.value ?? null,
    },
    assetDisclosure: options.assetDisclosure,
  };

  const meta: EvidenceRenderMeta = {
    schemaVersion: evidence.schemaVersion,
    leadId: evidence.leadId,
    normalizedDomain: evidence.normalizedDomain,
    businessName,
    usedFactTypes,
    serviceLabels,
    auditFindingsUsed,
    auditFindingsExcluded,
    illustrativePool: options.illustrativeAssets.map((asset) => ({
      key: asset.key, category: asset.category, provenance: asset.provenance,
    })),
    placedAssetHashes: [], // filled by the caller after render (only placed assets are bundled)
    plannedSections: planSections,
    omittedSections,
    faqTopics: orchestration.content.faq.entries.map((entry) => entry.topic),
    faqOmittedTopics: orchestration.content.faq.omittedTopics,
    languageRendered: content.language,
    englishPrepared: orchestration.translation !== null,
    englishWithheldReason: orchestration.translation !== null
      ? 'English translation is mock-prepared and not human-reviewed; withheld from the render'
      : null,
  };

  // Guard: the illustrative asset category set must be a subset of the known categories.
  for (const asset of options.illustrativeAssets) {
    if (!ASSET_CATEGORIES.includes(asset.category)) {
      throw new Error(`demo_v2_evidence_render_unknown_asset_category:${asset.category}`);
    }
  }

  return { renderInput, orchestration, meta };
}
