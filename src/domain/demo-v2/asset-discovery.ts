import * as cheerio from 'cheerio';
import { assertUrlSafe, type Resolver } from '../../utils/safe-fetch.js';
import { demoV2Hash } from './hash.js';
import {
  assetCandidateSchema,
  assetSelectionProposalSchema,
  type DemoV2AssetCandidate,
  type DemoV2AssetSelectionProposal,
} from './orchestration-types.js';

export interface AssetDiscoveryPage {
  id: string;
  url: string;
  html: string;
  captureEvidenceId: string | null;
}

export interface AssetFetchResult {
  finalUrl: string;
  redirectUrls: string[];
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  contentHash: string;
}

export interface DemoV2AssetFetchProvider {
  readonly name: 'mock';
  fetch(url: string): Promise<AssetFetchResult>;
}

export class MockDemoV2AssetFetchProvider implements DemoV2AssetFetchProvider {
  readonly name = 'mock' as const;
  constructor(private readonly results: ReadonlyMap<string, AssetFetchResult>) {}
  async fetch(url: string): Promise<AssetFetchResult> {
    const result = this.results.get(url);
    if (!result) throw new Error(`mock_asset_missing:${url}`);
    return result;
  }
}

interface DiscoveredUrl {
  url: string;
  method: DemoV2AssetCandidate['discoveryMethod'];
  altText: string | null;
  nearbyHeading: string | null;
  nearbyCaption: string | null;
}

function absolute(value: string, pageUrl: string): string | null {
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return null;
  }
}

function extractPageAssets(page: AssetDiscoveryPage): DiscoveredUrl[] {
  const $ = cheerio.load(page.html);
  const found: DiscoveredUrl[] = [];
  const push = (
    raw: string | undefined,
    method: DiscoveredUrl['method'],
    element?: Parameters<cheerio.CheerioAPI>[0],
  ): void => {
    if (!raw) return;
    const url = absolute(raw.trim(), page.url);
    if (!url) return;
    const el = element ? $(element) : null;
    const container = el?.closest('section, article, figure, header, main');
    found.push({
      url,
      method,
      altText: el?.attr('alt')?.trim() || null,
      nearbyHeading: container?.find('h1,h2,h3').first().text().replace(/\s+/g, ' ').trim() || null,
      // Scoped to the image's OWN figure. A caption belonging to a sibling figure describes a
      // different image, and letting it bleed across mis-classified unrelated photography.
      nearbyCaption: el?.closest('figure').find('figcaption,.caption').first().text().replace(/\s+/g, ' ').trim() || null,
    });
  };
  $('img[src]').each((_, element) => push($(element).attr('src'), 'IMG', element));
  $('img[srcset], source[srcset]').each((_, element) => {
    for (const candidate of ($(element).attr('srcset') ?? '').split(',')) {
      push(candidate.trim().split(/\s+/)[0], element.tagName === 'source' ? 'PICTURE' : 'SRCSET', element);
    }
  });
  $('[style*="background"]').each((_, element) => {
    const style = $(element).attr('style') ?? '';
    for (const match of style.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)) push(match[2], 'CSS_BACKGROUND', element);
  });
  push($('meta[property="og:image"]').attr('content'), 'OPEN_GRAPH');
  $('link[rel="preload"][as="image"], link[rel="image_src"]').each((_, element) =>
    push($(element).attr('href'), 'LINKED_MEDIA', element));
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text()) as unknown;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          for (const [key, child] of Object.entries(node)) {
            if ((key === 'image' || key === 'logo' || key === 'thumbnailUrl') && typeof child === 'string') {
              push(child, 'STRUCTURED_DATA');
            } else walk(child);
          }
        }
      };
      walk(value);
    } catch {
      // Invalid structured data is ignored as an asset source, never executed.
    }
  });
  return found;
}

function category(text: string): DemoV2AssetCandidate['category'] {
  const value = text.toLowerCase();
  if (/logo|brandmark/.test(value)) return 'LOGO';
  if (/doctor|dentist|dr\.|zahnarzt|médecin/.test(value)) return 'DOCTOR';
  if (/team|staff|équipe|צוות|فريق/.test(value)) return 'TEAM';
  if (/interior|reception|waiting|innen|cabinet|מרפאה|عيادة/.test(value)) return 'CLINIC_INTERIOR';
  if (/exterior|building|fassade|extérieur/.test(value)) return 'EXTERIOR';
  if (/equipment|scanner|microscope|gerät|équipement/.test(value)) return 'EQUIPMENT';
  if (/treatment|implant|orthodont|behandlung|soin/.test(value)) return 'TREATMENT';
  if (/location|map|standort|adresse/.test(value)) return 'LOCATION';
  if (/hero|banner/.test(value)) return 'HERO';
  return 'DECORATIVE';
}

function ownership(host: string, officialHost: string, cdnHosts: Set<string>): DemoV2AssetCandidate['ownership'] {
  if (host === officialHost || host.endsWith(`.${officialHost}`)) return 'FIRST_PARTY';
  if (cdnHosts.has(host)) return 'APPROVED_FIRST_PARTY_CDN';
  return 'THIRD_PARTY';
}

export async function discoverFirstPartyAssets(input: {
  pages: AssetDiscoveryPage[];
  officialWebsiteUrl: string;
  approvedCdnHosts: string[];
  provider: DemoV2AssetFetchProvider;
  resolver: Resolver;
  now: Date;
  maxBytes?: number;
  idNamespace?: string;
}): Promise<DemoV2AssetCandidate[]> {
  const official = await assertUrlSafe(input.officialWebsiteUrl, input.resolver);
  const cdnHosts = new Set(input.approvedCdnHosts.map((host) => host.toLowerCase()));
  const seenUrls = new Set<string>();
  const seenContent = new Set<string>();
  const assets: DemoV2AssetCandidate[] = [];

  for (const page of [...input.pages].sort((a, b) => a.url.localeCompare(b.url))) {
    for (const found of extractPageAssets(page)) {
      if (seenUrls.has(found.url)) continue;
      seenUrls.add(found.url);
      let initial: URL;
      try {
        initial = await assertUrlSafe(found.url, input.resolver);
      } catch {
        continue;
      }
      const initialOwnership = ownership(initial.hostname.toLowerCase(), official.hostname.toLowerCase(), cdnHosts);
      if (initialOwnership === 'THIRD_PARTY') continue;
      let fetched: AssetFetchResult;
      try {
        fetched = await input.provider.fetch(initial.toString());
      } catch {
        continue;
      }
      let blocked = false;
      for (const hop of [...fetched.redirectUrls, fetched.finalUrl]) {
        try {
          const safe = await assertUrlSafe(hop, input.resolver);
          if (ownership(safe.hostname.toLowerCase(), official.hostname.toLowerCase(), cdnHosts) === 'THIRD_PARTY') blocked = true;
        } catch {
          blocked = true;
        }
      }
      if (blocked || seenContent.has(fetched.contentHash)) continue;
      seenContent.add(fetched.contentHash);
      const final = new URL(fetched.finalUrl);
      const own = ownership(final.hostname.toLowerCase(), official.hostname.toLowerCase(), cdnHosts);
      const text = [found.altText, found.nearbyHeading, found.nearbyCaption, final.pathname].filter(Boolean).join(' ');
      let classified = category(text);
      const isSvg = /image\/svg\+xml/i.test(fetched.mimeType);
      const tooLarge = fetched.bytes > (input.maxBytes ?? 10_000_000);
      const tiny = fetched.width <= 20 || fetched.height <= 20;
      const photoTooSmall = classified !== 'LOGO' && (fetched.width < 480 || fetched.height < 270);
      const quality = isSvg || tooLarge || tiny || photoTooSmall ? 'UNSUITABLE' : 'SUITABLE';
      if (quality === 'UNSUITABLE') classified = 'UNSUITABLE';
      const base = {
        id: `asset-${demoV2Hash({
          namespace: input.idNamespace ?? 'default',
          page: page.id,
          url: found.url,
        }).slice(0, 16)}`,
        sourcePageUrl: page.url,
        directUrl: found.url,
        finalUrl: fetched.finalUrl,
        sourceEvidenceId: page.captureEvidenceId,
        mimeType: fetched.mimeType,
        byteSize: fetched.bytes,
        width: fetched.width,
        height: fetched.height,
        aspectRatio: fetched.width / fetched.height,
        altText: found.altText,
        nearbyHeading: found.nearbyHeading,
        nearbyCaption: found.nearbyCaption,
        contentHash: fetched.contentHash,
        ownership: own,
        availability: quality === 'SUITABLE' ? 'AVAILABLE' as const : 'BLOCKED' as const,
        quality,
        category: classified,
        discoveryMethod: found.method,
        discoveredAt: input.now.toISOString(),
      };
      assets.push(assetCandidateSchema.parse({ ...base, recordHash: demoV2Hash(base) }));
    }
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id));
}

const referencePriority: Record<string, DemoV2AssetCandidate['category'][]> = {
  'premium-dental-editorial': ['CLINIC_INTERIOR', 'HERO', 'DOCTOR', 'TEAM'],
  'warm-family-dental': ['TEAM', 'CLINIC_INTERIOR', 'HERO'],
  'advanced-specialist-clinic': ['DOCTOR', 'EQUIPMENT', 'TEAM', 'CLINIC_INTERIOR'],
  'modern-medical-minimal': ['CLINIC_INTERIOR', 'DOCTOR', 'EQUIPMENT'],
  'luxury-cosmetic-dental': ['CLINIC_INTERIOR', 'HERO', 'TREATMENT'],
};

export function proposeAssetSelections(
  assets: DemoV2AssetCandidate[],
  referenceFamily: string,
): DemoV2AssetSelectionProposal[] {
  const usable = assets.filter((asset) => asset.quality === 'SUITABLE' && asset.availability === 'AVAILABLE'
    && (asset.ownership === 'FIRST_PARTY' || asset.ownership === 'APPROVED_FIRST_PARTY_CDN'));
  const priorities = referencePriority[referenceFamily] ?? referencePriority['modern-medical-minimal']!;
  const selected: DemoV2AssetCandidate[] = [];
  for (const categoryName of priorities) {
    const asset = usable.find((candidate) => candidate.category === categoryName && !selected.includes(candidate));
    if (asset) selected.push(asset);
  }
  return selected.slice(0, 3).map((asset, index) => {
    const intendedSection = index === 0 ? 'image-led hero' : asset.category === 'TEAM' || asset.category === 'DOCTOR'
      ? 'team and specialist presentation' : 'architecture or interior gallery';
    const base = {
      id: `selection-${asset.id}`,
      selectionKey: `${intendedSection.replace(/\s+/g, '-')}-${String(index + 1)}`,
      assetId: asset.id,
      intendedSection,
      intendedUse: index === 0 ? 'primary narrative image' : 'supporting verified clinic imagery',
      desktopCrop: { mode: 'cover' as const, aspectRatio: index === 0 ? 1.8 : 1.4 },
      mobileCrop: { mode: 'cover' as const, aspectRatio: 0.9 },
      focalPoint: { x: 0.5, y: 0.5 },
      overlayGuidance: index === 0 ? 'Use a restrained solid scrim only when text contrast requires it.' : 'No text overlay.',
      contrastRequirement: 'WCAG AA text contrast when text is present.',
      fallbackBehavior: 'Use a layout without photography; never replace with unrelated third-party imagery.',
      justification: `Verified ${asset.category.toLowerCase().replace(/_/g, ' ')} supports ${referenceFamily} composition principles.`,
      boundAssetRecordHash: asset.recordHash,
      status: 'REUSE_REVIEW_REQUIRED' as const,
    };
    return assetSelectionProposalSchema.parse({ ...base, selectionHash: demoV2Hash(base) });
  });
}
