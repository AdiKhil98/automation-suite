import { type LeadFact } from '../lead-facts/lead-fact.js';
import {
  DEMO_URL_TOKEN,
  type EmailCtaKind,
  type EmailPrimaryCta,
  type EmailWriterOutput,
  type RenderedEmail,
} from './email-types.js';
import { type EmailValidationContext } from './email-validation.js';
import { type EmailLanguage, resolveEmailLanguage } from './email-language.js';

export const SENDER_NAME_TOKEN = '{{SENDER_NAME}}';

export interface EmailFinding {
  id: string;
  findingRef: string;
  category: string;
  safeForOutreach: boolean;
  observation: string;
  recommendation: string;
}

export interface EmailDemoMeta {
  id: string;
  status: string;
  ctaKind: string | null;
  approvedFindingRefs?: string[];
}

export interface EmailInputs {
  facts: LeadFact[];
  findings: EmailFinding[];
  demo: EmailDemoMeta | null;
}

const current = (facts: LeadFact[], type: string): LeadFact | undefined =>
  facts.find((fact) => fact.factType === type && fact.isCurrent && fact.value.trim() !== '');

const NEUTRAL_GREETING: Record<EmailLanguage, string> = { en: 'Hello,', de: 'Hallo,' };
const NAMED_GREETING: Record<EmailLanguage, (name: string) => string> = {
  en: (name) => `Hello ${name},`,
  de: (name) => `Hallo ${name},`,
};

const CTA_SENTENCE: Record<EmailLanguage, Record<EmailPrimaryCta, string>> = {
  en: {
    VIEW_CONCEPT: `You can view the concept here: ${DEMO_URL_TOKEN}`,
    REPLY_FOR_DETAILS: 'If this is relevant, reply and I will share the details.',
  },
  de: {
    VIEW_CONCEPT: `Das Konzept können Sie hier ansehen: ${DEMO_URL_TOKEN}`,
    REPLY_FOR_DETAILS: 'Wenn das für Sie relevant ist, antworten Sie und ich sende Ihnen die Details.',
  },
};

const SIGNOFF_TEXT: Record<EmailLanguage, string> = {
  en: 'Best regards,',
  de: 'Beste Grüße',
};

export function demoLinkAllowed(demo: EmailDemoMeta | null): boolean {
  return demo !== null && demo.status === 'APPROVED';
}

export function buildEmailContext(inputs: EmailInputs): EmailValidationContext {
  const currentFacts = inputs.facts.filter((fact) => fact.isCurrent && fact.value.trim() !== '');
  const safeFindings = inputs.findings.filter((finding) => finding.safeForOutreach);
  const acceptedByRef = new Map(safeFindings.map((finding) => [finding.findingRef, finding]));
  const approvedDemoFindingIds = new Set(
    (inputs.demo?.approvedFindingRefs ?? [])
      .map((ref) => acceptedByRef.get(ref)?.id)
      .filter((id): id is string => id !== undefined),
  );

  return {
    availableEvidenceIds: new Set([...currentFacts.map((fact) => fact.id), ...safeFindings.map((finding) => finding.id)]),
    factEvidenceIds: new Set(currentFacts.map((fact) => fact.id)),
    acceptedFindingIds: new Set(safeFindings.map((finding) => finding.id)),
    approvedDemoFindingIds,
    demoLinkAllowed: demoLinkAllowed(inputs.demo),
    language: resolveEmailLanguage(inputs.facts),
  };
}

/** Assemble the final plain-text message after validation; no model controls URLs or signoff. */
export function renderEmail(out: EmailWriterOutput, inputs: EmailInputs): RenderedEmail {
  const language = resolveEmailLanguage(inputs.facts);
  const nameFact = current(inputs.facts, 'contact_name');
  const greeting = nameFact ? NAMED_GREETING[language](nameFact.value.trim()) : NEUTRAL_GREETING[language];
  const ctaKind: EmailCtaKind = out.primary_cta === 'VIEW_CONCEPT' ? 'demo_link' : 'reply';

  const body = [
    greeting,
    '',
    out.email_body.trim(),
    '',
    CTA_SENTENCE[language][out.primary_cta],
    '',
    SIGNOFF_TEXT[language],
    SENDER_NAME_TOKEN,
  ].join('\n');

  const factById = new Map(inputs.facts.filter((fact) => fact.isCurrent).map((fact) => [fact.id, fact]));
  const findingById = new Map(inputs.findings.filter((finding) => finding.safeForOutreach).map((finding) => [finding.id, finding]));
  const factInputs: RenderedEmail['factInputs'] = [];
  const findingInputs: RenderedEmail['findingInputs'] = [];

  if (nameFact) {
    factInputs.push({ factId: nameFact.id, factType: nameFact.factType, field: 'greeting.name' });
  }
  for (const evidenceId of out.evidence_ids) {
    const fact = factById.get(evidenceId);
    if (fact) factInputs.push({ factId: fact.id, factType: fact.factType, field: 'copy.evidence' });
    const finding = findingById.get(evidenceId);
    if (finding) {
      findingInputs.push({
        findingId: finding.id,
        findingRef: finding.findingRef,
        directive: `email:${finding.category}`,
      });
    }
  }

  return {
    subject: out.selected_subject,
    body,
    ctaKind,
    hasDemoUrlPlaceholder: body.includes(DEMO_URL_TOKEN),
    factInputs,
    findingInputs,
  };
}
