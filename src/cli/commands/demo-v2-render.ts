import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseComponentRegistry } from '../../domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2, type RenderResult, type TeamVisualMode } from '../../domain/demo-v2/render/renderer.js';
import { runQualityChecks, type QualityCheckResult } from '../../domain/demo-v2/render/quality-checks.js';
import { VIEWPORTS, type ViewportName } from '../../domain/demo-v2/render/design-system.js';
import {
  reviewPackageHash, reviewPackageSchema, reviewScreenshotSetHash,
  type ReviewScreenshot,
} from '../../domain/demo-v2/render/review-package.js';
import { demoV2Hash } from '../../domain/demo-v2/hash.js';
import type { Page } from 'playwright';
import { buildAcceptanceFixture } from '../../fixtures/demo-v2-render-fixture.js';
import { buildLanguageAcceptanceFixture, type AcceptanceLanguage } from '../../fixtures/demo-v2-multilang-fixture.js';

/**
 * Local-only operator commands. They render, preview, screenshot, and export a review package on
 * the local filesystem. Nothing here deploys, uploads, emails, schedules, or marks an artifact
 * deployment eligible, and no external service is contacted.
 */

const DEFAULT_OUT = './demos/demo-v2';

async function manifests() {
  const component = parseComponentRegistry(JSON.parse(await readFile('./design-library/component-registry.v1.json', 'utf8')) as unknown);
  const reference = parseReferenceLibrary(JSON.parse(await readFile('./design-library/reference-library.v1.json', 'utf8')) as unknown);
  return {
    componentVersion: component.manifest.version, componentHash: component.hash,
    referenceVersion: reference.manifest.version, referenceHash: reference.hash,
  };
}

export type RenderLanguage = 'de' | AcceptanceLanguage;

export interface RenderedBundle {
  outDir: string;
  language: RenderLanguage;
  render: RenderResult;
  quality: QualityCheckResult;
  brief: Record<string, unknown>;
  plan: Record<string, unknown>;
  artifactId: string;
  intelligenceHash: string;
  contentHash: string;
  translationHash: string | null;
  assetSelectionSetHash: string;
  creativeBriefHash: string;
  experiencePlanHash: string;
  componentRegistryHash: string;
  referenceLibraryHash: string;
  referenceFamily: string;
  /** DoctorFeature presentation used for this bundle; drives the review-package Team annotation. */
  teamVisualMode?: TeamVisualMode;
}

/** Render the fictional fixture to a local directory and run the deterministic checks. */
export async function renderFixtureBundle(options: {
  outDir?: string; referenceFamily?: string; language?: RenderLanguage; withEnglish?: boolean;
} = {}): Promise<RenderedBundle> {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT);
  const manifest = await manifests();
  const language: RenderLanguage = options.language ?? 'de';
  const { renderInput, orchestration } = language === 'de'
    // This fictional demo features the approved verified TEAM group photograph and intentionally
    // excludes the low-quality DOCTOR portrait (which read as a censored placeholder).
    ? await buildAcceptanceFixture(manifest, { referenceFamily: options.referenceFamily, teamVisualMode: 'group-photo' })
    : await buildLanguageAcceptanceFixture(language, manifest, { withEnglish: options.withEnglish });
  const render = renderDemoV2(renderInput);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'assets'), { recursive: true });
  for (const file of render.files) {
    await writeFile(join(outDir, file.path), file.bytes);
  }

  const quality = runQualityChecks({
    documents: render.documents,
    primaryLanguage: render.primaryLanguage,
    supportedLanguages: render.supportedLanguages,
    bundledAssetPaths: render.files.map((file) => file.path),
    expectedAnchors: render.sectionAnchors,
    faqTopicCount: renderInput.faq.entries.length,
  });

  return {
    outDir, language, render, quality,
    brief: orchestration.creativeBrief.brief as Record<string, unknown>,
    plan: orchestration.experiencePlan.plan as Record<string, unknown>,
    artifactId: renderInput.artifactId,
    intelligenceHash: renderInput.intelligenceHash,
    contentHash: renderInput.primary.contentHash,
    translationHash: orchestration.translation?.translationHash ?? null,
    assetSelectionSetHash: demoV2Hash([...orchestration.selections].map((s) => s.selectionHash).sort()),
    creativeBriefHash: renderInput.creativeBriefHash,
    experiencePlanHash: renderInput.experiencePlanHash,
    componentRegistryHash: manifest.componentHash,
    referenceLibraryHash: manifest.referenceHash,
    referenceFamily: renderInput.referenceFamily,
    teamVisualMode: renderInput.teamVisualMode ?? 'doctor-portrait',
  };
}

export async function demoV2RenderCommand(opts: { out?: string; family?: string }): Promise<void> {
  const bundle = await renderFixtureBundle({ outDir: opts.out, referenceFamily: opts.family });
  console.log('Demo V2 render (fictional fixture, local only):');
  console.log(`  output directory : ${bundle.outDir}`);
  console.log(`  reference family : ${bundle.referenceFamily}`);
  console.log(`  renderer version : ${bundle.render.rendererVersion}`);
  console.log(`  render hash      : ${bundle.render.renderHash}`);
  console.log(`  languages        : ${bundle.render.supportedLanguages.join(', ')}`);
  console.log(`  components       : ${bundle.render.componentIds.length}`);
  console.log(`  files            : ${bundle.render.files.length}`);
  console.log(`  quality blockers : ${bundle.quality.blockers.length}`);
  for (const blocker of bundle.quality.blockers) console.log(`    BLOCKER ${blocker.code} [${blocker.language}] ${blocker.detail}`);
  for (const finding of bundle.quality.issues.filter((issue) => issue.severity === 'FINDING')) {
    console.log(`    finding ${finding.code} [${finding.language}] ${finding.detail}`);
  }
  console.log(`  structurally eligible for later visual review: ${String(bundle.quality.structurallyEligible)}`);
  console.log('  NOTE: deterministic checks do not assess visual quality and never authorise deployment.');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
};

/** Loopback-only static server for the rendered bundle. Never binds a public interface. */
export function startPreviewServer(rootDir: string, port: number): Promise<{ server: Server; port: number }> {
  const root = resolve(rootDir);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const target = resolve(root, normalize(relative));
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    readFile(target).then((bytes) => {
      response.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        // Framing protection as an HTTP header (a <meta> CSP cannot carry frame-ancestors).
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
      }).end(bytes);
    }).catch(() => { response.writeHead(404).end('not found'); });
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({ server, port: typeof address === 'object' && address ? address.port : port });
    });
  });
}

export async function demoV2PreviewCommand(opts: { out?: string; port?: string }): Promise<void> {
  const dir = resolve(opts.out ?? DEFAULT_OUT);
  const { port } = await startPreviewServer(dir, Number.parseInt(opts.port ?? '4601', 10));
  console.log(`Demo V2 preview serving ${dir} on http://127.0.0.1:${String(port)}/ (loopback only).`);
  console.log('Press Ctrl+C to stop. Nothing is deployed or published.');
  await new Promise(() => { /* keep the process alive until interrupted */ });
}

export interface ScreenshotOutcome {
  screenshots: ReviewScreenshot[];
  screenshotSetHash: string;
  outDir: string;
}

/**
 * Capture desktop/tablet/mobile screenshots for every supported language plus the fictional
 * baseline, using the local preview server. Playwright is loaded lazily so the standard suite and
 * CLI do not require a browser.
 */
/**
 * Force every image — including lazy, below-the-fold approved assets — to load before a full-page
 * capture, so no screenshot ever records an approved asset as a blank placeholder box.
 */
async function ensureImagesLoaded(page: Page): Promise<void> {
  // String-form evaluate keeps this browser-side code out of the tsx/esbuild transform (which would
  // otherwise inject a `__name` helper that does not exist in the page context).
  const scrollHeight = Number(await page.evaluate('document.body.scrollHeight'));
  for (let y = 0; y <= scrollHeight; y += 600) {
    await page.evaluate(`window.scrollTo(0, ${String(y)})`);
    await page.waitForTimeout(30);
  }
  await page.evaluate('window.scrollTo(0, 0)');
  // Force any still-unloaded image (native lazy loading may not have fired) to fetch and decode.
  await page.evaluate(
    'Promise.all(Array.from(document.images).map(function(i){return i.complete?0:i.decode().catch(function(){return 0})}))',
  );
  await page.waitForLoadState('networkidle');
}

export async function captureScreenshots(bundle: RenderedBundle): Promise<ScreenshotOutcome> {
  const { chromium } = await import('playwright');
  const shotDir = join(bundle.outDir, 'screenshots');
  await mkdir(shotDir, { recursive: true });
  const { server, port } = await startPreviewServer(bundle.outDir, 0);
  const browser = await chromium.launch();
  const screenshots: ReviewScreenshot[] = [];
  try {
    const targets: { kind: 'ORIGINAL' | 'FINAL'; language: string; file: string }[] = [
      { kind: 'ORIGINAL', language: bundle.render.primaryLanguage, file: 'baseline.html' },
      ...bundle.render.documents.map((document) => ({
        kind: 'FINAL' as const, language: document.language, file: document.path,
      })),
    ];
    for (const target of targets) {
      for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
        const size = VIEWPORTS[viewport];
        const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${String(port)}/${target.file}?lang=${target.language}`, { waitUntil: 'load' });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        // A full-page capture must never record an approved asset as a blank box: lazy images below
        // the fold have not loaded at `load`. Scroll the whole page to trigger native lazy-loading,
        // force-decode every image, then return to the top before the screenshot.
        await ensureImagesLoaded(page);
        const name = `${target.kind.toLowerCase()}-${target.language}-${viewport.toLowerCase()}.png`;
        const path = join(shotDir, name);
        await page.screenshot({ path, fullPage: true });
        await context.close();
        const bytes = await readFile(path);
        screenshots.push({
          kind: target.kind, language: target.language, viewport,
          path: `screenshots/${name}`, width: size.width, height: size.height,
          fileHash: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return { screenshots, screenshotSetHash: reviewScreenshotSetHash(screenshots), outDir: shotDir };
}

/** Assemble the fail-closed review package for a rendered bundle + captured screenshots. */
export function buildReviewPackage(bundle: RenderedBundle, shots: ScreenshotOutcome) {
  return reviewPackageSchema.parse({
    schemaVersion: 'demo-v2-review-package-1',
    artifactId: bundle.artifactId,
    referenceFamily: bundle.referenceFamily,
    rendererVersion: bundle.render.rendererVersion,
    qualityRubricVersion: bundle.quality.rubricVersion,
    primaryLanguage: bundle.render.primaryLanguage,
    supportedLanguages: [...bundle.render.supportedLanguages],
    creativeBrief: bundle.brief,
    // The Team section explicitly records the team-visual decision for the reviewer: which approved
    // asset was featured and that the unusable portrait was intentionally excluded.
    experiencePlan: bundle.teamVisualMode === 'group-photo'
      ? {
          ...bundle.plan,
          teamVisual: {
            mode: 'group-photo',
            selected: 'approved verified TEAM group photograph',
            excluded: 'low-quality DOCTOR portrait intentionally excluded (not bundled, hashed, or counted)',
          },
        }
      : bundle.plan,
    hashes: {
      intelligence: bundle.intelligenceHash,
      content: bundle.contentHash,
      translation: bundle.translationHash,
      assets: [...bundle.render.usedAssetHashes],
      creativeBrief: bundle.creativeBriefHash,
      experiencePlan: bundle.experiencePlanHash,
      componentRegistry: bundle.componentRegistryHash,
      referenceLibrary: bundle.referenceLibraryHash,
      render: bundle.render.renderHash,
      screenshotSet: shots.screenshotSetHash,
      qualityRubric: bundle.quality.rubricHash,
    },
    screenshots: shots.screenshots,
    deterministicValidation: {
      structurallyEligible: bundle.quality.structurallyEligible,
      blockers: bundle.quality.blockers.map((issue) => ({ code: issue.code, detail: issue.detail, language: issue.language })),
      findings: bundle.quality.issues.filter((issue) => issue.severity === 'FINDING')
        .map((issue) => ({ code: issue.code, detail: issue.detail, language: issue.language })),
    },
    deploymentEligible: false,
  });
}

export async function demoV2ScreenshotsCommand(opts: { out?: string; family?: string; language?: RenderLanguage; noEnglish?: boolean; reviewPackage?: boolean }): Promise<void> {
  const bundle = await renderFixtureBundle({ outDir: opts.out, referenceFamily: opts.family, language: opts.language, withEnglish: !opts.noEnglish });
  const shots = await captureScreenshots(bundle);
  console.log(`Demo V2 screenshots (${bundle.language}) written to ${shots.outDir} (${String(shots.screenshots.length)} images, languages: ${bundle.render.supportedLanguages.join(', ')}).`);
  console.log(`  screenshot set hash: ${shots.screenshotSetHash}`);
  if (!opts.reviewPackage) return;

  const pkg = buildReviewPackage(bundle, shots);
  const path = join(bundle.outDir, 'review-package.json');
  await writeFile(path, `${JSON.stringify({ ...pkg, reviewPackageHash: reviewPackageHash(pkg) }, null, 2)}\n`, 'utf8');
  console.log(`  review package: ${path}`);
  console.log(`  review package hash: ${reviewPackageHash(pkg)}`);
  console.log('  deploymentEligible: false (no deployment or human approval is authorised).');
}

export async function demoV2RenderHashCommand(opts: { out?: string; family?: string }): Promise<void> {
  const bundle = await renderFixtureBundle({ outDir: opts.out, referenceFamily: opts.family });
  console.log(JSON.stringify({
    rendererVersion: bundle.render.rendererVersion,
    renderHash: bundle.render.renderHash,
    referenceFamily: bundle.referenceFamily,
    intelligenceHash: bundle.intelligenceHash,
    contentHash: bundle.contentHash,
    translationHash: bundle.translationHash,
    assetHashes: bundle.render.usedAssetHashes,
    componentRegistryHash: bundle.componentRegistryHash,
    referenceLibraryHash: bundle.referenceLibraryHash,
    qualityRubricHash: bundle.quality.rubricHash,
    structurallyEligible: bundle.quality.structurallyEligible,
  }, null, 2));
}
