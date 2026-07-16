import { hashCanonical } from '../../utils/hash.js';
import { type AcceptedFinding, type AuditCategory } from './audit-types.js';

export interface ScoringConfig {
  version: string;
  severityWeight: { HIGH: number; MEDIUM: number; LOW: number };
  confidenceBands: { high: number; medium: number };
  confidenceFactor: { high: number; medium: number; low: number };
  categoryMultiplier: Partial<Record<AuditCategory, number>>;
  mobileProfileMultiplier: number;
  dedupFactor: number;
  perFindingCap: number;
  noOutreachSafeOverallCap: number;
  severeCaptureLimitationOverallCap: number;
  dimensionWeights: { conversion: number; mobile: number; trust: number; contactability: number };
}

export const OPPORTUNITY_RULES: ScoringConfig = {
  version: 'opp-rules-1',
  severityWeight: { HIGH: 30, MEDIUM: 18, LOW: 8 },
  confidenceBands: { high: 0.7, medium: 0.5 },
  confidenceFactor: { high: 1, medium: 0.7, low: 0.4 },
  categoryMultiplier: {
    BOOKING_FRICTION: 1.3,
    CONTACT_FRICTION: 1.3,
    TRUST_SIGNALS: 1.2,
    SOCIAL_PROOF: 1.2,
    MOBILE_USABILITY: 1.15,
  },
  mobileProfileMultiplier: 1.15,
  dedupFactor: 0.5,
  perFindingCap: 40,
  noOutreachSafeOverallCap: 40,
  severeCaptureLimitationOverallCap: 30,
  dimensionWeights: { conversion: 0.4, mobile: 0.25, trust: 0.2, contactability: 0.15 },
};

export function opportunityRulesHash(config: ScoringConfig): string {
  return hashCanonical(config);
}

const DIMENSION_OF: Record<AuditCategory, Array<'conversion' | 'mobile' | 'trust' | 'contactability'>> = {
  CTA_CLARITY: ['conversion'],
  BOOKING_FRICTION: ['conversion'],
  CONTACT_FRICTION: ['conversion', 'contactability'],
  MOBILE_USABILITY: ['mobile'],
  SERVICE_CLARITY: ['conversion'],
  TRUST_SIGNALS: ['trust'],
  SOCIAL_PROOF: ['trust'],
  NAVIGATION: ['conversion'],
  READABILITY: ['conversion'],
  LOCAL_INFORMATION: ['contactability'],
  VISUAL_HIERARCHY: ['conversion'],
  TECHNICAL_RENDERING: ['mobile'],
  ACCESSIBILITY_INDICATOR: ['mobile'],
  DESKTOP_MOBILE_CONSISTENCY: ['mobile'],
  OTHER: [],
};

export interface ScoreBreakdownRow {
  findingRef: string;
  dimensions: string[];
  baseWeight: number;
  severityMultiplier: number;
  confidenceMultiplier: number;
  categoryMultiplier: number;
  profileMultiplier: number;
  dedupAdjustment: number;
  capApplied: boolean;
  finalContribution: number;
}

export interface OpportunityScores {
  conversion: number;
  mobile: number;
  trust: number;
  contactability: number;
  overall: number;
}

export interface OpportunityResult {
  scores: OpportunityScores;
  breakdown: ScoreBreakdownRow[];
  capsApplied: string[];
  rulesVersion: string;
  rulesConfigHash: string;
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Deterministic opportunity scoring with a persisted per-finding breakdown. The model
 * never sets the score. Identical accepted findings + rules version → identical result.
 */
export function scoreOpportunity(
  accepted: AcceptedFinding[],
  opts: { severeCaptureLimitations: boolean },
  config: ScoringConfig = OPPORTUNITY_RULES,
): OpportunityResult {
  const breakdown: ScoreBreakdownRow[] = [];
  const dims = { conversion: 0, mobile: 0, trust: 0, contactability: 0 };
  const seenCategory = new Map<AuditCategory, number>();

  for (const f of accepted) {
    const baseWeight = config.severityWeight[f.severity];
    const confidenceMultiplier =
      f.confidence >= config.confidenceBands.high
        ? config.confidenceFactor.high
        : f.confidence >= config.confidenceBands.medium
          ? config.confidenceFactor.medium
          : config.confidenceFactor.low;
    const categoryMultiplier = config.categoryMultiplier[f.category] ?? 1;
    const profileMultiplier = f.affectedProfiles.includes('MOBILE') ? config.mobileProfileMultiplier : 1;

    const priorSameCategory = seenCategory.get(f.category) ?? 0;
    seenCategory.set(f.category, priorSameCategory + 1);
    const dedupAdjustment = priorSameCategory > 0 ? config.dedupFactor : 1;

    let contribution = baseWeight * confidenceMultiplier * categoryMultiplier * profileMultiplier * dedupAdjustment;
    const capApplied = contribution > config.perFindingCap;
    if (capApplied) contribution = config.perFindingCap;
    contribution = Math.round(contribution * 100) / 100;

    const dimensions = DIMENSION_OF[f.category];
    for (const d of dimensions) dims[d] += contribution;

    breakdown.push({
      findingRef: f.findingRef,
      dimensions,
      baseWeight,
      severityMultiplier: 1,
      confidenceMultiplier,
      categoryMultiplier,
      profileMultiplier,
      dedupAdjustment,
      capApplied,
      finalContribution: contribution,
    });
  }

  const capsApplied: string[] = [];
  const w = config.dimensionWeights;
  let overallRaw =
    (clamp100(dims.conversion) * w.conversion +
      clamp100(dims.mobile) * w.mobile +
      clamp100(dims.trust) * w.trust +
      clamp100(dims.contactability) * w.contactability) /
    (w.conversion + w.mobile + w.trust + w.contactability);

  const hasOutreachSafe = accepted.some((f) => f.safeForOutreach);
  if (!hasOutreachSafe && overallRaw > config.noOutreachSafeOverallCap) {
    overallRaw = config.noOutreachSafeOverallCap;
    capsApplied.push('no_outreach_safe_cap');
  }
  if (opts.severeCaptureLimitations && overallRaw > config.severeCaptureLimitationOverallCap) {
    overallRaw = config.severeCaptureLimitationOverallCap;
    capsApplied.push('severe_capture_limitation_cap');
  }

  return {
    scores: {
      conversion: clamp100(dims.conversion),
      mobile: clamp100(dims.mobile),
      trust: clamp100(dims.trust),
      contactability: clamp100(dims.contactability),
      overall: clamp100(overallRaw),
    },
    breakdown,
    capsApplied,
    rulesVersion: config.version,
    rulesConfigHash: opportunityRulesHash(config),
  };
}
