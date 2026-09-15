import { type LeadFact } from '../lead-facts/lead-fact.js';
import { FINAL_FOLLOWUP_STEP, type SequenceStep } from '../outreach/sequence.js';
import {
  DEMO_URL_TOKEN,
  type EmailCtaKind,
  type EmailSequencePosition,
  INITIAL_EMAIL_SEQUENCE,
  replySubject,
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

/**
 * Who the email is actually addressed to, and therefore how it may address them.
 *
 * COPY SAFETY. `PERSONAL_VERIFIED` means the address was proven to be that named person's own work
 * email by the Instantly/Hunter trust boundary — only then may copy greet them by name.
 * `GENERIC_OFFICIAL` is a published business inbox belonging to the ORGANISATION; greeting it
 * "Hello Dr Richard" would assert an identity nobody verified. `intendedDecisionMakers` is who we
 * hope the inbox forwards to, never a claim about whose mailbox it is.
 */
export interface EmailRecipientContext {
  contactType: 'PERSONAL_VERIFIED' | 'GENERIC_OFFICIAL';
  email: string;
  intendedDecisionMakers: { fullName: string; title: string }[];
}

export interface EmailInputs {
  facts: LeadFact[];
  findings: EmailFinding[];
  demo: EmailDemoMeta | null;
  /** Absent = recipient identity unproven; treated exactly like GENERIC_OFFICIAL for naming. */
  recipient?: EmailRecipientContext | null;
  /**
   * The subject of the Gmail thread this email continues (follow-ups only). When present the
   * rendered subject is DETERMINISTIC thread continuity — `Re: <original>` — and the model's
   * selected subject is discarded. Manufacturing a fresh subject would break the thread the
   * recipient already has, so code owns this, not the model.
   */
  threadSubject?: string | null;
}

// `replySubject` now lives in email-types.ts (a leaf module) so the validator can share the exact
// same rule without importing the renderer. Re-exported here because this is where callers expect it.
export { replySubject } from './email-types.js';

/**
 * Whether copy may address the recipient by personal name. Fail-closed: ONLY an explicit
 * PERSONAL_VERIFIED recipient qualifies. An absent recipient context is not an implicit licence to
 * use a name — it means nothing verified this address belongs to a person.
 */
export function personalNameAllowed(recipient: EmailRecipientContext | null | undefined): boolean {
  return recipient?.contactType === 'PERSONAL_VERIFIED';
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

/**
 * THE FINAL EMAIL'S CTA. Follow-up #4 closes the sequence, and its job is one clean YES/NO decision:
 * a single word is a complete answer, no explanation, no meeting, and saying no must be an
 * acceptable, stated option. The ordinary reply sentence ("reply and I will share the details") asks
 * for a conversation instead, which is the wrong ask at this position.
 *
 * It is rendered DETERMINISTICALLY, like every other CTA. The alternative — telling the step-3 model
 * to write its own close — would put a second ask in `email_body`, which the copy standard forbids
 * and `cta_in_model_body` rejects. The model contract is therefore unchanged: step 3 still emits
 * REPLY_FOR_DETAILS, and the renderer chooses the sentence that position actually needs.
 */
const FINAL_CLOSE_CTA: Record<EmailLanguage, string> = {
  en: 'If you would like me to send it, reply yes. If not, no is a complete answer.',
  de: 'Wenn ich es Ihnen schicken soll, antworten Sie mit Ja. Wenn nicht, ist Nein eine vollständige Antwort.',
};

const SIGNOFF_TEXT: Record<EmailLanguage, string> = {
  en: 'Best regards,',
  de: 'Beste Grüße',
};

/**
 * Every fixed phrase the renderer adds around the model's copy. Exported so the deterministic
 * anti-repetition gate can subtract them before comparing a follow-up with what was already sent:
 * a shared greeting, CTA sentence or signoff is the system's own wording, never evidence that the
 * model repeated itself.
 */
export const RENDER_BOILERPLATE_PHRASES: readonly string[] = [
  ...Object.values(NEUTRAL_GREETING),
  ...Object.values(SIGNOFF_TEXT),
  ...Object.values(CTA_SENTENCE).flatMap((byCta) => Object.values(byCta)),
  SENDER_NAME_TOKEN,
];

/**
 * The words a rendered greeting can start with, in every language the renderer greets in. A NAMED
 * greeting ("Hello Dr Richard,") cannot be matched as a fixed phrase — the name is lead data — so
 * consumers strip the greeting LINE by shape instead, using these words. Derived from the greeting
 * builders themselves so a new language cannot be added in one place and missed in the other.
 */
export const RENDER_GREETING_WORDS: readonly string[] = [
  ...new Set([
    ...Object.values(NEUTRAL_GREETING),
    ...Object.values(NAMED_GREETING).map((build) => build('x')),
  ].map((greeting) => greeting.trim().split(/[\s,]+/)[0]!.toLocaleLowerCase())),
];

/**
 * The exact sentence the system will append for this email. Deterministic and step-aware, and
 * exported so the REVIEWER can be shown the CTA the recipient will actually receive — without it,
 * the reviewer judges a body whose ask it cannot see, and `binaryReplyClose` at step 3 would be a
 * guess about text the model never wrote.
 */
export function ctaSentenceFor(
  language: EmailLanguage,
  cta: EmailPrimaryCta,
  step: SequenceStep,
): string {
  // The final email closes; every earlier position keeps its existing behaviour exactly.
  if (step === FINAL_FOLLOWUP_STEP && cta === 'REPLY_FOR_DETAILS') return FINAL_CLOSE_CTA[language];
  return CTA_SENTENCE[language][cta];
}

export function demoLinkAllowed(demo: EmailDemoMeta | null): boolean {
  return demo !== null && demo.status === 'APPROVED';
}

export function buildEmailContext(
  inputs: EmailInputs,
  sequence: EmailSequencePosition,
): EmailValidationContext {
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
    // Required, never inferred: the subject rules differ completely between a first email and a
    // threaded follow-up, and guessing from the copy is what let a correctly-threaded follow-up be
    // rejected as "not unique".
    sequence,
  };
}

/** Assemble the final plain-text message after validation; no model controls URLs or signoff. */
export function renderEmail(
  out: EmailWriterOutput,
  inputs: EmailInputs,
  sequence: EmailSequencePosition = INITIAL_EMAIL_SEQUENCE,
): RenderedEmail {
  const language = resolveEmailLanguage(inputs.facts);
  // A personal greeting is gated on the RECIPIENT, not merely on a name being known: knowing the
  // owner's name says nothing about whose inbox `info@practice.co.uk` is. Without a PERSONAL_VERIFIED
  // recipient the greeting stays neutral even when a contact_name fact exists.
  const nameFact = personalNameAllowed(inputs.recipient) ? current(inputs.facts, 'contact_name') : undefined;
  const greeting = nameFact ? NAMED_GREETING[language](nameFact.value.trim()) : NEUTRAL_GREETING[language];
  const ctaKind: EmailCtaKind = out.primary_cta === 'VIEW_CONCEPT' ? 'demo_link' : 'reply';

  const body = [
    greeting,
    '',
    out.email_body.trim(),
    '',
    ctaSentenceFor(language, out.primary_cta, sequence.step),
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
    // A threaded follow-up keeps the original subject (as a reply); only a first email uses the
    // model's selected subject. A follow-up can never reach this with an absent thread subject:
    // `validateEmail` fails it closed (`followup_thread_subject_missing`) before render is trusted.
    subject: inputs.threadSubject ? replySubject(inputs.threadSubject) : out.selected_subject,
    body,
    ctaKind,
    hasDemoUrlPlaceholder: body.includes(DEMO_URL_TOKEN),
    factInputs,
    findingInputs,
  };
}
