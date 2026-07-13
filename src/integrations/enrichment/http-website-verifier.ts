import { extractPage } from '../../domain/enrichment/extract.js';
import { scoreCandidate, type VerifyOptions } from '../../domain/enrichment/verify-domain.js';
import { type Candidate, type EnrichmentContext, type ExtractedPage } from '../../domain/enrichment/types.js';
import { safeGetHtml, type FetchOutcome, type SafeGetOptions } from '../../utils/safe-fetch.js';
import { type PageFetcher, type VerifyReport, type WebsiteVerifier } from './provider.js';

/** Real page fetcher backed by the SSRF-hardened GET. */
export class SafeHttpPageFetcher implements PageFetcher {
  constructor(private readonly opts: SafeGetOptions) {}
  fetch(url: string): Promise<FetchOutcome> {
    return safeGetHtml(url, this.opts);
  }
}

export interface VerifierConfig extends VerifyOptions {
  maxPages: number;
}

/**
 * Verifies candidate URLs deterministically: bounded same-origin crawl (homepage +
 * allowlisted contact/about/location pages, capped), cheerio extraction, then
 * scoreCandidate. Network I/O only via the injected PageFetcher.
 */
export class HttpWebsiteVerifier implements WebsiteVerifier {
  constructor(
    private readonly fetcher: PageFetcher,
    private readonly config: VerifierConfig,
  ) {}

  async verify(candidates: Candidate[], context: EnrichmentContext): Promise<VerifyReport> {
    const report: VerifyReport = { verifications: [], fetchKinds: [] };

    for (const candidate of candidates) {
      const home = await this.fetcher.fetch(candidate.url);
      report.fetchKinds.push(home.kind);
      if (home.kind !== 'ok') continue;

      const pages: ExtractedPage[] = [extractPage(home.html, candidate.url, home.finalUrl, home.status)];

      // Bounded same-origin crawl of allowlisted contact/about/location links.
      const links = pages[0]?.sameOriginLinks ?? [];
      const seen = new Set<string>([home.finalUrl]);
      for (const link of links) {
        if (pages.length >= this.config.maxPages) break;
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        const sub = await this.fetcher.fetch(link.href);
        report.fetchKinds.push(sub.kind);
        if (sub.kind === 'ok') pages.push(extractPage(sub.html, link.href, sub.finalUrl, sub.status));
      }

      report.verifications.push(scoreCandidate(candidate, pages, context, this.config));
    }
    return report;
  }
}
