import {
  CTA_LABELS_FOR_KIND,
  DEMO_URL_TOKEN,
  type EmailFactKey,
  type EmailWriterOutput,
  MAX_EMAIL_WORDS,
} from './email-types.js';
import { type EmailLanguage, hasForeignLanguage } from './email-language.js';

export interface EmailValidationContext {
  availableFactKeys: Set<EmailFactKey>;
  /** findingRefs of accepted, outreach-safe Phase 6 findings the email may reference. */
  acceptedFindingRefs: Set<string>;
  /** True only when a human-APPROVED, deployment-eligible demo exists. */
  demoLinkAllowed: boolean;
  /** True when a verified contact-name fact exists (enables a NAMED greeting). */
  hasContactName: boolean;
  /** Required output language (from verified prospect signals). */
  language: EmailLanguage;
}

export interface EmailValidationResult {
  ok: boolean;
  violations: string[];
}

// Body text is model-authored prose, so these anchored patterns are the deterministic
// backstop (the reviewer is the second line). Matches indicate a real violation.
const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|de|net|org|io|co|uk|eu)\b/i;
const METRIC_RE = /\b\d+\s?%|\b\d[\d,.]*\s+(?:visitors?|clicks?|leads?|customers?|patients?|sales|conversions?|rankings?|positions?)\b/i;
const CLAIM_WORDS = /\b(?:revenue|traffic|ranking|rankings|conversion rate|conversions|roi|return on investment|double (?:your|the)|triple|boost (?:your )?sales|more (?:patients|customers|leads)|lose (?:customers|patients)|guaranteed?)\b/i;
const URGENCY_RE = /\b(?:act now|urgent(?:ly)?|immediately|last chance|don'?t miss|limited time|hurry|expires soon)\b/i;
const FAMILIARITY_RE = /\b(?:as we discussed|as you know|following up on our (?:call|conversation|chat)|great (?:chatting|speaking)|nice (?:chatting|speaking)|per our conversation)\b/i;
const INSULT_RE = /\b(?:ugly|terrible|awful|embarrassing|pathetic|stupid|garbage|hideous|amateurish)\b/i;
const DEMO_MENTION_RE = /\b(?:demo|mock-?up|redesign|concept site|preview|prototype|mockup)\b/i;

/**
 * Deterministic email validation (amendment 5). Every personalized reference must resolve
 * to a verified fact or accepted finding; the prose must be free of URLs, performance/metric
 * claims, invented urgency/familiarity, and insults; and a demo may be referenced only when a
 * human-approved demo exists. This is the code backstop beneath the adversarial reviewer.
 */
export function validateEmail(out: EmailWriterOutput, ctx: EmailValidationContext): EmailValidationResult {
  const violations: string[] = [];

  // Length + structure.
  const words = out.bodyParagraphs.join(' ').trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_EMAIL_WORDS) violations.push(`body_too_long:${String(words)}`);

  // References resolve.
  for (const fk of out.factRefs) if (!ctx.availableFactKeys.has(fk)) violations.push(`unavailable_fact_ref:${fk}`);
  for (const fr of out.findingRefs) if (!ctx.acceptedFindingRefs.has(fr)) violations.push(`finding_ref_not_accepted:${fr}`);

  // CTA honesty.
  if (out.ctaKind === 'demo_link' && !ctx.demoLinkAllowed) violations.push('demo_link_without_approved_demo');
  if (!CTA_LABELS_FOR_KIND[out.ctaKind].includes(out.ctaLabelKey)) violations.push(`cta_label_kind_mismatch:${out.ctaLabelKey}:${out.ctaKind}`);

  // Prose scans over subject + paragraphs.
  const segments = [out.subject, ...out.bodyParagraphs];
  const scan = (re: RegExp, code: string): void => {
    if (segments.some((s) => re.test(s))) violations.push(code);
  };
  scan(URL_RE, 'contains_url');
  scan(METRIC_RE, 'contains_metric_claim');
  scan(CLAIM_WORDS, 'contains_performance_claim');
  scan(URGENCY_RE, 'contains_urgency');
  scan(FAMILIARITY_RE, 'contains_fake_familiarity');
  scan(INSULT_RE, 'contains_insult');

  // Single-language: the model-authored subject + body must be in the target language only.
  // (Greeting/CTA/signoff are deterministic and already language-matched.)
  if (hasForeignLanguage(ctx.language, segments)) violations.push(`mixed_language:expected_${ctx.language}`);

  // A demo may only be referenced when a human-approved demo exists. When it isn't, neither
  // the {{DEMO_URL}} token nor any demo/redesign/concept wording may appear.
  if (!ctx.demoLinkAllowed) {
    if (segments.some((s) => s.includes(DEMO_URL_TOKEN))) violations.push('demo_url_token_without_approved_demo');
    scan(DEMO_MENTION_RE, 'mentions_demo_without_approved_demo');
  }
  // The model must never emit the token itself even when allowed — the renderer inserts it.
  if (segments.some((s) => s.includes(DEMO_URL_TOKEN))) violations.push('model_emitted_demo_url_token');

  return { ok: violations.length === 0, violations };
}
