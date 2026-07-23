import { demoV2Hash } from './hash.js';
import {
  creativeBriefDataSchema,
  experiencePlanDataSchema,
  type ClinicIntelligenceData,
  type CreativeBriefData,
  type DemoV2AssetCandidate,
  type DemoV2AssetSelectionProposal,
  type ExperiencePlanData,
} from './orchestration-types.js';
import { type PrimaryContentPackage } from './content-package.js';

export interface DemoV2ModelCallRecord {
  purpose: 'TRANSLATION' | 'CREATIVE_ORCHESTRATION';
  provider: 'mock';
  requestedModel: string;
  resolvedModel: string;
  reasoningEffort: 'medium' | 'high';
  costUsd: 0;
  usage: { inputTokens: 0; outputTokens: 0; totalTokens: 0 };
  responseId: string;
  cached: boolean;
}

export class DemoV2ModelBudget {
  private readonly cache = new Map<string, unknown>();
  private readonly counts = new Map<string, number>();
  readonly records: DemoV2ModelCallRecord[] = [];
  constructor(readonly maxCostUsd = 3) {}

  async run<T>(input: {
    purpose: DemoV2ModelCallRecord['purpose'];
    fingerprint: string;
    model: string;
    effort: DemoV2ModelCallRecord['reasoningEffort'];
    execute: () => Promise<T>;
  }): Promise<T> {
    const key = `${input.purpose}:${input.model}:${input.effort}:${input.fingerprint}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.records.push({
        purpose: input.purpose, provider: 'mock', requestedModel: input.model, resolvedModel: input.model,
        reasoningEffort: input.effort, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responseId: `mock-cache-${input.fingerprint.slice(0, 12)}`, cached: true,
      });
      return cached as T;
    }
    const count = this.counts.get(input.purpose) ?? 0;
    if (count >= 1) throw new Error(`demo_v2_model_call_budget_exceeded:${input.purpose}`);
    if (this.records.reduce((sum, record) => sum + record.costUsd, 0) > this.maxCostUsd) {
      throw new Error('demo_v2_cost_budget_exceeded');
    }
    const result = await input.execute();
    this.counts.set(input.purpose, count + 1);
    this.cache.set(key, result);
    this.records.push({
      purpose: input.purpose, provider: 'mock', requestedModel: input.model, resolvedModel: input.model,
      reasoningEffort: input.effort, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      responseId: `mock-${input.purpose.toLowerCase()}-${input.fingerprint.slice(0, 12)}`, cached: false,
    });
    return result;
  }
}

export interface DemoV2CreativeOrchestrationInput {
  intelligence: ClinicIntelligenceData;
  content: PrimaryContentPackage;
  assets: DemoV2AssetCandidate[];
  selections: DemoV2AssetSelectionProposal[];
  /** Selected ONCE by the caller via {@link selectReferenceFamily} and reused verbatim by the
   * asset-selection proposals, the Creative Brief, the ExperiencePlan, and the report. A provider
   * must never recompute it: divergent families would bind selections to the wrong composition. */
  referenceFamily: string;
  componentRegistryHash: string;
  referenceLibraryHash: string;
  inputFingerprint: string;
}

export interface DemoV2CreativeProvider {
  readonly name: 'mock';
  orchestrate(input: DemoV2CreativeOrchestrationInput): Promise<{ brief: CreativeBriefData; plan: ExperiencePlanData }>;
}

export function selectReferenceFamily(
  intelligence: ClinicIntelligenceData,
  assets: DemoV2AssetCandidate[],
): string {
  // Only the assertion VALUES inform design direction. Serializing the whole objects would also
  // scan keys and source IDs, letting an identifier such as "premium-german-dental-positioning"
  // silently decide the composition.
  const text = [
    ...intelligence.positioning,
    ...intelligence.services,
    ...intelligence.audienceConcerns,
    ...intelligence.atmosphereCues,
  ].map((assertion) => assertion.value).join(' ').toLowerCase();
  const suitable = new Set(assets.filter((asset) => asset.quality === 'SUITABLE').map((asset) => asset.category));
  if (/family|children|kinder|enfant/.test(text)) return 'warm-family-dental';
  if (/cosmetic|ästhet|esthétique|luxury|premium/.test(text) && suitable.has('CLINIC_INTERIOR')) return 'luxury-cosmetic-dental';
  if (/specialist|implant|surgery|chirurg|advanced/.test(text) && (suitable.has('DOCTOR') || suitable.has('EQUIPMENT'))) {
    return 'advanced-specialist-clinic';
  }
  if (suitable.has('CLINIC_INTERIOR') || /architecture|interior|architektur/.test(text)) return 'premium-dental-editorial';
  return 'modern-medical-minimal';
}

export class MockDemoV2CreativeProvider implements DemoV2CreativeProvider {
  readonly name = 'mock' as const;
  async orchestrate(input: DemoV2CreativeOrchestrationInput): Promise<{ brief: CreativeBriefData; plan: ExperiencePlanData }> {
    // The family is chosen once upstream; recomputing it here is what previously allowed the
    // brief and the asset selections to disagree.
    const reference = input.referenceFamily;
    const sourceIds = input.intelligence.availableEvidence.map((source) => source.id);
    const primaryConversion = input.intelligence.appointmentMethods.length > 0
      ? 'Use the verified appointment method'
      : 'Use a verified contact channel';
    const brief = creativeBriefDataSchema.parse({
      audiences: input.intelligence.audienceConcerns.length > 0
        ? input.intelligence.audienceConcerns.map((concern) => concern.value)
        : ['People evaluating the clinic using verified information'],
      primaryConversion,
      secondaryConversions: ['Understand verified services', 'Find location and opening information'],
      positioning: input.intelligence.positioning[0]?.value ?? 'Evidence-led clinic presentation',
      coreMessage: 'Make verified clinic information easy to understand and act on.',
      strategicAngle: 'Reduce uncertainty between initial interest and the verified appointment path.',
      emotionalTone: reference === 'warm-family-dental' ? ['welcoming', 'reassuring'] : ['calm', 'credible'],
      artDirection: `Apply ${reference} composition principles with verified first-party imagery only.`,
      typographyDirection: 'Editorial hierarchy with resilient wrapping for long German and French strings.',
      colorRoleDirection: 'Use restrained role-based colors with accessible contrast; do not infer brand colors.',
      imageryDirection: input.selections.length > 0
        ? 'Prioritize approved first-party clinic, team, or specialist context according to the selected family.'
        : 'Use typography and spacing; do not introduce substitute stock photography.',
      layoutPrinciples: ['Vary section rhythm by purpose', 'Keep the appointment path visible', 'Avoid filler and dominant card grids'],
      interactionDirection: 'Use interaction only to clarify navigation, language choice, or the appointment path.',
      conversionStrategy: primaryConversion,
      multilingualConsiderations: input.content.language === 'en'
        ? ['English is the primary package']
        : ['Show a visible English switcher', 'Fall back completely to the primary package until English is human-approved'],
      mobilePriorities: ['Persistent appointment access', 'Readable contact and hours information', 'No horizontal overflow'],
      accessibilityPriorities: ['WCAG AA contrast', 'Logical heading order', 'Keyboard-operable controls', 'Meaningful alt text'],
      prohibitedClaims: input.intelligence.prohibitedClaims,
      prohibitedVisualPatterns: [
        'empty gradient heroes', 'repeated icon cards', 'invented testimonials',
        'invented statistics or staff', 'decorative motion without purpose', 'filler sections',
      ],
      selectedReferenceFamily: reference,
      evidenceSourceIds: sourceIds,
      inputFingerprint: input.inputFingerprint,
    });

    const supportedLanguages: Array<'de' | 'en' | 'fr' | 'he' | 'ar'> =
      input.content.language === 'en' ? ['en'] : [input.content.language, 'en'];
    const keySet = new Set(input.content.items.map((item) => item.contentKey));
    const selectionBySection = new Map(input.selections.map((selection) => [selection.intendedSection, selection]));
    const sections: ExperiencePlanData['sections'] = [];
    const add = (
      family: string,
      purpose: string,
      conversionRole: string,
      keys: string[],
      finding: string | null = null,
    ): void => {
      const availableKeys = keys.filter((key) => keySet.has(key));
      if (availableKeys.length === 0 && !['disclosure', 'language-switcher'].includes(family)) return;
      const selection = selectionBySection.get(family);
      sections.push({
        order: sections.length + 1,
        sectionPurpose: purpose,
        conversionRole,
        componentFamily: family,
        componentVariant: `${family}-v1`,
        requiredContentKeys: availableKeys,
        selectedClaimSourceIds: sourceIds.slice(0, 6),
        selectedAssetCategories: selection ? [input.assets.find((asset) => asset.id === selection.assetId)?.category ?? 'DECORATIVE'] : [],
        proposedAssetSelectionIds: selection ? [selection.id] : [],
        visualTreatment: selection ? 'Image-led composition with evidence-bound copy.' : 'Typography-led composition.',
        motionPreset: family === 'navigation' || family === 'appointment-actions' ? 'NONE' : 'PURPOSEFUL_REVEAL',
        desktopBehavior: 'Preserve hierarchy and readable line lengths.',
        mobileBehavior: family === 'appointment-actions' ? 'Remain easily accessible without covering content.' : 'Stack without horizontal overflow.',
        accessibilityRequirements: ['Keyboard access', 'Visible focus', 'Semantic heading order'],
        supportedLanguages,
        auditFindingAddressed: finding,
        fallbackBehavior: 'Omit unsupported content and preserve the conversion path.',
        justification: `${purpose} is supported by available content and has a distinct role.`,
      });
    };
    add('disclosure', 'Identify the page as a review concept.', 'Set accurate expectations.', ['disclosure.text']);
    add('navigation', 'Orient visitors to verified clinic information.', 'Expose the appointment path.', ['navigation.treatments', 'navigation.clinic', 'navigation.team', 'navigation.contact']);
    if (input.content.language !== 'en') add('language-switcher', 'Offer the complete reviewed English package.', 'Support language choice.', ['navigation.contact']);
    add('image-led hero', 'State the clinic identity and next step.', 'Primary conversion entry.', ['hero.eyebrow', 'hero.heading']);
    add('appointment-actions', 'Present the verified appointment method.', 'Primary conversion.', ['appointment.heading', 'appointment.verified_method']);
    add('editorial treatment discovery', 'Present verified treatment labels.', 'Treatment orientation.', input.content.items.filter((item) => item.contentKey.startsWith('treatments.')).map((item) => item.contentKey));
    add('team and specialist presentation', 'Present only verified people and roles.', 'Build informed trust.', input.content.items.filter((item) => item.contentKey.startsWith('team.')).map((item) => item.contentKey));
    add('location and opening hours', 'Make practical visit information easy to find.', 'Reduce booking friction.', ['hours.heading', 'hours.value', 'location.heading', 'location.value']);
    add('deterministic FAQ concierge', 'Answer verified practical questions without diagnosis.', 'Escalate to verified contact.', input.content.items.filter((item) => item.contentKey.startsWith('faq.')).map((item) => item.contentKey));
    add('final CTA', 'Repeat one verified next step.', 'Primary conversion close.', ['appointment.heading', 'appointment.verified_method']);
    add('footer', 'Present disclosure and legal labels.', 'Close with verified contact context.', ['footer.label', 'contact.value']);

    const plan = experiencePlanDataSchema.parse({
      sections,
      visibleEnglishSwitcher: input.content.language === 'en' || sections.some((section) => section.componentFamily === 'language-switcher'),
      mobileAppointmentPersistent: sections.some((section) => section.componentFamily === 'appointment-actions'),
      selectedReferenceFamily: reference,
      componentRegistryHash: input.componentRegistryHash,
      referenceLibraryHash: input.referenceLibraryHash,
      inputFingerprint: input.inputFingerprint,
    });
    return { brief, plan };
  }
}

export function creativeInputFingerprint(value: {
  intelligenceHash: string;
  contentHash: string;
  assetCatalogHash: string;
  selectionHashes: string[];
  /** Included explicitly so the family still changes the fingerprint when there are no selections. */
  referenceFamily: string;
  componentRegistryHash: string;
  referenceLibraryHash: string;
}): string {
  return demoV2Hash(value);
}
