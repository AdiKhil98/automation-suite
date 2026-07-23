import { randomUUID } from 'node:crypto';
import { assertDemoV2Transition, type DemoV2ArtifactStatus } from './artifact-lifecycle.js';
import {
  discoverFirstPartyAssets,
  MockDemoV2AssetFetchProvider,
  proposeAssetSelections,
  type AssetDiscoveryPage,
  type AssetFetchResult,
} from './asset-discovery.js';
import {
  buildPrimaryContent,
  MockDemoV2TranslationProvider,
  prepareEnglishTranslation,
} from './content-orchestrator.js';
import {
  creativeInputFingerprint,
  DemoV2ModelBudget,
  MockDemoV2CreativeProvider,
  selectReferenceFamily,
} from './creative-orchestrator.js';
import { creativeBriefSchema } from './creative-brief.js';
import { experiencePlanSchema } from './experience-plan.js';
import { aggregateBindings, demoV2Hash } from './hash.js';
import {
  buildClinicIntelligence,
  type DemoV2RawSource,
} from './intelligence-builder.js';
import {
  orchestrationReportSchema,
  type DemoV2OrchestrationReport,
} from './orchestration-types.js';

export interface DemoV2FixtureInput {
  fixtureId: string;
  artifactId?: string;
  sources: Array<Omit<DemoV2RawSource, 'capturedAt'> & { capturedAt: string }>;
  pages: AssetDiscoveryPage[];
  officialWebsiteUrl: string;
  approvedCdnHosts: string[];
  assetFetchResults: Record<string, AssetFetchResult>;
  componentRegistry: { version: string; hash: string };
  referenceLibrary: { version: string; hash: string };
  now: string;
  version?: number;
}

export interface DemoV2OrchestrationOutput {
  intelligence: ReturnType<typeof buildClinicIntelligence>;
  content: ReturnType<typeof buildPrimaryContent>;
  translation: Awaited<ReturnType<typeof prepareEnglishTranslation>>;
  assets: Awaited<ReturnType<typeof discoverFirstPartyAssets>>;
  selections: ReturnType<typeof proposeAssetSelections>;
  creativeBrief: ReturnType<typeof creativeBriefSchema.parse>;
  experiencePlan: ReturnType<typeof experiencePlanSchema.parse>;
  report: DemoV2OrchestrationReport;
}

function lifecycle(): DemoV2ArtifactStatus[] {
  const sequence: DemoV2ArtifactStatus[] = [
    'INTELLIGENCE_PENDING', 'INTELLIGENCE_READY', 'CONTENT_PENDING', 'CONTENT_READY',
    'ASSET_REVIEW_PENDING', 'FOUNDATION_READY', 'BRIEF_READY', 'PLAN_READY',
    'HUMAN_REVIEW_REQUIRED',
  ];
  for (let index = 1; index < sequence.length; index += 1) {
    assertDemoV2Transition(sequence[index - 1]!, sequence[index]!);
  }
  return sequence;
}

export async function orchestrateDemoV2Fixture(input: DemoV2FixtureInput): Promise<DemoV2OrchestrationOutput> {
  const artifactId = input.artifactId ?? `artifact-${input.fixtureId}`;
  const version = input.version ?? 1;
  const intelligence = buildClinicIntelligence({
    id: `intelligence-${input.fixtureId}-v${String(version)}`,
    artifactId,
    version,
    sources: input.sources.map((source) => ({ ...source, capturedAt: new Date(source.capturedAt) })),
    now: new Date(input.now),
  });
  if (intelligence.package.status === 'BLOCKED') throw new Error('demo_v2_intelligence_blocked');

  const content = buildPrimaryContent({
    id: `content-${input.fixtureId}-v${String(version)}`,
    artifactId,
    intelligencePackageId: intelligence.package.id,
    intelligenceHash: intelligence.package.packageHash,
    intelligence: intelligence.data,
    version,
  });
  if (content.package.status !== 'READY') throw new Error('demo_v2_content_not_ready');

  const budget = new DemoV2ModelBudget(3);
  const translation = content.package.language === 'en' ? null : await budget.run({
    purpose: 'TRANSLATION',
    fingerprint: content.package.contentHash,
    model: 'gpt-5.6-terra',
    effort: 'medium',
    execute: () => prepareEnglishTranslation({
      id: `translation-${input.fixtureId}-v${String(version)}`,
      artifactId,
      primary: content.package,
      version,
      provider: new MockDemoV2TranslationProvider(),
    }),
  });

  const assetResults = new Map(Object.entries(input.assetFetchResults));
  const assets = await discoverFirstPartyAssets({
    pages: input.pages,
    officialWebsiteUrl: input.officialWebsiteUrl,
    approvedCdnHosts: input.approvedCdnHosts,
    provider: new MockDemoV2AssetFetchProvider(assetResults),
    resolver: async () => ['93.184.216.34'],
    now: new Date(input.now),
    idNamespace: `${input.fixtureId}-v${String(version)}`,
  });
  const catalogHash = aggregateBindings(assets.map((asset) => ({ id: asset.id, hash: asset.recordHash })));

  // ONE reference-family decision per orchestration. It is derived from the scoped positioning /
  // services / concerns / atmosphere assertions (never from a loose regex over the whole payload,
  // which let unrelated evidence text flip the family) and is then reused verbatim by the asset
  // selections, the Creative Brief, the ExperiencePlan, and the report.
  const referenceFamily = selectReferenceFamily(intelligence.data, assets);
  const selections = proposeAssetSelections(assets, referenceFamily);
  const inputFingerprint = creativeInputFingerprint({
    intelligenceHash: intelligence.package.packageHash,
    contentHash: content.package.contentHash,
    assetCatalogHash: catalogHash,
    selectionHashes: selections.map((selection) => selection.selectionHash),
    referenceFamily,
    componentRegistryHash: input.componentRegistry.hash,
    referenceLibraryHash: input.referenceLibrary.hash,
  });
  const creative = await budget.run({
    purpose: 'CREATIVE_ORCHESTRATION',
    fingerprint: inputFingerprint,
    model: 'gpt-5.6-sol',
    effort: 'high',
    execute: () => new MockDemoV2CreativeProvider().orchestrate({
      intelligence: intelligence.data,
      content: content.package,
      assets,
      selections,
      referenceFamily,
      componentRegistryHash: input.componentRegistry.hash,
      referenceLibraryHash: input.referenceLibrary.hash,
      inputFingerprint,
    }),
  });

  const creativeBrief = creativeBriefSchema.parse({
    id: `brief-${input.fixtureId}-v${String(version)}`,
    artifactId,
    clinicIntelligencePackageId: intelligence.package.id,
    primaryContentPackageId: content.package.id,
    assetCatalogId: `catalog-${input.fixtureId}-v${String(version)}`,
    version,
    schemaVersion: 'demo-v2-creative-1',
    status: 'VALIDATED',
    brief: creative.brief,
    inputFingerprint,
    briefHash: demoV2Hash(creative.brief),
  });
  const planFingerprint = demoV2Hash({
    briefHash: creativeBrief.briefHash,
    contentHash: content.package.contentHash,
    componentRegistryHash: input.componentRegistry.hash,
    referenceLibraryHash: input.referenceLibrary.hash,
  });
  const plan = { ...creative.plan, inputFingerprint: planFingerprint };
  const experiencePlan = experiencePlanSchema.parse({
    id: `plan-${input.fixtureId}-v${String(version)}`,
    artifactId,
    creativeBriefId: creativeBrief.id,
    primaryContentPackageId: content.package.id,
    version,
    schemaVersion: 'demo-v2-experience-plan-1',
    status: 'VALIDATED',
    primaryLanguage: content.package.language,
    primaryDirection: content.package.direction,
    supportedLanguages: content.package.language === 'en' ? ['en'] : [content.package.language, 'en'],
    componentRegistryVersion: input.componentRegistry.version,
    componentRegistryHash: input.componentRegistry.hash,
    referenceLibraryVersion: input.referenceLibrary.version,
    referenceLibraryHash: input.referenceLibrary.hash,
    plan,
    inputFingerprint: planFingerprint,
    planHash: demoV2Hash(plan),
  });

  const report = orchestrationReportSchema.parse({
    artifactId,
    providerState: 'MOCK_ONLY',
    factsUsed: intelligence.sources.filter((source) => source.accepted && !source.stale).map((source) => source.id),
    factsExcluded: intelligence.data.excludedSourceIds,
    contradictions: intelligence.data.contradictions,
    missingInformation: intelligence.data.missingInformation,
    languages: experiencePlan.supportedLanguages,
    contentKeys: content.package.items.map((item) => item.contentKey),
    faqTopics: content.faq.entries.map((entry) => entry.topic),
    faqOmittedTopics: content.faq.omittedTopics,
    assetCandidateIds: assets.map((asset) => asset.id),
    assetSelectionIds: selections.map((selection) => selection.id),
    referenceFamily,
    plannedSections: creative.plan.sections.map((section) => section.componentFamily),
    unsupportedClaimsBlocked: intelligence.data.prohibitedClaims,
    fingerprints: {
      intelligence: intelligence.package.inputFingerprint,
      content: content.package.sourceFingerprint,
      assets: catalogHash,
      creative: inputFingerprint,
      plan: planFingerprint,
    },
    modelCalls: budget.records,
    totalCostUsd: 0,
    lifecycle: lifecycle(),
  });
  return { intelligence, content, translation, assets, selections, creativeBrief, experiencePlan, report };
}

export function newFixtureId(): string {
  return randomUUID();
}
