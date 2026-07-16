import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESKTOP_PROFILE, MOBILE_PROFILE } from '../../src/domain/capture/capture-types.js';
import { VerifiedOriginPolicy } from '../../src/domain/capture/verified-origin.js';
import { PlaywrightCaptureProvider } from '../../src/integrations/capture/playwright-capture.js';
import { type RenderedCapture } from '../../src/domain/capture/capture-types.js';

const HOME = `<!doctype html><html lang="en"><head><title>Fixture Dental</title>
<meta name="description" content="A local fixture site"></head>
<body>
  <h1>Fixture Dental</h1>
  <a href="/contact">Contact</a>
  <div style="width:1200px">wide element to force mobile overflow</div>
  <img src="https://www.google-analytics.com/collect.gif" alt="tracker">
  <script>
    document.body.insertAdjacentHTML('beforeend', '<div id="js">js-rendered</div>');
    console.error('boom-console-error');
    try { window.open('/popup', '_blank'); } catch (e) {}
    if (navigator.serviceWorker) { try { navigator.serviceWorker.register('/sw.js'); } catch (e) {} }
  </script>
</body></html>`;

function startServer(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/redirect') {
        res.writeHead(302, { Location: '/' });
        res.end();
      } else if (url === '/contact') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html lang="en"><head><title>Contact</title></head><body><h1>Contact us</h1><p>Call 0161 496 0000.</p></body></html>');
      } else if (url === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('self.addEventListener("fetch", () => {});');
      } else if (url === '/popup') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>popup</body></html>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HOME);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, base: `http://localhost:${port}` });
    });
  });
}

const skip = process.env.SKIP_BROWSER === '1';

describe.skipIf(skip)('PlaywrightCaptureProvider (real Chromium, local fixtures)', () => {
  let server: Server;
  let base: string;
  let provider: PlaywrightCaptureProvider;

  beforeAll(async () => {
    ({ server, base } = await startServer());
    provider = new PlaywrightCaptureProvider({ logger: pino({ level: 'silent' }), dockerImageTag: null, allowLoopback: true, chromiumSandbox: true });
  });
  afterAll(() => {
    server.close();
  });

  function req(primary: string): Parameters<PlaywrightCaptureProvider['capture']>[0] {
    return {
      primary: { url: primary, role: 'primary' },
      originPolicy: new VerifiedOriginPolicy({ officialDomain: null, officialWebsiteUrl: base, officialLocationPageUrl: null }),
      profiles: [DESKTOP_PROFILE, MOBILE_PROFILE],
      maxPages: 3,
      navigationTimeoutMs: 15000,
      totalTimeoutMs: 45000,
      maxScreenshotBytes: 5_000_000,
      fullPageMaxHeightPx: 20000,
      blockTrackers: true,
      blockMedia: true,
    };
  }

  it('renders desktop + mobile, executes JS, blocks trackers/popups, records console errors', async () => {
    const cap: RenderedCapture = await provider.capture(req(`${base}/`));
    expect(cap.browser.browser).toBe('chromium');
    expect(cap.browser.browserVersion).toBeTruthy();

    const primary = cap.pages.filter((p) => p.requestedUrl === `${base}/`);
    const desktop = primary.find((p) => p.profile === 'desktop');
    const mobile = primary.find((p) => p.profile === 'mobile');
    expect(desktop?.ok && mobile?.ok).toBe(true);
    expect(desktop?.html).toContain('js-rendered'); // JS executed
    expect(desktop?.screenshots.length).toBeGreaterThan(0);

    // Wide element overflows mobile (390) but not desktop (1440).
    expect(mobile?.hasHorizontalOverflow).toBe(true);
    expect(desktop?.hasHorizontalOverflow).toBe(false);

    const kinds = new Set(cap.pages.flatMap((p) => p.errors).map((e) => e.kind));
    expect(kinds.has('console_error')).toBe(true);
    expect(kinds.has('blocked_request')).toBe(true); // tracker aborted by the request guard
    // Popups are blocked (by our handler and/or Chromium) — the primary never navigates away.
    expect(desktop?.finalUrl).toBe(`${base}/`);
  });

  it('follows a same-origin redirect to the canonical page', async () => {
    const cap = await provider.capture(req(`${base}/redirect`));
    const desktop = cap.pages.find((p) => p.requestedUrl === `${base}/redirect` && p.profile === 'desktop');
    expect(desktop?.ok).toBe(true);
    expect(desktop?.finalUrl).toBe(`${base}/`);
  });
});
