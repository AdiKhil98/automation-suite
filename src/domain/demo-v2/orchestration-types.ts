import { z } from 'zod';
import { demoV2DirectionSchema, demoV2LanguageSchema } from './clinic-intelligence.js';
import { SHA256_PATTERN } from './hash.js';

export const DEMO_V2_ORCHESTRATION_VERSION = 'demo-v2-orchestration-1';

export const sourceRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['LEAD_FACT', 'AUDIT_FINDING', 'CAPTURE_EVIDENCE', 'EVIDENCE']),
  role: z.enum(['IDENTITY', 'CONTENT', 'CLAIM', 'AUDIT', 'LANGUAGE', 'ASSET_CONTEXT', 'CONTACT', 'CONSTRAINT', 'OTHER']),
  key: z.string().min(1),
  value: z.string(),
  capturedAt: z.string().datetime(),
  recordHash: z.string().regex(SHA256_PATTERN),
  direct: z.boolean(),
  accepted: z.boolean(),
  stale: z.boolean(),
});
export type DemoV2SourceRecord = z.infer<typeof sourceRecordSchema>;

export const assertionSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  classification: z.enum(['DIRECT_FACT', 'EVIDENCE_BOUND_DERIVATION']),
  sourceIds: z.array(z.string().min(1)).min(1),
});
export type DemoV2Assertion = z.infer<typeof assertionSchema>;

export const clinicIntelligenceDataSchema = z.object({
  businessIdentity: z.array(assertionSchema),
  officialWebsite: z.array(assertionSchema),
  locations: z.array(assertionSchema),
  contactChannels: z.array(assertionSchema),
  appointmentMethods: z.array(assertionSchema),
  openingHours: z.array(assertionSchema),
  emergencyContact: z.array(assertionSchema),
  services: z.array(assertionSchema),
  teamMembers: z.array(assertionSchema),
  positioning: z.array(assertionSchema),
  differentiators: z.array(assertionSchema),
  audienceConcerns: z.array(assertionSchema),
  atmosphereCues: z.array(assertionSchema),
  websiteStrengths: z.array(assertionSchema),
  acceptedAuditFindings: z.array(assertionSchema),
  conversionWeaknesses: z.array(assertionSchema),
  prohibitedClaims: z.array(z.string().min(1)),
  availableEvidence: z.array(sourceRecordSchema),
  excludedSourceIds: z.array(z.string().min(1)),
  contradictions: z.array(z.object({
    key: z.string().min(1),
    sourceIds: z.array(z.string().min(1)).min(2),
    values: z.array(z.string().min(1)).min(2),
  })),
  missingInformation: z.array(z.string().min(1)),
  languageDecision: z.object({
    primaryLanguage: demoV2LanguageSchema,
    primaryDirection: demoV2DirectionSchema,
    supportedLanguages: z.array(demoV2LanguageSchema).min(1),
    signalSourceIds: z.array(z.string().min(1)),
    manualReviewRequired: z.boolean(),
  }),
});
export type ClinicIntelligenceData = z.infer<typeof clinicIntelligenceDataSchema>;

export const contentBindingSchema = z.object({
  contentItemId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)),
  relationship: z.enum(['SUPPORTS', 'CONSTRAINS', 'SOURCE_TEXT']),
});

export const assetCandidateSchema = z.object({
  id: z.string().min(1),
  sourcePageUrl: z.string().url(),
  directUrl: z.string().url(),
  finalUrl: z.string().url(),
  sourceEvidenceId: z.string().min(1).nullable(),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  aspectRatio: z.number().positive(),
  altText: z.string().nullable(),
  nearbyHeading: z.string().nullable(),
  nearbyCaption: z.string().nullable(),
  contentHash: z.string().regex(SHA256_PATTERN),
  ownership: z.enum(['FIRST_PARTY', 'APPROVED_FIRST_PARTY_CDN', 'THIRD_PARTY', 'UNKNOWN']),
  availability: z.enum(['DISCOVERED', 'AVAILABLE', 'UNAVAILABLE', 'BLOCKED', 'UNKNOWN']),
  quality: z.enum(['UNASSESSED', 'SUITABLE', 'UNSUITABLE']),
  category: z.enum(['HERO', 'CLINIC_INTERIOR', 'EXTERIOR', 'TEAM', 'DOCTOR', 'TREATMENT', 'EQUIPMENT', 'LOCATION', 'LOGO', 'DECORATIVE', 'UNSUITABLE']),
  discoveryMethod: z.enum(['IMG', 'SRCSET', 'PICTURE', 'CSS_BACKGROUND', 'OPEN_GRAPH', 'STRUCTURED_DATA', 'LINKED_MEDIA', 'NETWORK']),
  discoveredAt: z.string().datetime(),
  recordHash: z.string().regex(SHA256_PATTERN),
});
export type DemoV2AssetCandidate = z.infer<typeof assetCandidateSchema>;

export const assetSelectionProposalSchema = z.object({
  id: z.string().min(1),
  selectionKey: z.string().min(1),
  assetId: z.string().min(1),
  intendedSection: z.string().min(1),
  intendedUse: z.string().min(1),
  desktopCrop: z.object({ mode: z.enum(['cover', 'contain']), aspectRatio: z.number().positive() }),
  mobileCrop: z.object({ mode: z.enum(['cover', 'contain']), aspectRatio: z.number().positive() }),
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  overlayGuidance: z.string().min(1),
  contrastRequirement: z.string().min(1),
  fallbackBehavior: z.string().min(1),
  justification: z.string().min(1),
  boundAssetRecordHash: z.string().regex(SHA256_PATTERN),
  selectionHash: z.string().regex(SHA256_PATTERN),
  status: z.literal('REUSE_REVIEW_REQUIRED'),
});
export type DemoV2AssetSelectionProposal = z.infer<typeof assetSelectionProposalSchema>;

export const creativeBriefDataSchema = z.object({
  audiences: z.array(z.string().min(1)).min(1),
  primaryConversion: z.string().min(1),
  secondaryConversions: z.array(z.string().min(1)),
  positioning: z.string().min(1),
  coreMessage: z.string().min(1),
  strategicAngle: z.string().min(1),
  emotionalTone: z.array(z.string().min(1)).min(1),
  artDirection: z.string().min(1),
  typographyDirection: z.string().min(1),
  colorRoleDirection: z.string().min(1),
  imageryDirection: z.string().min(1),
  layoutPrinciples: z.array(z.string().min(1)).min(1),
  interactionDirection: z.string().min(1),
  conversionStrategy: z.string().min(1),
  multilingualConsiderations: z.array(z.string().min(1)),
  mobilePriorities: z.array(z.string().min(1)).min(1),
  accessibilityPriorities: z.array(z.string().min(1)).min(1),
  prohibitedClaims: z.array(z.string().min(1)).min(1),
  prohibitedVisualPatterns: z.array(z.string().min(1)).min(1),
  selectedReferenceFamily: z.string().min(1),
  evidenceSourceIds: z.array(z.string().min(1)).min(1),
  inputFingerprint: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  const { prohibitedVisualPatterns: _prohibitedVisualPatterns, prohibitedClaims: _prohibitedClaims, ...direction } = value;
  const text = JSON.stringify(direction).toLowerCase();
  for (const phrase of ['clean modern website', 'generic saas', 'empty gradient hero', 'repeated icon cards']) {
    if (text.includes(phrase)) ctx.addIssue({ code: 'custom', message: `generic creative direction prohibited: ${phrase}` });
  }
});
export type CreativeBriefData = z.infer<typeof creativeBriefDataSchema>;

export const experienceSectionSchema = z.object({
  order: z.number().int().positive(),
  sectionPurpose: z.string().min(1),
  conversionRole: z.string().min(1),
  componentFamily: z.string().min(1),
  componentVariant: z.string().min(1),
  requiredContentKeys: z.array(z.string().min(1)),
  selectedClaimSourceIds: z.array(z.string().min(1)),
  selectedAssetCategories: z.array(z.string().min(1)),
  proposedAssetSelectionIds: z.array(z.string().min(1)),
  visualTreatment: z.string().min(1),
  motionPreset: z.enum(['NONE', 'PURPOSEFUL_REVEAL', 'GUIDED_FOCUS']),
  desktopBehavior: z.string().min(1),
  mobileBehavior: z.string().min(1),
  accessibilityRequirements: z.array(z.string().min(1)).min(1),
  supportedLanguages: z.array(demoV2LanguageSchema).min(1),
  auditFindingAddressed: z.string().nullable(),
  fallbackBehavior: z.string().min(1),
  justification: z.string().min(1),
});

export const experiencePlanDataSchema = z.object({
  sections: z.array(experienceSectionSchema).min(5),
  visibleEnglishSwitcher: z.boolean(),
  mobileAppointmentPersistent: z.boolean(),
  /** The single reference family selected once per orchestration. Asset selections, the Creative
   * Brief, this plan, and the report all carry the identical value. */
  selectedReferenceFamily: z.string().min(1),
  componentRegistryHash: z.string().regex(SHA256_PATTERN),
  referenceLibraryHash: z.string().regex(SHA256_PATTERN),
  inputFingerprint: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  const orders = value.sections.map((section) => section.order);
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: 'custom', message: 'section orders must be unique' });
  const families = value.sections.map((section) => section.componentFamily);
  const cardCount = families.filter((family) => family.includes('card')).length;
  if (cardCount > Math.floor(value.sections.length / 3)) ctx.addIssue({ code: 'custom', message: 'dominant SaaS card composition prohibited' });
  if (!value.mobileAppointmentPersistent) ctx.addIssue({ code: 'custom', message: 'mobile appointment action required' });
  const nonEnglish = value.sections.some((section) => section.supportedLanguages.some((language) => language !== 'en'));
  if (nonEnglish && !value.visibleEnglishSwitcher) ctx.addIssue({ code: 'custom', message: 'English language switcher required' });
});
export type ExperiencePlanData = z.infer<typeof experiencePlanDataSchema>;

export const orchestrationReportSchema = z.object({
  artifactId: z.string().min(1),
  providerState: z.literal('MOCK_ONLY'),
  factsUsed: z.array(z.string()),
  factsExcluded: z.array(z.string()),
  contradictions: z.array(z.unknown()),
  missingInformation: z.array(z.string()),
  languages: z.array(demoV2LanguageSchema),
  contentKeys: z.array(z.string()),
  /** FAQ topics backed by verified evidence, and those deliberately omitted for lack of it. */
  faqTopics: z.array(z.string()),
  faqOmittedTopics: z.array(z.string()),
  assetCandidateIds: z.array(z.string()),
  assetSelectionIds: z.array(z.string()),
  referenceFamily: z.string(),
  plannedSections: z.array(z.string()),
  unsupportedClaimsBlocked: z.array(z.string()),
  fingerprints: z.record(z.string(), z.string()),
  modelCalls: z.array(z.object({
    purpose: z.enum(['TRANSLATION', 'CREATIVE_ORCHESTRATION']),
    provider: z.literal('mock'),
    requestedModel: z.string(),
    resolvedModel: z.string(),
    reasoningEffort: z.string(),
    costUsd: z.literal(0),
    usage: z.object({
      inputTokens: z.literal(0),
      outputTokens: z.literal(0),
      totalTokens: z.literal(0),
    }),
    responseId: z.string(),
    cached: z.boolean(),
  })),
  totalCostUsd: z.literal(0),
  lifecycle: z.array(z.string()),
});
export type DemoV2OrchestrationReport = z.infer<typeof orchestrationReportSchema>;
