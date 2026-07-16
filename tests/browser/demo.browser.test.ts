import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDemoContent } from '../../src/domain/demo/demo-content.js';
import { renderDemoHtml } from '../../src/domain/demo/template.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';

// Minimal browser-global shape (tsconfig lib is ES2023, no DOM). Types are erased at
// runtime; the callbacks run in the browser where these globals really exist.
type BrowserGlobals = { document: { documentElement: { scrollWidth: number; clientWidth: number } }; __xss?: number };

let idc = 0;
const fact = (factType: string, value: string): LeadFact => ({
  id: `f-${idc++}`, leadId: 'l', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
  sourceType: 'manual', sourceUrl: null, capturedAt: new Date(), confidence: 1, supersededBy: null, supersededAt: null, isCurrent: true,
});

// Phone lead → tel: CTA; malicious lead → XSS payload in the business name.
const goodHtml = renderDemoHtml(resolveDemoContent([fact('business_name', 'Zahnärzte am Ufer'), fact('city', 'Berlin'), fact('phone', '+49 30 1234567')]));
const malHtml = renderDemoHtml(resolveDemoContent([fact('business_name', '<script>window.__xss=1;alert(1)</script>"><img src=x onerror="window.__xss=1">'), fact('city', 'Berlin')]));

function startServer(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = (req.url ?? '/').startsWith('/mal') ? malHtml : goodHtml;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }));
  });
}

const skip = process.env.SKIP_BROWSER === '1';

describe.skipIf(skip)('demo site (real Chromium, local only)', () => {
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    ({ server, base } = await startServer());
    browser = await chromium.launch({ chromiumSandbox: true, args: ['--disable-dev-shm-usage'] });
  });
  afterAll(async () => {
    await browser.close();
    server.close();
  });

  for (const [profile, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]] as const) {
    it(`${profile}: renders, no overflow, CTA + disclosure visible, noindex present, no external requests`, async () => {
      const page = await browser.newPage({ viewport });
      const external: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });

      await page.goto(`${base}/good`, { waitUntil: 'load' });

      // No horizontal overflow.
      const overflow = await page.evaluate(() => {
        const de = (globalThis as unknown as BrowserGlobals).document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });
      expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(1);

      // Primary CTA visible + destination follows the verified-phone rule (tel:).
      const cta = page.locator('.cta');
      expect(await cta.isVisible()).toBe(true);
      expect(await cta.getAttribute('href')).toBe('tel:+49301234567');

      // Disclosure visible; noindex present; internal #contact target exists.
      expect(await page.getByText(/concept redesign/i).first().isVisible()).toBe(true);
      expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
      expect(await page.locator('#contact').count()).toBe(1);

      // No external trackers/scripts/resources were requested.
      expect(external, `external requests: ${external.join(', ')}`).toHaveLength(0);
      expect(await page.locator('script').count()).toBe(0);

      await page.close();
    });
  }

  it('malicious fact values cannot inject HTML or execute JavaScript', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let dialog = false;
    page.on('dialog', (d) => { dialog = true; void d.dismiss(); });
    await page.goto(`${base}/mal`, { waitUntil: 'load' });

    // No script executed: our injected global was never set, no dialog appeared.
    expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).__xss ?? 0)).toBe(0);
    expect(dialog).toBe(false);
    // No real <script> or <img onerror> element entered the DOM.
    expect(await page.locator('script').count()).toBe(0);
    expect(await page.locator('img').count()).toBe(0);
    // The payload is present only as inert, escaped text.
    expect(await page.content()).toContain('&lt;script&gt;');
    await page.close();
  });
});
