import { type EmailBrief } from '../../prompts/email/index.js';
import { buildEmailContext, demoLinkAllowed, type EmailInputs } from './email-render.js';

/**
 * Deterministically build the writer/reviewer brief from a lead's evidence inputs.
 * Extracted so the email writer (first pass) and the reviewer-only resume path present
 * the reviewer with an identical brief. Only safe findings are exposed; no competitor
 * package exists in this workflow.
 */
export function buildEmailBrief(inputs: EmailInputs): EmailBrief {
  const safeFindings = inputs.findings.filter((finding) => finding.safeForOutreach);
  const currentFacts = inputs.facts.filter((fact) => fact.isCurrent && fact.value.trim() !== '');
  const val = (type: string): string | null =>
    currentFacts.find((fact) => fact.factType === type)?.value.trim() ?? null;
  return {
    businessName: val('business_name'),
    contactName: val('contact_name'),
    language: buildEmailContext({ facts: inputs.facts, findings: safeFindings, demo: inputs.demo }).language,
    facts: currentFacts.map((fact) => ({ evidenceId: fact.id, type: fact.factType, value: fact.value.trim() })),
    findings: safeFindings.map((finding) => ({
      evidenceId: finding.id,
      findingRef: finding.findingRef,
      category: finding.category,
      observation: finding.observation,
      recommendation: finding.recommendation,
    })),
    demoLinkAllowed: demoLinkAllowed(inputs.demo),
    approvedDemoFindingRefs: inputs.demo?.approvedFindingRefs ?? [],
    competitorPackage: null,
  };
}
