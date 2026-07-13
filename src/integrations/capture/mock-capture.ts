import { extractPage } from '../../domain/enrichment/extract.js';
import {
  type BrowserInfo,
  type CaptureError,
  type EmulationProfile,
  type RenderedCapture,
  type RenderedPage,
  type Screenshot,
} from '../../domain/capture/capture-types.js';
import { selectSecondaryTargets } from '../../domain/capture/page-selection.js';
import { type BrowserCaptureProvider, type CaptureRequest } from './provider.js';

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export interface MockPageSpec {
  html: string;
  httpStatus?: number;
  finalUrl?: string;
  canonicalUrl?: string | null;
  ok?: boolean;
  desktopOverflow?: boolean;
  mobileOverflow?: boolean;
  primaryError?: CaptureError['kind']; // e.g. 'bot_challenge' | 'auth_required'
}

const MOCK_BROWSER: BrowserInfo = {
  playwrightVersion: 'mock',
  browser: 'mock',
  browserVersion: 'mock',
  chromiumRevision: null,
  dockerImageTag: null,
};

/** Deterministic capture provider for tests + mock runs. No browser, no network. */
export class MockCaptureProvider implements BrowserCaptureProvider {
  readonly name = 'mock';
  constructor(private readonly pages: Map<string, MockPageSpec>) {}

  async capture(req: CaptureRequest): Promise<RenderedCapture> {
    const errors: CaptureError[] = [];
    const rendered: RenderedPage[] = [];

    const primarySpec = this.pages.get(req.primary.url);
    // Discover secondary same-origin, origin-allowed targets from the primary DOM.
    const secondary =
      primarySpec && primarySpec.ok !== false
        ? selectSecondaryTargets(
            extractPage(primarySpec.html, req.primary.url, primarySpec.finalUrl ?? req.primary.url, 200).sameOriginLinks.filter(
              (l) => req.originPolicy.isAllowedMainFrame(l.href).allowed,
            ),
            req.maxPages,
          )
        : [];

    const targets = [req.primary, ...secondary].slice(0, req.maxPages);
    for (const [index, target] of targets.entries()) {
      const spec = this.pages.get(target.url);
      for (const profile of req.profiles) {
        rendered.push(this.renderPage(target.url, target.role === 'primary', index === 0, spec, profile, errors));
      }
    }
    return { pages: rendered, errors, browser: MOCK_BROWSER };
  }

  private renderPage(
    url: string,
    _isPrimaryRole: boolean,
    isFirst: boolean,
    spec: MockPageSpec | undefined,
    profile: EmulationProfile,
    errors: CaptureError[],
  ): RenderedPage {
    if (!spec) {
      const err: CaptureError = { pageUrl: url, profile: profile.profile, kind: 'navigation_timeout', detail: 'mock: no page' };
      errors.push(err);
      return blank(url, profile, false, [err]);
    }
    if (isFirst && spec.primaryError) {
      const err: CaptureError = { pageUrl: url, profile: profile.profile, kind: spec.primaryError, detail: `mock: ${spec.primaryError}` };
      errors.push(err);
      return blank(url, profile, false, [err]);
    }
    if (spec.ok === false) {
      const err: CaptureError = { pageUrl: url, profile: profile.profile, kind: 'navigation_timeout', detail: 'mock: not ok' };
      return blank(url, profile, false, [err]);
    }
    const shot: Screenshot = {
      profile: profile.profile,
      kind: 'viewport',
      bytes: TINY_PNG,
      mime: 'image/png',
      width: profile.width,
      height: profile.height,
    };
    return {
      requestedUrl: url,
      finalUrl: spec.finalUrl ?? url,
      canonicalUrl: spec.canonicalUrl ?? null,
      httpStatus: spec.httpStatus ?? 200,
      profile: profile.profile,
      ok: true,
      html: spec.html,
      loadMs: 5,
      hasHorizontalOverflow: profile.profile === 'mobile' ? Boolean(spec.mobileOverflow) : Boolean(spec.desktopOverflow),
      screenshots: [shot],
      errors: [],
    };
  }
}

function blank(url: string, profile: EmulationProfile, ok: boolean, errs: CaptureError[]): RenderedPage {
  return {
    requestedUrl: url,
    finalUrl: url,
    canonicalUrl: null,
    httpStatus: 0,
    profile: profile.profile,
    ok,
    html: '',
    loadMs: 0,
    hasHorizontalOverflow: false,
    screenshots: [],
    errors: errs,
  };
}
