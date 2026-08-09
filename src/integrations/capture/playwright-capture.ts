import { createRequire } from 'node:module';
import { type Logger } from 'pino';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { extractPage } from '../../domain/enrichment/extract.js';
import {
  type BrowserInfo,
  type CaptureError,
  type EmulationProfile,
  type RenderedCapture,
  type RenderedPage,
  type Screenshot,
} from '../../domain/capture/capture-types.js';
import { secondaryLinkCandidates, selectSecondaryTargets } from '../../domain/capture/page-selection.js';
import { assertUrlSafe, dnsResolveAll, type Resolver } from '../../utils/safe-fetch.js';
import { type BrowserCaptureProvider, type CaptureRequest } from './provider.js';
import { guardRequest } from './request-guard.js';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION: string = (require('playwright/package.json') as { version: string }).version;

// Neutralize page-script WebSocket / WebRTC (request interception cannot cover them).
const INIT_SCRIPT = `
  try { Object.defineProperty(window, 'WebSocket', { value: undefined }); } catch (e) {}
  try { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }); } catch (e) {}
  try { Object.defineProperty(window, 'webkitRTCPeerConnection', { value: undefined }); } catch (e) {}
`;

export interface PlaywrightCaptureOptions {
  logger: Logger;
  dockerImageTag: string | null;
  allowLoopback: boolean; // test-only: permit local fixture server
  chromiumSandbox: boolean; // in-process sandbox; off in the max-hardened container (D-0022)
}

/**
 * Real Playwright provider. Each capture uses a fresh browser; each profile a fresh
 * non-persistent context (serviceWorkers blocked, permissions denied, downloads
 * denied). Request interception enforces the network policy; main-frame origin is
 * checked against the VerifiedOriginPolicy. Full browser SSRF requires container
 * egress isolation (see docs/SECURITY.md).
 */
export class PlaywrightCaptureProvider implements BrowserCaptureProvider {
  readonly name = 'playwright';
  constructor(private readonly opts: PlaywrightCaptureOptions) {}

  private resolver(): Resolver {
    // Test-only: treat the local fixture host as a public address so the SSRF guard
    // permits it. 93.184.216.34 (example.com) is a real, non-reserved public IP.
    return this.opts.allowLoopback
      ? async (h) => (h === 'localhost' || h === '127.0.0.1' ? ['93.184.216.34'] : dnsResolveAll(h))
      : dnsResolveAll;
  }

  async capture(req: CaptureRequest): Promise<RenderedCapture> {
    const errors: CaptureError[] = [];
    // Chromium in-process sandbox. Playwright defaults `chromiumSandbox` to false
    // (i.e. --no-sandbox), so we opt in explicitly and make it configurable: it is
    // incompatible with the maximally-hardened container profile (--cap-drop ALL +
    // no-new-privileges), where the CONTAINER + network egress firewall are the
    // authoritative boundary (D-0017/D-0022) and this is set false. Where the runtime
    // grants the needed privileges it stays on as defense-in-depth. Default: on.
    const browser: Browser = await chromium.launch({
      chromiumSandbox: this.opts.chromiumSandbox,
      args: ['--disable-dev-shm-usage'],
    });
    const browserVersion = browser.version();
    const info: BrowserInfo = {
      playwrightVersion: PLAYWRIGHT_VERSION,
      browser: 'chromium',
      browserVersion,
      chromiumRevision: null,
      dockerImageTag: this.opts.dockerImageTag,
    };
    const rendered: RenderedPage[] = [];
    try {
      // Render primary in desktop first to discover secondary links.
      const primaryDesktop = await this.renderOne(browser, req, req.primary.url, req.profiles[0]!, errors, true);
      rendered.push(primaryDesktop);
      const secondary = primaryDesktop.ok
        ? selectSecondaryTargets(
            secondaryLinkCandidates(extractPage(primaryDesktop.html, req.primary.url, primaryDesktop.finalUrl, 200)).filter(
              (l) => req.originPolicy.isAllowedMainFrame(l.href).allowed,
            ),
            req.maxPages,
          )
        : [];
      // Primary mobile.
      rendered.push(await this.renderOne(browser, req, req.primary.url, req.profiles[1]!, errors, true));
      // Secondary pages in both profiles.
      for (const target of secondary) {
        for (const profile of req.profiles) {
          rendered.push(await this.renderOne(browser, req, target.url, profile, errors, false));
        }
      }
    } finally {
      await browser.close();
    }
    return { pages: rendered, errors, browser: info };
  }

  private async renderOne(
    browser: Browser,
    req: CaptureRequest,
    url: string,
    profile: EmulationProfile,
    errors: CaptureError[],
    isPrimary: boolean,
  ): Promise<RenderedPage> {
    const started = Date.now();
    const pageErrors: CaptureError[] = [];
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        userAgent: profile.userAgent,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        deviceScaleFactor: profile.deviceScaleFactor,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        bypassCSP: false,
        ignoreHTTPSErrors: false,
      });
      await context.addInitScript(INIT_SCRIPT);

      const page = await context.newPage();
      const resolver = this.resolver();
      await context.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        const decision = guardRequest(reqUrl, route.request().resourceType(), {
          blockTrackers: req.blockTrackers,
          blockMedia: req.blockMedia,
        });
        try {
          if (!decision.allow) {
            pageErrors.push({ pageUrl: reqUrl, profile: profile.profile, kind: 'blocked_request', detail: decision.reason });
            await route.abort();
            return;
          }
          let mainFrameNav = false;
          try {
            mainFrameNav = route.request().isNavigationRequest() && route.request().frame() === page.mainFrame();
          } catch {
            mainFrameNav = false; // frame already detached
          }
          if (mainFrameNav) {
            const origin = req.originPolicy.isAllowedMainFrame(reqUrl);
            if (!origin.allowed) {
              pageErrors.push({ pageUrl: reqUrl, profile: profile.profile, kind: 'cross_domain_redirect', detail: origin.reason });
              await route.abort();
              return;
            }
            await assertUrlSafe(reqUrl, resolver);
          }
          await route.continue();
        } catch {
          // Route already handled, frame gone, or blocked target — safe to ignore.
          try {
            await route.abort();
          } catch {
            /* already handled */
          }
        }
      });

      page.on('dialog', (d) => {
        pageErrors.push({ pageUrl: url, profile: profile.profile, kind: 'dialog_dismissed', detail: d.type() });
        void d.dismiss();
      });
      page.on('download', (d) => {
        pageErrors.push({ pageUrl: url, profile: profile.profile, kind: 'download_blocked', detail: d.suggestedFilename() });
        void d.delete();
      });
      context.on('page', (p) => {
        if (p !== page) {
          pageErrors.push({ pageUrl: url, profile: profile.profile, kind: 'popup_blocked', detail: p.url() });
          void p.close();
        }
      });
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push({ pageUrl: url, profile: profile.profile, kind: 'console_error', detail: m.text().slice(0, 300) });
      });
      page.on('requestfailed', (r) => {
        pageErrors.push({ pageUrl: r.url(), profile: profile.profile, kind: 'failed_request', detail: r.failure()?.errorText ?? 'failed' });
      });

      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: req.navigationTimeoutMs });
      const status = resp?.status() ?? 0;
      if (status === 401 || status === 407) pageErrors.push({ pageUrl: url, profile: profile.profile, kind: 'auth_required', detail: String(status) });

      const html = await page.content();
      // String-form evaluate avoids pulling the DOM lib into the Node type-check.
      const overflow = (await page.evaluate(
        '(() => { const e = document.scrollingElement || document.documentElement; return e.scrollWidth > e.clientWidth + 2; })()',
      )) as boolean;
      const shotBytes = await page.screenshot({ type: 'png' });
      const screenshots: Screenshot[] =
        shotBytes.length <= req.maxScreenshotBytes
          ? [{ profile: profile.profile, kind: 'viewport', bytes: Buffer.from(shotBytes), mime: 'image/png', width: profile.width, height: profile.height }]
          : [];

      errors.push(...pageErrors);
      const ok = status >= 200 && status < 400 && !pageErrors.some((e) => e.kind === 'cross_domain_redirect' || e.kind === 'auth_required');
      return {
        requestedUrl: url,
        finalUrl: page.url(),
        canonicalUrl: null,
        httpStatus: status,
        profile: profile.profile,
        ok,
        html,
        loadMs: Date.now() - started,
        hasHorizontalOverflow: overflow,
        screenshots,
        errors: pageErrors,
      };
    } catch (err) {
      const kind: CaptureError['kind'] = 'navigation_timeout';
      const e: CaptureError = { pageUrl: url, profile: profile.profile, kind, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) };
      errors.push(e);
      void isPrimary;
      return {
        requestedUrl: url,
        finalUrl: url,
        canonicalUrl: null,
        httpStatus: 0,
        profile: profile.profile,
        ok: false,
        html: '',
        loadMs: Date.now() - started,
        hasHorizontalOverflow: false,
        screenshots: [],
        errors: [e],
      };
    } finally {
      await context?.close();
    }
  }
}
