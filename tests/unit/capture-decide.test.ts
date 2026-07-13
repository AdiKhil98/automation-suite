import { describe, expect, it } from 'vitest';
import { decideAuditOutcome } from '../../src/domain/capture/capture-service.js';
import { primaryAuditTarget, selectSecondaryTargets } from '../../src/domain/capture/page-selection.js';
import {
  type CaptureError,
  type RenderedCapture,
  type RenderedPage,
} from '../../src/domain/capture/capture-types.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';

const HTML = '<html><body><h1>Acme Dental</h1><p>Welcome to our Manchester dental practice, book today.</p></body></html>';

function page(url: string, profile: 'desktop' | 'mobile', ok: boolean, errors: CaptureError[] = []): RenderedPage {
  return {
    requestedUrl: url,
    finalUrl: url,
    canonicalUrl: null,
    httpStatus: ok ? 200 : 0,
    profile,
    ok,
    html: ok ? HTML : '',
    loadMs: 5,
    hasHorizontalOverflow: false,
    screenshots: [],
    errors,
  };
}

const cap = (pages: RenderedPage[], errors: CaptureError[] = []): RenderedCapture => ({
  pages,
  errors,
  browser: { playwrightVersion: 'x', browser: 'chromium', browserVersion: null, chromiumRevision: null, dockerImageTag: null },
});

const P = 'https://acme.example';

describe('decideAuditOutcome', () => {
  it('CAPTURED when both profiles render the primary', () => {
    const d = decideAuditOutcome(P, cap([page(P, 'desktop', true), page(P, 'mobile', true)]));
    expect(d.outcome).toBe('CAPTURED');
    expect(d.desktop && d.mobile).toBe(true);
  });
  it('PARTIAL_CAPTURE when a secondary page fails', () => {
    const d = decideAuditOutcome(P, cap([page(P, 'desktop', true), page(P, 'mobile', true), page(`${P}/contact`, 'desktop', false)]));
    expect(d.outcome).toBe('PARTIAL_CAPTURE');
  });
  it('single-profile primary → TRANSIENT_ERROR when the other failed transiently', () => {
    const err: CaptureError = { pageUrl: P, profile: 'mobile', kind: 'navigation_timeout', detail: 't' };
    const d = decideAuditOutcome(P, cap([page(P, 'desktop', true), page(P, 'mobile', false, [err])]));
    expect(d.outcome).toBe('TRANSIENT_ERROR');
  });
  it('routes bot challenge / auth / cross-domain', () => {
    const bot: CaptureError = { pageUrl: P, profile: 'desktop', kind: 'bot_challenge', detail: 'x' };
    expect(decideAuditOutcome(P, cap([page(P, 'desktop', false, [bot])])).outcome).toBe('BOT_CHALLENGE');
    const auth: CaptureError = { pageUrl: P, profile: 'desktop', kind: 'auth_required', detail: '401' };
    expect(decideAuditOutcome(P, cap([page(P, 'desktop', false, [auth])])).outcome).toBe('AUTH_REQUIRED');
    const xd: CaptureError = { pageUrl: P, profile: 'desktop', kind: 'cross_domain_redirect', detail: 'x' };
    expect(decideAuditOutcome(P, cap([page(P, 'desktop', false, [xd])])).outcome).toBe('POLICY_BLOCKED');
  });
  it('NO_RENDERABLE_CONTENT when the page has no meaningful text', () => {
    const blank: RenderedPage = { ...page(P, 'desktop', true), html: '<html><body></body></html>' };
    const blankM: RenderedPage = { ...page(P, 'mobile', true), html: '<html><body></body></html>' };
    expect(decideAuditOutcome(P, cap([blank, blankM])).outcome).toBe('NO_RENDERABLE_CONTENT');
  });
});

describe('page selection', () => {
  const fact = (t: string, v: string): LeadFact => ({
    id: t, leadId: 'L', factType: t as never, value: v, normalizedValue: v, sourceType: 'website', sourceUrl: null,
    capturedAt: new Date(), confidence: 1, supersededBy: null, supersededAt: null, isCurrent: true,
  });
  it('prioritises location page → website url → domain', () => {
    expect(primaryAuditTarget([fact('official_location_page_url', 'https://a.example/loc'), fact('official_website_url', 'https://a.example')])?.url).toBe('https://a.example/loc');
    expect(primaryAuditTarget([fact('official_website_url', 'https://a.example')])?.url).toBe('https://a.example');
    expect(primaryAuditTarget([fact('official_domain', 'a.example')])?.url).toBe('https://a.example');
    expect(primaryAuditTarget([])).toBeNull();
  });
  it('selects allowlisted secondary pages only', () => {
    const targets = selectSecondaryTargets(
      [{ href: 'https://a.example/contact', text: 'Contact' }, { href: 'https://a.example/random', text: 'Random' }],
      5,
    );
    expect(targets.map((t) => t.role)).toEqual(['contact']);
  });
});
