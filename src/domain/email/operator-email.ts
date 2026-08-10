import { hashCanonical } from '../../utils/hash.js';
import { findProhibitedClaims } from '../deterministic-finding/prohibited.js';
import { type EmailLanguage, hasForeignLanguage } from './email-language.js';
import { MAX_SUBJECT_LENGTH } from './email-types.js';
import {
  CAUTIOUS_RE,
  COMPETITOR_RE,
  DEMO_MENTION_RE,
  EMOJI_RE,
  FAKE_URGENCY_RE,
  FORBIDDEN_PHRASES,
  MARKDOWN_RE,
  METRIC_RE,
  occurrences,
  PERFORMANCE_RE,
  REPEATED_COMMA_RE,
  UNSUPPORTED_BEHAVIOR_RE,
  URL_RE,
  wordCount,
} from './email-validation.js';

/**
 * Operator-authored email support (rules `operator-email-1`). An operator email is a fully-rendered,
 * human-written outreach email (greeting + body + CTA + signoff) — NOT structured AI-writer output. It
 * is stored in the existing `email_drafts` table with `authorship='OPERATOR'`, so these constants also
 * supply the honest sentinels used where legacy NOT NULL AI columns require a value.
 */
export const OPERATOR_EMAIL_RULES_VERSION = 'operator-email-1';
export const OPERATOR_AUTHORSHIP = 'OPERATOR' as const;
/** Honest sentinel written into the AI-only NOT NULL columns of an operator row (provider/model/prompt). */
export const OPERATOR_SENTINEL = 'OPERATOR';
/** A rendered operator email is bounded but generous (it includes greeting + signoff, unlike an AI body). */
export const OPERATOR_MAX_EMAIL_WORDS = 200;

export interface OperatorEmailInput {
  subject: string;
  body: string;
  language: EmailLanguage;
}

export interface OperatorEmailValidationResult {
  ok: boolean;
  violations: string[];
}

/**
 * Deterministic copy gate for a rendered operator email (fail-closed). It reuses the EXACT
 * prohibited-content / punctuation / language predicates the AI writer gate (`validateEmail`) enforces,
 * plus the deterministic-finding prohibited-claim denylist, so an operator email must still fail on any
 * unsupported/prohibited content (URLs, metrics, performance/revenue claims, competitor language, fake
 * urgency, unsupported customer-behavior, forbidden phrases, markdown/emoji/dash artifacts, demo mentions
 * without an approved demo, booking overstatements). Structural AI-only checks (3 subject options, writer
 * self-scores) are intentionally NOT applied — a human wrote the final text. No I/O.
 */
export function validateOperatorEmail(input: OperatorEmailInput): OperatorEmailValidationResult {
  const violations: string[] = [];
  const subject = input.subject.trim();
  const body = input.body.trim();
  const all = [subject, body].join('\n');

  if (subject.length === 0) violations.push('empty_subject');
  if (subject.length > MAX_SUBJECT_LENGTH) violations.push(`subject_too_long:${String(subject.length)}`);
  if (body.length === 0) violations.push('empty_body');
  if (wordCount(body) > OPERATOR_MAX_EMAIL_WORDS) violations.push(`body_too_long:${String(wordCount(body))}`);

  if (URL_RE.test(all)) violations.push('contains_url');
  if (METRIC_RE.test(all)) violations.push('contains_metric_claim');
  if (PERFORMANCE_RE.test(all)) violations.push('contains_performance_claim');
  if (FAKE_URGENCY_RE.test(all)) violations.push('contains_fake_urgency');
  if (UNSUPPORTED_BEHAVIOR_RE.test(all)) violations.push('contains_unsupported_customer_behavior');
  // Prospect-only operator email: any competitor language is unsupported (no approved package path here).
  if (COMPETITOR_RE.test(all)) violations.push('unsupported_competitor_language');
  // No demo is bound to an operator deterministic email; a demo mention would be unsupported.
  if (DEMO_MENTION_RE.test(body)) violations.push('mentions_demo_without_approved_demo');

  const lowered = all.toLocaleLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lowered.includes(phrase)) violations.push(`forbidden_phrase:${phrase}`);
  }
  if (occurrences(all, CAUTIOUS_RE) > 2) violations.push('excessive_cautious_wording');

  if (all.includes('—')) violations.push('contains_em_dash');
  if (all.includes('–')) violations.push('contains_en_dash_separator');
  if (all.includes('--')) violations.push('contains_double_hyphen');
  if (REPEATED_COMMA_RE.test(all)) violations.push('contains_repeated_commas');
  if (MARKDOWN_RE.test(body)) violations.push('contains_markdown');
  if (EMOJI_RE.test(all)) violations.push('contains_emoji');
  if ((body.match(/:/g) ?? []).length > 2) violations.push('excessive_colons');
  if ((body.match(/;/g) ?? []).length > 1) violations.push('semicolon_heavy');

  // Reuse the deterministic-finding prohibited-claim denylist (booking overstatements, loss/revenue/
  // conversion/competitor/performance/contact-form-absence claims). Defense in depth on the rendered text.
  for (const label of findProhibitedClaims(all)) violations.push(`prohibited_claim:${label}`);

  if (hasForeignLanguage(input.language, [subject, body])) violations.push(`mixed_language:expected_${input.language}`);

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

export interface OperatorEmailHashInput {
  leadId: string;
  deterministicFindingId: string;
  subject: string;
  body: string;
  evidenceIds: string[];
  rulesVersion: string;
}

/**
 * Reproducible message hash over the identity-defining inputs (evidence ids sorted so ordering never
 * changes the hash). Recomputable from the stored email + finding + evidence to prove exact-text provenance.
 */
export function computeOperatorEmailHash(input: OperatorEmailHashInput): string {
  return hashCanonical({
    leadId: input.leadId,
    deterministicFindingId: input.deterministicFindingId,
    subject: input.subject,
    body: input.body,
    evidenceIds: [...input.evidenceIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    rulesVersion: input.rulesVersion,
  });
}
