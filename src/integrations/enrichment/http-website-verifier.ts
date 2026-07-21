import { extractPage } from '../../domain/enrichment/extract.js';
import { scoreCandidate, type VerifyOptions } from '../../domain/enrichment/verify-domain.js';
import { type Candidate, type EnrichmentContext, type ExtractedPage } from '../../domain/enrichment/types.js';
import { safeGetHtml, type FetchOutcome, type SafeGetOptions } from '../../utils/safe-fetch.js';
import {
  type PageFetcher,
  type VerifyReport,
  type WebsiteVerificationAttempt,
  type WebsiteVerifier,
} from './provider.js';

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

function sanitizedUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function attemptFor(rawUrl: string, outcome: FetchOutcome): WebsiteVerificationAttempt {
  let hostname: string | null = null;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Invalid input is represented by the classification, never by raw text.
  }
  const d = outcome.diagnostic;
  const finalClassification =
    d?.finalClassification ??
    (outcome.kind === 'ok'
      ? 'OK'
      : outcome.kind === 'policy_blocked'
        ? 'POLICY_BLOCKED'
        : outcome.kind === 'invalid'
          ? 'INVALID'
          : 'TRANSIENT');
  return {
    candidateUrl: sanitizedUrl(rawUrl),
    hostname,
    attemptedAt: d?.attemptedAt ?? new Date(),
    finalClassification,
    failureStage: d?.failureStage ?? (outcome.kind === 'policy_blocked' ? 'POLICY' : 'UNKNOWN'),
    errorCode: d?.errorCode ?? null,
    httpStatus: d?.httpStatus ?? (outcome.kind === 'ok' ? outcome.status : null),
    redirectCount: d?.redirectCount ?? 0,
    elapsedMs: d?.elapsedMs ?? 0,
    resolvedIpFamily: d?.resolvedIpFamily ?? null,
    retryable: d?.retryable ?? outcome.kind === 'transient',
  };
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
    const report: VerifyReport = { verifications: [], fetchKinds: [], fetchAttempts: [] };

    for (const candidate of candidates) {
      const home = await this.fetcher.fetch(candidate.url);
      report.fetchKinds.push(home.kind);
      report.fetchAttempts.push(attemptFor(candidate.url, home));
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
        report.fetchAttempts.push(attemptFor(link.href, sub));
        if (sub.kind === 'ok') pages.push(extractPage(sub.html, link.href, sub.finalUrl, sub.status));
      }

      report.verifications.push(scoreCandidate(candidate, pages, context, this.config));
    }
    return report;
  }
}
