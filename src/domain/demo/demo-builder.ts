import { type LeadFact } from '../lead-facts/lead-fact.js';
import { hashCanonical } from '../../utils/hash.js';
import { buildDemoBrief, type BriefFinding } from './demo-brief.js';
import { resolveDemoContent } from './demo-content.js';
import { decideDemo, type DemoDecision, type DemoDecisionConfig } from './demo-decision.js';
import { validateDemoContent, validateRenderedHtml } from './demo-validation.js';
import { renderDemoHtml, renderNetlifyToml } from './template.js';
import { type BuiltDemo, type DemoBrief, type DemoOutcome } from './demo-types.js';

export interface DemoBuildInput {
  opportunityScore: number | null;
  findings: BriefFinding[];
  facts: LeadFact[];
}

export interface DemoBuildResult {
  decision: DemoDecision;
  outcome: DemoOutcome;
  brief?: DemoBrief;
  built?: BuiltDemo;
  violations?: string[];
}

/**
 * Pure, deterministic demo build: decide → brief → resolve content from facts → render →
 * validate (provenance + no-fabrication + rendered-HTML security). No DB, no filesystem,
 * no network, no AI. Identical inputs produce an identical page (content hash).
 */
export function buildDemo(input: DemoBuildInput, config: DemoDecisionConfig): DemoBuildResult {
  const decision = decideDemo({ opportunityScore: input.opportunityScore, findings: input.findings, facts: input.facts }, config);
  if (decision.kind === 'NO_DEMO') return { decision, outcome: decision.outcome };

  const brief = buildDemoBrief(input.findings);
  const content = resolveDemoContent(input.facts);
  const html = renderDemoHtml(content);
  const netlifyToml = renderNetlifyToml();

  const violations = [
    ...validateDemoContent(content, input.facts).violations,
    ...validateRenderedHtml(html).violations,
  ];
  if (violations.length > 0) return { decision, outcome: 'VALIDATION_FAILED', brief, violations };

  const contentHash = hashCanonical({ html, template: content });
  return { decision, outcome: 'DEMO_BUILT', brief, built: { html, netlifyToml, content, contentHash } };
}
