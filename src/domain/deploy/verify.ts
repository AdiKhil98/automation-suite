import { sha256Hex } from '../../utils/hash.js';
import { validateRenderedHtml } from '../demo/demo-validation.js';
import { DEMO_URL_TOKEN } from '../email/email-types.js';

export interface VerifyInput {
  status: number;
  finalUrl: string;
  host: string;
  /** Response headers with lower-cased keys. */
  headers: Record<string, string>;
  fetchedHtml: string;
  /** The local approved artifact html (byte-for-byte expected). */
  localHtml: string;
  expectedHostname: string;
  /** The finalized (URL-resolved) email body. */
  resolvedEmailBody: string;
}

export interface VerifyResult {
  ok: boolean;
  violations: string[];
}

function hostAllowed(host: string, expected: string): boolean {
  const h = host.toLowerCase();
  const e = expected.toLowerCase();
  return h === e || h.endsWith(`--${e}`) || h.endsWith(`.${e}`);
}

/**
 * Deterministic verification of a deployed preview (fail-closed). Confirms the response is a
 * 200 over HTTPS from the expected Netlify hostname, that the served bytes match the approved
 * local artifact exactly, that the page still carries CSP + robots noindex and loads no
 * external scripts/forms/trackers, that the X-Robots-Tag header asserts noindex, and that the
 * finalized email no longer contains the {{DEMO_URL}} placeholder. Any mismatch fails.
 */
export function verifyDeployment(v: VerifyInput): VerifyResult {
  const violations: string[] = [];

  if (!/^https:\/\//i.test(v.finalUrl)) violations.push('not_https');
  if (!hostAllowed(v.host, v.expectedHostname)) violations.push(`unexpected_host:${v.host}`);
  if (v.status !== 200) violations.push(`status_not_200:${String(v.status)}`);

  if (sha256Hex(v.fetchedHtml) !== sha256Hex(v.localHtml)) violations.push('artifact_hash_mismatch');

  const content = validateRenderedHtml(v.fetchedHtml);
  for (const c of content.violations) violations.push(`content:${c}`);

  const xRobots = v.headers['x-robots-tag'] ?? '';
  if (!/noindex/i.test(xRobots)) violations.push('missing_x_robots_tag');

  if (v.resolvedEmailBody.includes(DEMO_URL_TOKEN)) violations.push('placeholder_remains');

  return { ok: violations.length === 0, violations };
}
