import { isIP } from 'node:net';
import { isBlockedIp } from '../../utils/ip-guard.js';

export interface RequestDecision {
  allow: boolean;
  reason: string;
}

const BLOCKED_RESOURCE_TRACKERS = /(googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|segment|mixpanel|fullstory)/i;

/**
 * Synchronous guard for browser subresource/main-frame requests, applied via
 * Playwright's route interception. Blocks non-HTTP(S), credentials, IP-literals in
 * blocked ranges, and (optionally) trackers/media. NOTE: full DNS-rebinding
 * protection for subresources is not achievable at this layer — container-level
 * egress isolation is the final boundary (see docs/SECURITY.md).
 */
export function guardRequest(
  rawUrl: string,
  resourceType: string,
  opts: { blockTrackers: boolean; blockMedia: boolean },
): RequestDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allow: false, reason: 'unparseable_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allow: false, reason: 'non_http' };
  if (url.username || url.password) return { allow: false, reason: 'credentials_in_url' };

  const literal = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(literal) && isBlockedIp(literal)) return { allow: false, reason: 'blocked_ip_literal' };

  if (opts.blockTrackers && BLOCKED_RESOURCE_TRACKERS.test(url.host)) {
    return { allow: false, reason: 'tracker_blocked' };
  }
  if (opts.blockMedia && (resourceType === 'media' || resourceType === 'font')) {
    // Fonts/media rarely affect layout evidence materially; never block CSS/images/JS.
    if (resourceType === 'media') return { allow: false, reason: 'media_blocked' };
  }
  return { allow: true, reason: 'ok' };
}
