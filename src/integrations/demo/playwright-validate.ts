import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';

/**
 * Post-render visual validation for a composed demo, run in a REAL headless Chromium on
 * loopback only (never public). Complements the deterministic string checks with checks
 * that only a live layout can prove: no horizontal overflow, the primary CTA is actually
 * visible (and points where expected), the contact anchor exists, the disclosure and
 * noindex are present, and NO external resource or script is loaded. This is a gate a demo
 * should pass before a human is asked to review it.
 */

export interface DemoVisualCheck {
  profile: 'desktop' | 'mobile';
  ok: boolean;
  violations: string[];
}

export interface DemoVisualOptions {
  /** Expected primary CTA href (exact match), if the caller wants to assert the destination. */
  expectedCtaHref?: string;
  chromiumSandbox?: boolean;
}

type BrowserGlobals = { document: { documentElement: { scrollWidth: number; clientWidth: number } } };

const VIEWPORTS = [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 844 }],
] as const;

function serveOnce(html: string): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }));
  });
}

export async function validateComposedDemo(html: string, opts: DemoVisualOptions = {}): Promise<DemoVisualCheck[]> {
  const { server, base } = await serveOnce(html);
  let browser: Browser | null = null;
  const results: DemoVisualCheck[] = [];
  try {
    browser = await chromium.launch({ chromiumSandbox: opts.chromiumSandbox ?? true, args: ['--disable-dev-shm-usage'] });
    for (const [profile, viewport] of VIEWPORTS) {
      const violations: string[] = [];
      const page = await browser.newPage({ viewport });
      const external: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });
      let dialog = false;
      page.on('dialog', (d) => { dialog = true; void d.dismiss(); });

      await page.goto(base, { waitUntil: 'load' });

      const overflow = await page.evaluate(() => {
        const de = (globalThis as unknown as BrowserGlobals).document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });
      if (overflow > 1) violations.push(`horizontal_overflow:${String(overflow)}`);

      const cta = page.locator('.cta').first();
      if ((await cta.count()) === 0 || !(await cta.isVisible())) violations.push('cta_not_visible');
      else if (opts.expectedCtaHref !== undefined) {
        const href = await cta.getAttribute('href');
        if (href !== opts.expectedCtaHref) violations.push(`cta_href_mismatch:${href ?? 'null'}`);
      }

      if ((await page.locator('#contact').count()) !== 1) violations.push('contact_anchor_missing');
      if (!(await page.getByText(/concept redesign/i).first().isVisible())) violations.push('disclosure_not_visible');
      const robots = await page.locator('meta[name="robots"]').getAttribute('content');
      if (!robots || !robots.includes('noindex')) violations.push('noindex_missing');
      if ((await page.locator('script').count()) !== 0) violations.push('script_present');
      if (external.length > 0) violations.push(`external_requests:${external.join(',')}`);
      if (dialog) violations.push('dialog_triggered');

      results.push({ profile, ok: violations.length === 0, violations });
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
  return results;
}
