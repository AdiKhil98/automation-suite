import { getDomain, getSubdomain } from 'tldts';

export interface VerifiedOrigins {
  officialDomain: string | null;
  officialWebsiteUrl: string | null;
  officialLocationPageUrl: string | null;
}

export interface OriginDecision {
  allowed: boolean;
  reason: string;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return value.includes('://')
      ? new URL(value).host.toLowerCase()
      : value.toLowerCase().replace(/\/.*$/, '');
  } catch {
    return null;
  }
}

/**
 * Registrable-domain-aware (Public Suffix List) main-frame origin policy. Never uses
 * naive string suffix matching. Allows the exact verified origin, http→https on the
 * same host, apex↔www canonicalization within the verified registrable domain, and
 * exact Phase-4-verified branch URLs. Everything else requires manual review.
 */
export class VerifiedOriginPolicy {
  private readonly verifiedHosts: Set<string>;
  private readonly verifiedUrls: Set<string>;
  private readonly registrable: string | null;

  constructor(origins: VerifiedOrigins) {
    this.verifiedHosts = new Set(
      [hostOf(origins.officialDomain), hostOf(origins.officialWebsiteUrl), hostOf(origins.officialLocationPageUrl)].filter(
        (h): h is string => Boolean(h),
      ),
    );
    this.verifiedUrls = new Set(
      [origins.officialWebsiteUrl, origins.officialLocationPageUrl]
        .filter((u): u is string => Boolean(u))
        .map((u) => u.replace(/\/$/, '')),
    );
    const anchor = hostOf(origins.officialDomain) ?? [...this.verifiedHosts][0] ?? null;
    this.registrable = anchor ? (getDomain(anchor) ?? null) : null;
  }

  isAllowedMainFrame(rawUrl: string): OriginDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: 'unparseable_url' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { allowed: false, reason: 'non_http_protocol' };
    }
    const host = url.host.toLowerCase();

    if (this.verifiedUrls.has(url.toString().replace(/\/$/, ''))) {
      return { allowed: true, reason: 'exact_verified_url' };
    }
    if (this.verifiedHosts.has(host)) return { allowed: true, reason: 'exact_verified_host' };

    const reg = getDomain(host);
    if (!reg || reg !== this.registrable) {
      return { allowed: false, reason: 'different_registrable_domain' };
    }
    const sub = getSubdomain(host);
    if (sub === '' || sub === 'www') {
      return { allowed: true, reason: 'apex_www_canonicalization' };
    }
    return { allowed: false, reason: 'unverified_sibling_subdomain' };
  }
}
