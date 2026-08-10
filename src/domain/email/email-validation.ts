import { DEMO_URL_TOKEN, MAX_EMAIL_WORDS, type EmailWriterOutput } from './email-types.js';
import { type EmailLanguage, hasForeignLanguage } from './email-language.js';

export interface EmailValidationContext {
  availableEvidenceIds: Set<string>;
  factEvidenceIds: Set<string>;
  acceptedFindingIds: Set<string>;
  approvedDemoFindingIds: Set<string>;
  demoLinkAllowed: boolean;
  language: EmailLanguage;
}

export interface EmailValidationResult {
  ok: boolean;
  violations: string[];
}

// These content predicates are exported (behavior unchanged) so the operator-authored-email validator
// can apply the SAME prohibited-content / punctuation / language rules to a rendered human email without
// duplicating regexes. `validateEmail` (the AI-writer gate) uses them exactly as before.
export const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|de|net|org|io|co|uk|eu|example)\b/i;
export const METRIC_RE = /\b\d+\s?%|\b\d[\d,.]*\s+(?:visitors?|clicks?|leads?|customers?|patients?|sales|conversions?|rankings?|positions?)\b/i;
export const PERFORMANCE_RE = /\b(?:revenue|traffic|rankings?|conversion rate|roi|return on investment|double (?:your|the)|triple|boost (?:your )?sales|more (?:patients|customers|leads)|lose (?:customers|patients)|guaranteed?)\b/i;
export const FAKE_URGENCY_RE = /\b(?:act now|urgent(?:ly)?|immediately|last chance|don'?t miss|limited time|only available this week|hurry|expires soon|nur diese woche|letzte chance|sofort handeln)\b/i;
export const UNSUPPORTED_BEHAVIOR_RE = /\b(?:visitors?|patients?|customers?)\s+(?:are|will be|werden|würden)\s+(?:leaving|leave|abandon|lost|abspringen|verlassen)\b/i;
export const COMPETITOR_RE = /\b(?:competitors?|competition|other (?:clinics?|practices?|businesses)|market leaders?|mitbewerber|konkurrenz|andere (?:kliniken|praxen|unternehmen))\b/i;
export const DEMO_MENTION_RE = /\b(?:demo|mock-?up|redesign|concept|preview|prototype|mockup|konzept|entwurf|vorschau)\b/i;
const CTA_IN_BODY_RE = /\b(?:reply|respond|book a call|schedule a call|call me|take a look|view (?:the|this)|open (?:the|this)|click|visit|antworten sie|schreiben sie mir|termin vereinbaren|ansehen|öffnen sie|klicken sie)\b/i;
const GENERIC_OPENING_RE = /^(?:i (?:just )?(?:wanted to|thought i(?:'d| would)|came across)|ich wollte mich kurz|ich dachte,? ich|in today'?s|in der heutigen|i hope|ich hoffe)/i;
export const MARKDOWN_RE = /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|\[[^\]]+\]\([^)]+\)|`{1,3}|\*\*|__/m;
export const EMOJI_RE = /\p{Extended_Pictographic}/u;
export const REPEATED_COMMA_RE = /,\s*,/;
export const CAUTIOUS_RE = /\b(?:perhaps|maybe|possibly|might|could potentially|should perhaps be reviewed|vielleicht|möglicherweise|eventuell|könnte möglicherweise|sollte vielleicht geprüft werden)\b/gi;

export const FORBIDDEN_PHRASES = [
  'in der heutigen digitalen welt',
  'in der heutigen schnelllebigen zeit',
  'es ist wichtig zu beachten',
  'wir freuen uns, ihnen mitzuteilen',
  'maßgeschneiderte lösung',
  'auf das nächste level bringen',
  'revolutionieren',
  'optimieren sie ihre online-präsenz',
  'potenzial voll ausschöpfen',
  'nahtlose benutzererfahrung',
  'ich wollte mich kurz melden',
  'ich hoffe, diese nachricht erreicht sie gut',
  'könnte möglicherweise',
  "in today's digital world",
  "in today’s digital world",
  "in today's fast-paced environment",
  "in today’s fast-paced environment",
  'i hope this email finds you well',
  'take your business to the next level',
  'unlock your full potential',
  'cutting-edge solution',
  'seamless user experience',
  'revolutionize your online presence',
  'just wanted to reach out',
  'game-changing',
  'tailored solution',
] as const;

const GENERIC_SUBJECTS = [
  /^(?:website idea|quick question|improve your website|new website concept|a suggestion for your website)(?:\s+for\s+.+)?$/i,
  /^(?:website-idee|kurze frage|website verbessern|neues website-konzept|vorschlag für ihre website)(?:\s+für\s+.+)?$/i,
  /^(?:a )?quick note (?:on|about) (?:your|the) (?:practice )?website$/i,
  /^(?:website|webseite|homepage)\s*(?:idea|note|suggestion|idee|hinweis|vorschlag)?$/i,
] as const;

export function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function occurrences(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}

function isGenericSubject(subject: string): boolean {
  const normalized = subject.trim();
  return normalized.length < 8 || GENERIC_SUBJECTS.some((pattern) => pattern.test(normalized));
}

/**
 * Fail-closed deterministic copy gate. It checks objective syntax, provenance, CTA, competitor,
 * urgency, genericity, and approved-demo bindings before the independent reviewer is called.
 */
export function validateEmail(out: EmailWriterOutput, ctx: EmailValidationContext): EmailValidationResult {
  const violations: string[] = [];
  const subjects = out.subject_options.map((subject) => subject.trim());
  const body = out.email_body.trim();
  const copySegments = [...subjects, body];
  const strategySegments = [
    out.selected_subject_reason,
    out.strategic_angle,
    out.business_relevance,
    out.urgency_basis,
  ];
  const allModelText = [...copySegments, ...strategySegments].join('\n');

  if (new Set(subjects.map((s) => s.toLocaleLowerCase())).size !== 3) violations.push('subject_options_not_unique');
  if (!subjects.includes(out.selected_subject.trim())) violations.push('selected_subject_not_in_options');
  subjects.forEach((subject, index) => {
    if (isGenericSubject(subject)) violations.push(`generic_subject:${String(index + 1)}`);
  });
  if (out.genericity_score > 40) violations.push(`genericity_score_too_high:${String(out.genericity_score)}`);

  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2 || paragraphs.length > 4) violations.push(`unnatural_paragraph_count:${String(paragraphs.length)}`);
  if (wordCount(body) > MAX_EMAIL_WORDS) violations.push(`body_too_long:${String(wordCount(body))}`);
  if (GENERIC_OPENING_RE.test(paragraphs[0] ?? '')) violations.push('generic_opening');

  if (out.evidence_ids.length === 0) violations.push('missing_evidence_ids');
  if (new Set(out.evidence_ids).size !== out.evidence_ids.length) violations.push('duplicate_evidence_ids');
  for (const id of out.evidence_ids) {
    if (!ctx.availableEvidenceIds.has(id)) violations.push(`evidence_id_not_available:${id}`);
  }
  if (!out.evidence_ids.some((id) => ctx.acceptedFindingIds.has(id))) violations.push('missing_finding_evidence');

  if (URL_RE.test(allModelText)) violations.push('contains_url');
  if (METRIC_RE.test(allModelText)) violations.push('contains_metric_claim');
  if (PERFORMANCE_RE.test(allModelText)) violations.push('contains_performance_claim');
  if (FAKE_URGENCY_RE.test(allModelText)) violations.push('contains_fake_urgency');
  if (UNSUPPORTED_BEHAVIOR_RE.test(allModelText)) violations.push('contains_unsupported_customer_behavior');
  // Phase 7A3B — competitor handling is conditional on the evidence mode.
  // NONE (default, and always the RAW MODEL OUTPUT): any competitor language is unsupported — hard fail.
  // APPROVED_COMPETITOR_PATTERN_PACKAGE (final composer artifact only): the anonymized, package-supported
  // wording is permitted in the BODY, but the subject must stay competitor-free and the deep checks
  // (exact wording, identity leakage, exact counts, per-sentence traceability) are enforced separately by
  // `validateEnrichedComposition`. Performance/volume/ranking language stays blocked in both modes above.
  if (out.competitor_evidence_used === 'APPROVED_COMPETITOR_PATTERN_PACKAGE') {
    if (subjects.some((s) => COMPETITOR_RE.test(s))) violations.push('competitor_language_in_subject');
  } else if (COMPETITOR_RE.test(allModelText) || out.competitor_evidence_used !== 'NONE') {
    violations.push('unsupported_competitor_language');
  }
  if (CTA_IN_BODY_RE.test(body)) violations.push('cta_in_model_body');

  const lowered = allModelText.toLocaleLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lowered.includes(phrase)) violations.push(`forbidden_phrase:${phrase}`);
  }
  if (occurrences(allModelText, CAUTIOUS_RE) > 2) violations.push('excessive_cautious_wording');

  if (copySegments.some((s) => s.includes('\u2014'))) violations.push('contains_em_dash');
  if (copySegments.some((s) => s.includes('\u2013'))) violations.push('contains_en_dash_separator');
  if (copySegments.some((s) => s.includes('--'))) violations.push('contains_double_hyphen');
  if (copySegments.some((s) => REPEATED_COMMA_RE.test(s))) violations.push('contains_repeated_commas');
  if (MARKDOWN_RE.test(body)) violations.push('contains_markdown');
  if (EMOJI_RE.test(allModelText)) violations.push('contains_emoji');
  if ((body.match(/:/g) ?? []).length > 2) violations.push('excessive_colons');
  if ((body.match(/;/g) ?? []).length > 1) violations.push('semicolon_heavy');

  if (out.prohibited_phrase_scan !== 'PASS') violations.push('writer_prohibited_phrase_scan_failed');
  if (out.punctuation_scan !== 'PASS') violations.push('writer_punctuation_scan_failed');
  if (out.human_style_result !== 'PASS') violations.push('writer_human_style_failed');

  const mentionsDemo = DEMO_MENTION_RE.test(body);
  if (out.primary_cta === 'VIEW_CONCEPT') {
    if (!ctx.demoLinkAllowed) violations.push('demo_cta_without_approved_demo');
    if (!mentionsDemo) violations.push('demo_value_not_explained');
    if (out.demo_alignment_result !== 'PASS') violations.push('demo_alignment_not_passed');
    if (ctx.approvedDemoFindingIds.size === 0) violations.push('approved_demo_has_no_finding_bindings');
    if (!out.evidence_ids.some((id) => ctx.approvedDemoFindingIds.has(id))) violations.push('demo_claim_not_bound_to_demo_finding');
  } else {
    if (out.demo_alignment_result !== 'NOT_APPLICABLE') violations.push('unexpected_demo_alignment_result');
    if (mentionsDemo) violations.push('mentions_demo_without_demo_cta');
  }
  if (!ctx.demoLinkAllowed && mentionsDemo) violations.push('mentions_demo_without_approved_demo');
  if (allModelText.includes(DEMO_URL_TOKEN)) violations.push('model_emitted_demo_url_token');

  const usesConversionHub = /\bconversion hub\b/i.test(allModelText);
  const explainsConversionPath = /\b(?:booking|enquir|contact|appointment|action|patient|customer|conversion path)\b/i.test(
    `${out.business_relevance} ${body}`,
  );
  if (usesConversionHub && !explainsConversionPath) violations.push('forced_conversion_hub_language');

  if (hasForeignLanguage(ctx.language, copySegments)) violations.push(`mixed_language:expected_${ctx.language}`);

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
