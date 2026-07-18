import { type LeadFact } from '../lead-facts/lead-fact.js';
import {
  DEMO_URL_TOKEN,
  type EmailCtaKind,
  type EmailCtaLabelKey,
  type EmailFactKey,
  type EmailWriterOutput,
  type RenderedEmail,
  type SignoffKey,
} from './email-types.js';
import { type EmailValidationContext } from './email-validation.js';
import { type EmailLanguage, resolveEmailLanguage } from './email-language.js';

/** Placeholder for the operator's own name; substituted before any real send (Phase 14). */
export const SENDER_NAME_TOKEN = '{{SENDER_NAME}}';

/** Accepted (Phase 6) finding available for the email to reference. */
export interface EmailFinding {
  id: string;
  findingRef: string;
  category: string;
  safeForOutreach: boolean;
  observation: string;
  recommendation: string;
}

/** Approved-demo metadata the email may use (only when human-approved). */
export interface EmailDemoMeta {
  id: string;
  status: string; // demo lifecycle status
  ctaKind: string | null;
}

export interface EmailInputs {
  facts: LeadFact[];
  findings: EmailFinding[];
  demo: EmailDemoMeta | null;
}

const current = (facts: LeadFact[], t: string): LeadFact | undefined =>
  facts.find((f) => f.factType === t && f.isCurrent && f.value.trim() !== '');

/** Fixed (non-model) strings, keyed by language so greeting/CTA/signoff match the body. */
const NEUTRAL_GREETING: Record<EmailLanguage, string> = { en: 'Hello,', de: 'Hallo,' };
const NAMED_GREETING: Record<EmailLanguage, (name: string) => string> = {
  en: (n) => `Hello ${n},`,
  de: (n) => `Hallo ${n},`,
};

const CTA_SENTENCE: Record<EmailLanguage, Record<EmailCtaLabelKey, string>> = {
  en: {
    REPLY_TO_LEARN_MORE: 'If it would be useful, just reply and I can share more.',
    HAPPY_TO_SHARE_DETAILS: "I'd be happy to share a few specifics — just reply to this email.",
    SEE_THE_CONCEPT: `You can see the concept here: ${DEMO_URL_TOKEN}`,
    TAKE_A_QUICK_LOOK: `If you'd like, take a quick look here: ${DEMO_URL_TOKEN}`,
  },
  de: {
    REPLY_TO_LEARN_MORE: 'Wenn es hilfreich ist, antworten Sie einfach — ich teile gern mehr.',
    HAPPY_TO_SHARE_DETAILS: 'Gern teile ich ein paar konkrete Details — antworten Sie einfach auf diese E-Mail.',
    SEE_THE_CONCEPT: `Das Konzept können Sie hier ansehen: ${DEMO_URL_TOKEN}`,
    TAKE_A_QUICK_LOOK: `Werfen Sie bei Interesse gern einen kurzen Blick darauf: ${DEMO_URL_TOKEN}`,
  },
};

const SIGNOFF_TEXT: Record<EmailLanguage, Record<SignoffKey, string>> = {
  en: { BEST_REGARDS: 'Best regards,', KIND_REGARDS: 'Kind regards,', THANKS: 'Thanks,' },
  de: { BEST_REGARDS: 'Beste Grüße', KIND_REGARDS: 'Freundliche Grüße', THANKS: 'Vielen Dank' },
};

/** A demo link may be referenced only when a human-APPROVED demo exists (Phase 11 will
 * substitute the verified deployed URL). */
export function demoLinkAllowed(demo: EmailDemoMeta | null): boolean {
  return demo !== null && demo.status === 'APPROVED';
}

/** Build the validation context (available facts, accepted finding refs, demo/name gates). */
export function buildEmailContext(inputs: EmailInputs): EmailValidationContext {
  const available = new Set<EmailFactKey>();
  if (current(inputs.facts, 'business_name')) available.add('business_name');
  if (current(inputs.facts, 'city')) available.add('city');
  if (current(inputs.facts, 'services')) available.add('services');
  const hasContactName = !!current(inputs.facts, 'contact_name');
  if (hasContactName) available.add('contact_name');

  return {
    availableFactKeys: available,
    acceptedFindingRefs: new Set(inputs.findings.filter((f) => f.safeForOutreach).map((f) => f.findingRef)),
    demoLinkAllowed: demoLinkAllowed(inputs.demo),
    hasContactName,
    language: resolveEmailLanguage(inputs.facts),
  };
}

/**
 * Deterministically assemble the plain-text email from the VALIDATED writer output: neutral
 * greeting (named only with a verified contact-name fact), the model's paragraphs, a vetted
 * CTA sentence, and a signoff. Tracks relational provenance for every personalized value.
 * The demo link (if any) stays as the {{DEMO_URL}} token — never a real URL in Phase 9.
 */
export function renderEmail(out: EmailWriterOutput, inputs: EmailInputs): RenderedEmail {
  const factInputs: RenderedEmail['factInputs'] = [];
  const use = (t: EmailFactKey, field: string): void => {
    const f = current(inputs.facts, t);
    if (f) factInputs.push({ factId: f.id, factType: f.factType, field });
  };

  const language: EmailLanguage = resolveEmailLanguage(inputs.facts);

  // Greeting: NAMED honoured only with a verified contact-name fact; else neutral. All fixed
  // strings (greeting, CTA, signoff) are language-matched to the model-authored body.
  const nameFact = current(inputs.facts, 'contact_name');
  let greeting = NEUTRAL_GREETING[language];
  if (out.greetingStyle === 'NAMED' && nameFact) {
    greeting = NAMED_GREETING[language](nameFact.value.trim());
    factInputs.push({ factId: nameFact.id, factType: nameFact.factType, field: 'greeting.name' });
  }

  // Record provenance for the facts the writer declared (and that exist).
  for (const fk of out.factRefs) use(fk, `body.${fk}`);

  const ctaKind: EmailCtaKind = out.ctaKind;
  const ctaSentence = CTA_SENTENCE[language][out.ctaLabelKey];
  const body = [
    greeting,
    '',
    ...out.bodyParagraphs.map((p) => p.trim()),
    '',
    ctaSentence,
    '',
    SIGNOFF_TEXT[language][out.signoffKey],
    SENDER_NAME_TOKEN,
  ].join('\n');

  const findingById = new Map(inputs.findings.filter((f) => f.safeForOutreach).map((f) => [f.findingRef, f]));
  const findingInputs: RenderedEmail['findingInputs'] = [];
  for (const ref of out.findingRefs) {
    const f = findingById.get(ref);
    if (f) findingInputs.push({ findingId: f.id, findingRef: f.findingRef, directive: `email:${f.category}` });
  }

  return {
    subject: out.subject,
    body,
    ctaKind,
    hasDemoUrlPlaceholder: body.includes(DEMO_URL_TOKEN),
    factInputs,
    findingInputs,
  };
}
