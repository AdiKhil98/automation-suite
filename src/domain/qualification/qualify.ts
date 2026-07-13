import { type QualificationRules, rulesConfigHash } from '../../config/qualification-rules.js';
import { hashCanonical } from '../../utils/hash.js';
import { type FactType, type LeadFact } from '../lead-facts/lead-fact.js';
import {
  type QualificationDecision,
  type QualificationNextStep,
  type QualificationPriority,
  type QualificationResult,
} from './qualification-result.js';

export interface QualificationNiche {
  allowedCategories: string[];
  excludeChains: boolean;
  chainNames: string[]; // explicit normalized names, or empty
}

export interface QualificationContext {
  leadId: string;
  campaign: string;
  niche: QualificationNiche;
  suppressed: boolean;
  now: Date;
}

const REQUIRED_FACTS: FactType[] = ['business_name', 'business_status', 'category'];
const CONTACT_OR_AUDIT_FACTS: FactType[] = [
  'official_domain',
  'domain',
  'phone',
  'contact_email',
  'contact_form_url',
];

/**
 * Deterministic PRE_AUDIT qualification. Reads ONLY the supplied current facts
 * (which the caller has already restricted to approved provenance). Never mutates,
 * never calls AI, and records exactly which fact IDs it used.
 */
export function evaluateQualification(
  facts: LeadFact[],
  ctx: QualificationContext,
  rules: QualificationRules,
): QualificationResult {
  const byType = new Map<FactType, LeadFact>();
  for (const f of facts) if (f.isCurrent) byType.set(f.factType, f);

  const usedFactIds = new Set<string>();
  const triggeredRules: string[] = [];
  const reasons: string[] = [];

  const use = (type: FactType): LeadFact | undefined => {
    const f = byType.get(type);
    if (f) usedFactIds.add(f.id);
    return f;
  };
  const valueOf = (type: FactType): string | undefined => use(type)?.value;

  const hash = rulesConfigHash(rules);
  const base = {
    leadId: ctx.leadId,
    campaign: ctx.campaign,
    qualificationStage: 'PRE_AUDIT' as const,
    rulesVersion: rules.version,
    rulesConfigHash: hash,
    evaluatedAt: ctx.now,
  };

  const finish = (
    partial: Omit<
      QualificationResult,
      keyof typeof base | 'inputFingerprint' | 'inputFactIds' | 'triggeredRules' | 'reasons'
    >,
  ): QualificationResult => {
    const inputFactIds = [...usedFactIds].sort();
    const factPairs = inputFactIds
      .map((id) => facts.find((f) => f.id === id))
      .filter((f): f is LeadFact => Boolean(f))
      .map((f) => [f.factType, f.normalizedValue ?? f.value] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const inputFingerprint = hashCanonical({
      campaign: ctx.campaign,
      niche: {
        allowedCategories: [...ctx.niche.allowedCategories].sort(),
        excludeChains: ctx.niche.excludeChains,
        chainNames: [...ctx.niche.chainNames].sort(),
      },
      rulesConfigHash: hash,
      facts: factPairs,
    });
    return { ...base, ...partial, triggeredRules, reasons, inputFingerprint, inputFactIds };
  };

  const rejected = (rule: string, reason: string): QualificationResult => {
    triggeredRules.push(rule);
    reasons.push(reason);
    return finish({
      businessViabilityScore: null,
      auditabilityScore: null,
      contactabilityScore: null,
      opportunityScore: null,
      deterministicScore: null,
      decision: 'REJECT',
      priority: 'UNASSIGNED',
      nextStep: 'SKIP',
      missingRequiredFacts: [],
    });
  };

  // --- Rejection gates (confident only; never fire on a missing fact) ---
  if (ctx.suppressed) return rejected('gate.suppressed', 'Business is on the suppression list');

  const status = valueOf('business_status');
  if (status === 'CLOSED_PERMANENTLY') {
    return rejected('gate.permanentlyClosed', 'Business is permanently closed');
  }

  const categoryFact = use('category');
  const category = categoryFact?.normalizedValue ?? categoryFact?.value ?? null;
  if (category && !ctx.niche.allowedCategories.includes(category)) {
    return rejected('gate.outsideNiche', `Category "${category}" is outside the campaign niche`);
  }

  const ownership = valueOf('ownership_type');
  if (ctx.niche.excludeChains && ownership === 'CHAIN') {
    return rejected('gate.verifiedChain', 'Verified chain excluded by campaign');
  }

  // Soft flag: name resembles a known chain, but this NEVER proves ownership or rejects.
  const normalizedName = use('business_name')?.normalizedValue ?? null;
  if (normalizedName && ctx.niche.chainNames.includes(normalizedName)) {
    triggeredRules.push('flag.possibleChain');
    reasons.push('Name matches a known chain; ownership not verified (not rejected)');
  }

  // --- Provenance / minimum required facts ---
  const missingRequiredFacts: string[] = [];
  for (const type of REQUIRED_FACTS) if (!byType.has(type)) missingRequiredFacts.push(type);
  const hasContactOrAudit = CONTACT_OR_AUDIT_FACTS.some((t) => byType.has(t));
  if (!hasContactOrAudit) missingRequiredFacts.push('contact_or_audit_path');

  if (byType.size === 0 || missingRequiredFacts.length > 0) {
    triggeredRules.push('route.needsEnrichment');
    reasons.push(
      byType.size === 0
        ? 'No approved facts yet (e.g. Place-ID-only candidate); needs enrichment'
        : `Missing required facts: ${missingRequiredFacts.join(', ')}`,
    );
    return finish({
      businessViabilityScore: null,
      auditabilityScore: null,
      contactabilityScore: null,
      opportunityScore: null,
      deterministicScore: null,
      decision: 'REVIEW',
      priority: 'UNASSIGNED',
      nextStep: 'NEEDS_ENRICHMENT',
      missingRequiredFacts,
    });
  }

  // --- Scoring (deterministic) ---
  const w = rules.viabilityWeights;
  let viability = 0;
  if (status === 'OPERATIONAL') {
    viability += w.active;
    triggeredRules.push('signal.activeBusiness');
  }
  const rating = numeric(valueOf('rating'));
  if (rating != null && rating >= rules.ratingMin) {
    viability += w.rating;
    triggeredRules.push('signal.ratingGood');
  }
  const reviews = numeric(valueOf('review_count'));
  if (reviews != null && reviews >= rules.reviewCountMin) {
    viability += w.reviews;
    triggeredRules.push('signal.reviewVolume');
  }
  if (ownership === 'INDEPENDENT') {
    viability += w.independent;
    triggeredRules.push('signal.independentVerified');
  }

  const hasOfficialDomain = byType.has('official_domain');
  if (hasOfficialDomain) use('official_domain');
  const auditability = hasOfficialDomain ? 100 : 0;
  if (hasOfficialDomain) triggeredRules.push('signal.officialDomain');

  const tiers = rules.contactabilityTiers;
  let contactability = 0;
  if (use('contact_email')) contactability = tiers.verifiedEmail;
  else if (use('contact_form_url')) contactability = tiers.contactForm;
  else if (use('phone')) contactability = tiers.phone;

  const composite = Math.round(
    rules.composite.viability * viability + rules.composite.auditability * auditability,
  );

  let decision: QualificationDecision;
  let nextStep: QualificationNextStep;
  let priority: QualificationPriority;
  if (composite >= rules.acceptThreshold) {
    decision = 'ACCEPT';
    nextStep = hasOfficialDomain ? 'AUDIT' : 'WEBSITE_DISCOVERY';
    priority = composite >= rules.priorityHigh ? 'HIGH' : 'MEDIUM';
    triggeredRules.push(nextStep === 'AUDIT' ? 'route.audit' : 'route.websiteDiscovery');
    reasons.push(
      nextStep === 'AUDIT'
        ? 'Worth auditing (official domain present)'
        : 'Worth pursuing but needs an official website discovered first',
    );
  } else {
    decision = 'REVIEW';
    nextStep = 'MANUAL_REVIEW';
    priority = 'LOW';
    triggeredRules.push('route.manualReview');
    reasons.push(`Composite score ${composite} below accept threshold ${rules.acceptThreshold}`);
  }

  return finish({
    businessViabilityScore: viability,
    auditabilityScore: auditability,
    contactabilityScore: contactability,
    opportunityScore: null,
    deterministicScore: composite,
    decision,
    priority,
    nextStep,
    missingRequiredFacts: [],
  });
}

function numeric(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
