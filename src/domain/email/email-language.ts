import { type LeadFact } from '../lead-facts/lead-fact.js';

/** Supported output languages (MVP). Extend the maps in email-render + markers below. */
export const EMAIL_LANGUAGES = ['en', 'de'] as const;
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number];

const current = (facts: LeadFact[], t: string): string | null => {
  const f = facts.find((x) => x.factType === t && x.isCurrent && x.value.trim() !== '');
  return f ? f.value.trim() : null;
};

const DE_COUNTRY = /^(de|at|ch|germany|deutschland|austria|österreich|switzerland|schweiz)$/i;
const DE_TLD = /\.(de|at|ch)(\/|$|\?)/i;

/**
 * Determine the email language from verified prospect signals: an explicit country fact,
 * else the official domain / website / domain TLD. Defaults to English. Purely deterministic —
 * the model is TOLD the language and must write the whole email in it.
 */
export function resolveEmailLanguage(facts: LeadFact[]): EmailLanguage {
  const country = current(facts, 'country');
  if (country && DE_COUNTRY.test(country)) return 'de';
  for (const t of ['official_website_url', 'official_domain', 'domain']) {
    const v = current(facts, t);
    if (v && DE_TLD.test(v.toLowerCase())) return 'de';
  }
  return 'en';
}

// High-signal, language-exclusive function words (avoid proper-noun false positives).
const EN_MARKERS = /\b(?:the|and|your|you|our|with|this|that|would|could|please|appointment)\b/i;
const DE_MARKERS = /\b(?:und|der|die|das|Sie|Ihre|könnte|würde|für|auf|eine|einen|nicht|sich)\b/i;

/** True when `segments` contain function words of a language OTHER than `target` — the
 * deterministic mixed-language backstop beneath the reviewer. */
export function hasForeignLanguage(target: EmailLanguage, segments: string[]): boolean {
  const other = target === 'de' ? EN_MARKERS : DE_MARKERS;
  return segments.some((s) => other.test(s));
}
