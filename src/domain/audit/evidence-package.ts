export interface EvidenceRef {
  id: string;
  leadId: string;
  captureRunId: string;
  capturedPageId: string;
  profile: 'desktop' | 'mobile';
  evidenceType: string;
  sourceUrl: string | null;
  extractedValue: string | null;
  normalizedValue: string | null;
}

export interface EvidenceImage {
  id: string; // artifact id
  sha256: string;
  profile: 'desktop' | 'mobile';
  mediaType: string;
  dataBase64: string;
  role: 'primary';
  // Actual pixel dimensions of the (already bounded/resized) uploaded image. Required
  // for a deterministic vision-token estimate; null blocks the paid call.
  widthPx: number | null;
  heightPx: number | null;
}

export interface PackageFacts {
  businessName: string | null;
  category: string | null;
  city: string | null;
  officialDomain: string | null;
}

export interface EvidencePackage {
  leadId: string;
  captureRunId: string;
  facts: PackageFacts;
  evidence: EvidenceRef[];
  images: EvidenceImage[];
  allowedCanonicalUrls: Set<string>;
  versions: { extractor: string; emulation: string; pageSelection: string };
}

export interface BuildPackageInput {
  leadId: string;
  captureRunId: string;
  facts: PackageFacts;
  primaryUrl: string | null;
  evidence: EvidenceRef[];
  images: EvidenceImage[]; // caller supplies ONLY primary desktop+mobile viewport blobs
  versions: EvidencePackage['versions'];
  limits: { maxEvidence: number; maxSecondaryPages: number; maxEvidenceChars: number; maxImages: number };
}

const canonicalizeUrl = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
};

// Evidence noise never worth sending to the model.
const EXCLUDED_TYPES = new Set(['console_error']);

/**
 * Deterministic evidence-package builder. Selects only approved capture evidence,
 * dedups, preserves evidence IDs, caps size, prioritizes primary + conversion-related
 * evidence, and bounds secondary pages. Callers must NOT include Google-derived
 * context, cookies, storage, secrets, or full HTML — this builder only sees capture
 * evidence rows + primary screenshots.
 */
export function buildEvidencePackage(input: BuildPackageInput): EvidencePackage {
  const primaryCanonical = canonicalizeUrl(input.primaryUrl);
  const allowed = new Set<string>();
  if (primaryCanonical) allowed.add(primaryCanonical);

  // Rank: primary page first, then conversion-relevant types, then others.
  const conversionTypes = new Set(['cta', 'form', 'nav_label', 'tel', 'mailto', 'heading', 'horizontal_overflow']);
  const isPrimary = (e: EvidenceRef): boolean => canonicalizeUrl(e.sourceUrl) === primaryCanonical;

  const secondaryPages = new Set<string>();
  const seen = new Set<string>(); // dedup by (type|normalized|url)
  const ranked = [...input.evidence]
    .filter((e) => !EXCLUDED_TYPES.has(e.evidenceType))
    .sort((a, b) => rank(a) - rank(b));

  const selected: EvidenceRef[] = [];
  for (const e of ranked) {
    if (selected.length >= input.limits.maxEvidence) break;
    const key = `${e.evidenceType}|${e.normalizedValue ?? e.extractedValue ?? ''}|${canonicalizeUrl(e.sourceUrl) ?? ''}`;
    if (seen.has(key)) continue;
    const canon = canonicalizeUrl(e.sourceUrl);
    if (!isPrimary(e) && canon) {
      if (!secondaryPages.has(canon)) {
        if (secondaryPages.size >= input.limits.maxSecondaryPages) continue;
        secondaryPages.add(canon);
      }
    }
    seen.add(key);
    if (canon) allowed.add(canon);
    selected.push(truncate(e, input.limits.maxEvidenceChars));
  }

  function rank(e: EvidenceRef): number {
    let r = 0;
    if (!isPrimary(e)) r += 1000;
    if (!conversionTypes.has(e.evidenceType)) r += 100;
    return r;
  }

  return {
    leadId: input.leadId,
    captureRunId: input.captureRunId,
    facts: input.facts,
    evidence: selected,
    images: input.images.slice(0, input.limits.maxImages),
    allowedCanonicalUrls: allowed,
    versions: input.versions,
  };
}

function truncate(e: EvidenceRef, maxChars: number): EvidenceRef {
  return {
    ...e,
    extractedValue: e.extractedValue ? e.extractedValue.slice(0, maxChars) : e.extractedValue,
  };
}

/**
 * Reviewer package: only the evidence + images referenced by the proposed findings,
 * plus primary desktop/mobile context images. Records exactly what was sent.
 */
export function buildReviewerPackage(
  pkg: EvidencePackage,
  referencedEvidenceIds: Set<string>,
): EvidencePackage {
  const evidence = pkg.evidence.filter((e) => referencedEvidenceIds.has(e.id));
  return { ...pkg, evidence, images: pkg.images };
}

export { canonicalizeUrl };
