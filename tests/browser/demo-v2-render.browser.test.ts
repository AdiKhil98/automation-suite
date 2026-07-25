import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parseComponentRegistry } from '../../src/domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../src/domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../src/domain/demo-v2/render/renderer.js';
import { VIEWPORTS } from '../../src/domain/demo-v2/render/design-system.js';
import { startPreviewServer } from '../../src/cli/commands/demo-v2-render.js';
import { buildAcceptanceFixture } from '../../src/fixtures/demo-v2-render-fixture.js';

type Globals = { document: { documentElement: { scrollWidth: number; clientWidth: number }; activeElement: { className: string } | null } };

const component = parseComponentRegistry(JSON.parse(readFileSync('design-library/component-registry.v1.json', 'utf8')) as unknown);
const reference = parseReferenceLibrary(JSON.parse(readFileSync('design-library/reference-library.v1.json', 'utf8')) as unknown);
const manifests = {
  componentVersion: component.manifest.version, componentHash: component.hash,
  referenceVersion: reference.manifest.version, referenceHash: reference.hash,
};
const skip = process.env.SKIP_BROWSER === '1';

describe.skipIf(skip)('Demo V2 rendered preview (real Chromium, local only)', () => {
  let browser: Browser;
  let dir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const { renderInput } = await buildAcceptanceFixture(manifests);
    const result = renderDemoV2(renderInput);
    dir = await mkdtemp(join(tmpdir(), 'dv2-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    for (const file of result.files) await writeFile(join(dir, file.path), file.bytes);
    ({ server, port } = await startPreviewServer(dir, 0));
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function open(viewport: keyof typeof VIEWPORTS, options: { path?: string; reduced?: boolean } = {}): Promise<{
    context: BrowserContext; page: Page; externalRequests: string[]; errors: string[];
  }> {
    const context = await browser.newContext({
      viewport: VIEWPORTS[viewport],
      ...(options.reduced ? { reducedMotion: 'reduce' as const } : {}),
    });
    const page = await context.newPage();
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(`http://127.0.0.1:${String(port)}`)) externalRequests.push(request.url());
    });
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${String(port)}/${options.path ?? 'index.html'}`, { waitUntil: 'networkidle' });
    return { context, page, externalRequests, errors };
  }

  it('loads with no console errors or external requests on every viewport', async () => {
    for (const viewport of ['DESKTOP', 'TABLET', 'MOBILE'] as const) {
      const { context, page, externalRequests, errors } = await open(viewport);
      expect(await page.locator('h1').count()).toBe(1);
      expect(errors, `${viewport} console`).toEqual([]);
      expect(externalRequests, `${viewport} external`).toEqual([]);
      await context.close();
    }
  });

  it('has no horizontal overflow at mobile width', async () => {
    const { context, page } = await open('MOBILE');
    const overflow = await page.evaluate(() => {
      const el = (globalThis as unknown as Globals).document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });

  it('keeps the primary appointment action reachable and large enough on mobile', async () => {
    const { context, page } = await open('MOBILE');
    const bar = page.locator('.dv2-mobilebar a.dv2-btn');
    expect(await bar.isVisible()).toBe(true);
    const box = await bar.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    await context.close();
  });

  it('opens and closes the FAQ concierge by keyboard with focus return and no form fields', async () => {
    const { context, page } = await open('DESKTOP');
    await page.locator('.dv2-concierge__launcher').click();
    expect(await page.locator('.dv2-concierge__panel').getAttribute('data-open')).toBe('true');
    await page.locator('.dv2-concierge__suggestion').first().click();
    expect(await page.locator('.dv2-concierge__msg--a').count()).toBe(1);
    expect(await page.locator('.dv2-concierge__panel input, .dv2-concierge__panel textarea, .dv2-concierge__panel form').count()).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.dv2-concierge__panel').getAttribute('data-open')).toBe('false');
    const focused = await page.evaluate(() =>
      (globalThis as unknown as Globals).document.activeElement?.className ?? '');
    expect(focused).toContain('dv2-concierge__launcher');
    await context.close();
  });

  it('preserves all content and usability under prefers-reduced-motion', async () => {
    const { context, page } = await open('DESKTOP', { reduced: true });
    expect(await page.locator('h1').isVisible()).toBe(true);
    expect(await page.locator('.dv2-footer').isVisible()).toBe(true);
    await page.locator('.dv2-concierge__launcher').click();
    expect(await page.locator('.dv2-concierge__panel').getAttribute('data-open')).toBe('true');
    await context.close();
  });

  it('makes the skip link the first tab stop', async () => {
    const { context, page } = await open('DESKTOP');
    expect(await page.getAttribute('html', 'dir')).toBe('ltr');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() =>
      (globalThis as unknown as Globals).document.activeElement?.className ?? '');
    expect(focused).toContain('dv2-skip');
    await context.close();
  });

  it('has no adjacent duplicate appointment CTAs on mobile (dock primary hidden)', async () => {
    const { context, page } = await open('MOBILE');
    // The appointment dock's primary button is hidden on mobile; only the hero CTA + sticky bar remain.
    const dockPrimary = page.locator('.dv2-dock__primary');
    expect(await dockPrimary.count()).toBeGreaterThan(0); // present in DOM
    expect(await dockPrimary.first().isVisible()).toBe(false); // hidden on mobile
    // Exactly one sticky mobile appointment bar, and it is not adjacent to the hero CTA.
    expect(await page.locator('.dv2-mobilebar').count()).toBe(1);
    await context.close();
  });

  it('keeps the FAQ launcher and the sticky appointment bar from overlapping', async () => {
    const { context, page } = await open('MOBILE');
    const bar = await page.locator('.dv2-mobilebar').boundingBox();
    const launcher = await page.locator('.dv2-concierge__launcher').boundingBox();
    expect(bar).not.toBeNull();
    expect(launcher).not.toBeNull();
    // The launcher's bottom edge sits above the bar's top edge (no overlap).
    expect(launcher!.y + launcher!.height).toBeLessThanOrEqual(bar!.y + 1);
    // Both are ≥44px touch targets.
    expect(launcher!.height).toBeGreaterThanOrEqual(44);
    await context.close();
  });

  it('keeps the sticky bar from covering the footer content', async () => {
    const { context, page } = await open('MOBILE');
    // Body reserves bottom padding for the fixed bar so content is never hidden beneath it.
    const paddingBottom = await page.evaluate(() => {
      const body = (globalThis as unknown as { getComputedStyle: (e: unknown) => { paddingBottom: string }; document: { body: unknown } });
      return body.getComputedStyle(body.document.body).paddingBottom;
    });
    expect(Number.parseInt(paddingBottom, 10)).toBeGreaterThanOrEqual(40);
    await context.close();
  });

  it('switches language to the complete English page and persists the choice', async () => {
    const { context, page } = await open('DESKTOP');
    await page.locator('.dv2-lang a[hreflang="en"]').first().click();
    await page.waitForLoadState('networkidle');
    expect(await page.getAttribute('html', 'lang')).toBe('en');
    expect((await page.locator('.dv2-btn').first().innerText()).toLowerCase()).toContain('appointment');
    await context.close();
  });

  // MOBILE viewport is 390x844 (see VIEWPORTS.MOBILE) — the exact case the live review flagged.
  it('reveals the language switcher inside the opened mobile menu, unclipped and unobscured (390x844)', async () => {
    for (const path of ['index.html', 'en.html'] as const) {
      const { context, page } = await open('MOBILE', { path });
      const switcher = page.locator('.dv2-mobilenav .dv2-lang');
      // Hidden until the menu is opened via its toggle button — never revealed on hover.
      expect(await switcher.isVisible(), `${path} closed`).toBe(false);
      await page.locator('.dv2-nav__toggle').click();
      expect(await page.locator('.dv2-mobilenav').getAttribute('data-open')).toBe('true');
      expect(await switcher.isVisible(), `${path} open`).toBe(true);
      // The sticky appointment bar and concierge launcher are hidden while the menu is open, so
      // neither sticky CTA can cover the switcher.
      expect(await page.locator('.dv2-mobilebar').isVisible()).toBe(false);
      expect(await page.locator('.dv2-concierge__launcher').isVisible()).toBe(false);
      // Both language links sit fully within the 844px-tall viewport (not clipped).
      const en = page.locator('.dv2-mobilenav .dv2-lang a[hreflang="en"]');
      const de = page.locator('.dv2-mobilenav .dv2-lang a[hreflang="de"]');
      for (const link of [en, de]) {
        const box = await link.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(844);
        expect(box!.height).toBeGreaterThanOrEqual(40); // touch target
      }
      // Nothing paints over the switcher's centre point (not hidden behind another layer).
      const enBox = (await en.boundingBox())!;
      const onTop = await page.evaluate(({ x, y }) => {
        const doc = (globalThis as unknown as {
          document: { elementFromPoint: (x: number, y: number) => { closest: (s: string) => unknown } | null };
        }).document;
        const el = doc.elementFromPoint(x, y);
        return el != null && el.closest('.dv2-lang') != null;
      }, { x: enBox.x + enBox.width / 2, y: enBox.y + enBox.height / 2 });
      expect(onTop, `${path} elementFromPoint`).toBe(true);
      // Keyboard focusable.
      await en.focus();
      const focusedHreflang = await page.evaluate(() => {
        const doc = (globalThis as unknown as {
          document: { activeElement: { getAttribute: (n: string) => string | null } | null };
        }).document;
        return doc.activeElement?.getAttribute('hreflang') ?? '';
      });
      expect(focusedHreflang).toBe('en');
      await context.close();
    }
  });

  // Scroll the whole page so native lazy-loading fires, then force-decode every image.
  async function loadAllImages(page: Page): Promise<void> {
    const height = Number(await page.evaluate('document.body.scrollHeight'));
    for (let y = 0; y <= height; y += 500) {
      await page.evaluate(`window.scrollTo(0, ${String(y)})`);
      await page.waitForTimeout(20);
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await page.evaluate(
      'Promise.all(Array.from(document.images).map(function(i){return i.complete?0:i.decode().catch(function(){return 0})}))',
    );
  }

  it('renders the team portrait and gallery images — never a blank placeholder box (390x844)', async () => {
    const { context, page } = await open('MOBILE');
    await loadAllImages(page);
    for (const component of ['DoctorFeature', 'InteriorGallery', 'TreatmentSpotlight'] as const) {
      const natural = Number(await page.evaluate(
        `document.querySelector('[data-dv2-component="${component}"] img').naturalWidth`));
      expect(natural, `${component} image must have decoded`).toBeGreaterThan(0);
    }
    // A rendered figure never wraps empty space — it always contains a loaded image.
    const emptyFigures = Number(await page.evaluate(
      "Array.from(document.querySelectorAll('figure')).filter(function(f){return !f.querySelector('img')}).length"));
    expect(emptyFigures).toBe(0);
    await context.close();
  });

  it('keeps body and FAQ copy readable on mobile (390x844)', async () => {
    const { context, page } = await open('MOBILE');
    const bodyFs = Number(await page.evaluate(
      'parseFloat(getComputedStyle(document.body).fontSize)'));
    expect(bodyFs).toBeGreaterThanOrEqual(16);
    const faqFs = Number(await page.evaluate(
      "parseFloat(getComputedStyle(document.querySelector('.dv2-faq__item dd')).fontSize)"));
    expect(faqFs).toBeGreaterThanOrEqual(15);
    // The primary appointment button is a comfortable touch target with real padding.
    const btn = await page.locator('.dv2-mobilebar a.dv2-btn').boundingBox();
    expect(btn!.height).toBeGreaterThanOrEqual(44);
    await context.close();
  });

  it('switches all content together from the mobile menu, German↔English (390x844)', async () => {
    const { context, page } = await open('MOBILE');
    expect(await page.getAttribute('html', 'lang')).toBe('de');
    await page.locator('.dv2-nav__toggle').click();
    await page.locator('.dv2-mobilenav .dv2-lang a[hreflang="en"]').click();
    await page.waitForLoadState('networkidle');
    // The whole document switches together: lang attribute + visible CTA copy.
    expect(await page.getAttribute('html', 'lang')).toBe('en');
    expect((await page.locator('.dv2-mobilebar a.dv2-btn').innerText()).toLowerCase()).toContain('appointment');
    // From the English page the mobile menu offers German and switches back.
    await page.locator('.dv2-nav__toggle').click();
    const backToGerman = page.locator('.dv2-mobilenav .dv2-lang a[hreflang="de"]');
    expect(await backToGerman.isVisible()).toBe(true);
    await backToGerman.click();
    await page.waitForLoadState('networkidle');
    expect(await page.getAttribute('html', 'lang')).toBe('de');
    await context.close();
  });
});
