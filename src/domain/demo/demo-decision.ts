import { type LeadFact } from '../lead-facts/lead-fact.js';
import { DEMONSTRABLE_CATEGORIES, type DemoDecisionKind, type DemoOutcome } from './demo-types.js';
import { type BriefFinding } from './demo-brief.js';

export interface DemoDecisionConfig {
  minOpportunityForDemo: number;
}

export interface DemoDecisionInput {
  opportunityScore: number | null;
  findings: BriefFinding[];
  facts: LeadFact[];
}

export interface DemoDecision {
  kind: DemoDecisionKind;
  outcome: DemoOutcome;
  reason: string;
  justifiedByScore: boolean;
  justifiedByFinding: boolean;
}

const has = (facts: LeadFact[], t: string): boolean =>
  facts.some((f) => f.factType === t && f.isCurrent && f.value.trim() !== '');

/**
 * Deterministic demo decision (amendment 1): a useful demo is NOT rejected solely for a
 * low opportunity score. Build when sufficient verified facts exist AND either the score
 * meets the threshold OR at least one accepted outreach-safe finding is in a demonstrable
 * category. (The Gate A lead scored 10 but had two valid outreach-safe findings.)
 */
export function decideDemo(input: DemoDecisionInput, config: DemoDecisionConfig): DemoDecision {
  const sufficientFacts =
    has(input.facts, 'business_name') &&
    (has(input.facts, 'city') ||
      has(input.facts, 'phone') ||
      has(input.facts, 'contact_email') ||
      has(input.facts, 'formatted_address') ||
      has(input.facts, 'official_website_url'));

  if (!sufficientFacts) {
    return {
      kind: 'NO_DEMO',
      outcome: 'NO_DEMO_INSUFFICIENT_FACTS',
      reason: 'Insufficient verified facts to build a credible demo (need business name + at least one of city/phone/email/address/website).',
      justifiedByScore: false,
      justifiedByFinding: false,
    };
  }

  const justifiedByScore = input.opportunityScore !== null && input.opportunityScore >= config.minOpportunityForDemo;
  const justifiedByFinding = input.findings.some(
    (f) => f.safeForOutreach && DEMONSTRABLE_CATEGORIES.includes(f.category),
  );

  if (!justifiedByScore && !justifiedByFinding) {
    return {
      kind: 'NO_DEMO',
      outcome: 'NO_DEMO_NOT_JUSTIFIED',
      reason: `Not justified: score ${String(input.opportunityScore ?? 'n/a')} < ${String(config.minOpportunityForDemo)} and no outreach-safe finding in a demonstrable category.`,
      justifiedByScore,
      justifiedByFinding,
    };
  }

  return {
    kind: 'BUILD_DEMO',
    outcome: 'DEMO_BUILT',
    reason: justifiedByScore
      ? `Opportunity score ${String(input.opportunityScore)} ≥ ${String(config.minOpportunityForDemo)}.`
      : 'At least one accepted outreach-safe finding in a demonstrable category.',
    justifiedByScore,
    justifiedByFinding,
  };
}
