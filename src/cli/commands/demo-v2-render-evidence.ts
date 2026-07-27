import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseComponentRegistry } from '../../domain/demo-v2/manifests/component-registry.js';
import { parseReferenceLibrary } from '../../domain/demo-v2/manifests/reference-library.js';
import { renderDemoV2 } from '../../domain/demo-v2/render/renderer.js';
import { runQualityChecks } from '../../domain/demo-v2/render/quality-checks.js';
import { demoV2Hash } from '../../domain/demo-v2/hash.js';
import {
  reviewPackageHash,
} from '../../domain/demo-v2/render/review-package.js';
import {
  buildEvidenceRenderInput,
  parseExportedEvidence,
  type IllustrativeAsset,
} from '../../domain/demo-v2/render/evidence-render-input.js';
import {
  CLINIC_PHOTO_SPECS, FICTIONAL_CLINIC_ASSET_PROVENANCE, fictionalClinicPhotos,
} from '../../fixtures/demo-v2-render-fixture.js';
import { buildReviewPackage, captureScreenshots, type RenderedBundle } from './demo-v2-render.js';

/**
 * Local-only operator command: render a private review bundle from an already-exported, redacted
 * evidence file. It reads ONLY the local export JSON — it opens no database connection, contacts no
 * business website, and calls no Sol, deployment, Gmail, email, or scheduling path. Imagery is the
 * tracked, synthetic illustrative pool, clearly disclosed as illustrative in the render itself.
 *
 * The rendered bundle, screenshots, and review package are written under a git-ignored `demos/`
 * directory and are never staged or committed.
 */

const DEFAULT_OUT = './demos/ku64-v2';

async function manifests() {
  const component = parseComponentRegistry(JSON.parse(await readFile('./design-library/component-registry.v1.json', 'utf8')) as unknown);
  const reference = parseReferenceLibrary(JSON.parse(await readFile('./design-library/reference-library.v1.json', 'utf8')) as unknown);
  return {
    componentVersion: component.manifest.version, componentHash: component.hash,
    referenceVersion: reference.manifest.version, referenceHash: reference.hash,
  };
}

/** The tracked synthetic illustrative image pool (the five design-library clinic photographs). */
function illustrativeAssetPool(): IllustrativeAsset[] {
  const photos = fictionalClinicPhotos();
  return CLINIC_PHOTO_SPECS.map((spec) => {
    const photo = photos[spec.key];
    return {
      key: spec.key,
      category: spec.category,
      altNative: spec.altDe,
      bytes: photo.bytes,
      width: photo.width,
      height: photo.height,
      provenance: FICTIONAL_CLINIC_ASSET_PROVENANCE,
    };
  });
}

/** Read the current business name from the export, for a business-named illustrative disclosure. */
function readBusinessName(evidence: ReturnType<typeof parseExportedEvidence>): string {
  for (const record of evidence.records) {
    if (record.sourceType !== 'lead_fact') continue;
    const payload = record.payload;
    if (payload.isCurrent === false) continue;
    if (payload.factType === 'business_name' && typeof payload.value === 'string' && payload.value.trim() !== '') {
      return payload.value;
    }
  }
  return 'the business';
}

export interface EvidenceRenderBundleResult {
  bundle: RenderedBundle;
  meta: Awaited<ReturnType<typeof buildEvidenceRenderInput>>['meta'];
}

/** Render an exported-evidence bundle to a local directory and run the deterministic checks. */
export async function renderEvidenceBundle(options: {
  evidencePath: string; outDir?: string; referenceFamily?: string;
}): Promise<EvidenceRenderBundleResult> {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT);
  const manifest = await manifests();
  const raw = JSON.parse(await readFile(resolve(options.evidencePath), 'utf8')) as unknown;
  const evidence = parseExportedEvidence(raw);
  const name = readBusinessName(evidence);

  const { renderInput, orchestration, meta } = await buildEvidenceRenderInput({
    evidence: raw,
    illustrativeAssets: illustrativeAssetPool(),
    illustrativeHost: 'https://illustrative-assets.example',
    manifests: manifest,
    referenceFamily: options.referenceFamily,
    assetDisclosure: {
      de: `Die auf dieser Seite gezeigten Bilder sind rein illustrativ. Sie stammen aus einer synthetischen `
        + `Bildbibliothek und zeigen weder ${name} noch dessen Räumlichkeiten oder Team.`,
      en: `The images on this page are purely illustrative. They come from a synthetic image library and do `
        + `not depict ${name}, its premises, or its staff.`,
    },
  });

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

  const bundle: RenderedBundle = {
    outDir,
    language: render.primaryLanguage as RenderedBundle['language'],
    render,
    quality,
    brief: orchestration.creativeBrief.brief as Record<string, unknown>,
    plan: orchestration.experiencePlan.plan as Record<string, unknown>,
    artifactId: renderInput.artifactId,
    intelligenceHash: renderInput.intelligenceHash,
    contentHash: renderInput.primary.contentHash,
    translationHash: null,
    assetSelectionSetHash: demoV2Hash([...orchestration.selections].map((s) => s.selectionHash).sort()),
    creativeBriefHash: renderInput.creativeBriefHash,
    experiencePlanHash: renderInput.experiencePlanHash,
    componentRegistryHash: manifest.componentHash,
    referenceLibraryHash: manifest.referenceHash,
    referenceFamily: renderInput.referenceFamily,
    teamVisualMode: 'text-only',
  };

  return {
    bundle,
    // The bundle only writes assets a section actually placed, so record the placed set for the report.
    meta: { ...meta, placedAssetHashes: [...render.usedAssetHashes] },
  };
}

export async function demoV2RenderEvidenceCommand(opts: {
  evidence: string; out?: string; family?: string; reviewPackage?: boolean;
}): Promise<void> {
  const { bundle, meta } = await renderEvidenceBundle({
    evidencePath: opts.evidence, outDir: opts.out, referenceFamily: opts.family,
  });
  console.log('Demo V2 render from exported evidence (local only):');
  console.log(`  business (from evidence) : ${meta.businessName}`);
  console.log(`  normalized domain        : ${meta.normalizedDomain}`);
  console.log(`  output directory         : ${bundle.outDir}`);
  console.log(`  reference family         : ${bundle.referenceFamily}`);
  console.log(`  render hash              : ${bundle.render.renderHash}`);
  console.log(`  language rendered        : ${bundle.render.primaryLanguage} (English prepared: ${String(meta.englishPrepared)}, withheld)`);
  console.log(`  services (presented)     : ${meta.serviceLabels.map((s) => s.presented).join(', ')}`);
  console.log(`  audit findings used      : ${meta.auditFindingsUsed.map((f) => `${f.findingRef}:${f.category}`).join(', ') || '(none)'}`);
  console.log(`  planned sections         : ${meta.plannedSections.map((s) => s.componentFamily).join(' → ')}`);
  console.log(`  omitted sections         : ${meta.omittedSections.map((s) => s.componentFamily).join(', ') || '(none)'}`);
  console.log(`  FAQ topics               : ${meta.faqTopics.join(', ') || '(none)'}`);
  console.log(`  illustrative assets      : ${meta.illustrativePool.length} in pool, ${meta.placedAssetHashes.length} placed`);
  console.log(`  quality blockers         : ${bundle.quality.blockers.length}`);
  for (const blocker of bundle.quality.blockers) console.log(`    BLOCKER ${blocker.code} [${blocker.language}] ${blocker.detail}`);
  for (const finding of bundle.quality.issues.filter((issue) => issue.severity === 'FINDING')) {
    console.log(`    finding ${finding.code} [${finding.language}] ${finding.detail}`);
  }
  console.log(`  structurally eligible for later visual review: ${String(bundle.quality.structurallyEligible)}`);

  // Always write the deterministic render report alongside the bundle (git-ignored demos/).
  const reportPath = join(bundle.outDir, 'render-report.json');
  await writeFile(reportPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`  render report            : ${reportPath}`);

  if (opts.reviewPackage) {
    const shots = await captureScreenshots(bundle);
    const pkg = buildReviewPackage(bundle, shots);
    const path = join(bundle.outDir, 'review-package.json');
    await writeFile(path, `${JSON.stringify({ ...pkg, reviewPackageHash: reviewPackageHash(pkg) }, null, 2)}\n`, 'utf8');
    console.log(`  screenshots              : ${shots.screenshots.length} (${shots.outDir})`);
    console.log(`  review package           : ${path}`);
    console.log(`  review package hash      : ${reviewPackageHash(pkg)}`);
  }
  console.log('  NOTE: private/local only. deploymentEligible:false. Nothing was deployed, sent, or approved.');
}
