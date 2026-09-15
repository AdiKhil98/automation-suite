import {
  DEMO_URL_TOKEN,
  type EmailSequencePosition,
  MAX_EMAIL_WORDS,
  replySubject,
  type EmailWriterOutput,
} from './email-types.js';
import { type EmailLanguage, hasForeignLanguage } from './email-language.js';
import { analyzeFollowupRepetition } from './followup-repetition.js';
import { FINAL_FOLLOWUP_STEP, type SequenceStep } from '../outreach/sequence.js';

export interface EmailValidationContext {
  availableEvidenceIds: Set<string>;
  factEvidenceIds: Set<string>;
  acceptedFindingIds: Set<string>;
  approvedDemoFindingIds: Set<string>;
  demoLinkAllowed: boolean;
  language: EmailLanguage;
  /**
   * Where this email sits in the sequence. REQUIRED and explicit — never inferred from the copy.
   * A first email authors three distinct subjects; a follow-up echoes the thread subject it was
   * given. Applying the first email's rules to a follow-up rejects every correctly-threaded
   * follow-up, which is exactly what happened in production before this field existed.
   */
  sequence: EmailSequencePosition;
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
// `click` matches model-authored CTA verbs ("click here", "click this link", "click below").
// The lookarounds exempt hyphenated compounds/technical nouns ("click-to-call", "click-through",
// "one-click") so a body describing the site's own click-to-call links is not mistaken for a CTA.
// `visit` requires a recipient-directed object ("visit our site", "visit us", "visit this link");
// bare intransitive prose ("deciding when to visit or call") is normal copy, not a CTA.
const CTA_IN_BODY_RE = /\b(?:reply|respond|book a call|schedule a call|call me|take a look|view (?:the|this)|open (?:the|this)|(?<!-)click(?!-)|visit (?:the|this|our|your|us|me)|antworten sie|schreiben sie mir|termin vereinbaren|ansehen|öffnen sie|klicken sie)\b/i;
const GENERIC_OPENING_RE = /^(?:i (?:just )?(?:wanted to|thought i(?:'d| would)|came across)|ich wollte mich kurz|ich dachte,? ich|in today'?s|in der heutigen|i hope|ich hoffe)/i;
// Day-1 narrow implementation-jargon backstop. Catches only UNMISTAKABLE technical leakage that a
// plain buyer-language email never contains — encoded spaces, a leading space in a link target,
// href / tel: link attributes, and the "phone target" diagnostic phrase. Intentionally narrow: it
// does NOT ban ordinary verbs such as click, test, or verify. The reviewer's buyerLanguageOnly /
// conversationNotAudit booleans catch the subtler mini-audit / diagnostic-tone failures.
export const IMPLEMENTATION_JARGON_RE = /%20|\bhref\b|\btel:|\bencoded spaces?\b|\bleading space\b|\bphone target\b/i;
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

// High-precision denylist for subjects that summarize the body — i.e. give away the finding,
// recommendation, or pitch before the email is opened. Intentionally narrow: it catches only the
// obvious "improvement/pitch verb + feature" and "feature + suggestion/opportunity/path" shapes
// (EN + DE). Subtle curiosity failures are NOT regex-detectable and are left to the reviewer's
// `subjectCuriosityGap` judgment. Prefer false negatives over false positives here.
const REVEALING_SUBJECTS = [
  // improvement/pitch verb + feature noun: "Improve your online booking"
  /\b(?:improve|improving|boost|boosting|optimi[sz]e|optimising|optimizing|fix|fixing|increase|increasing|upgrade|upgrading|enhance|enhancing|streamline|streamlining)\b[^.!?]*\b(?:booking|bookings|website|web\s?site|site|appointment|appointments|conversion|conversions|enquir(?:y|ies)|contact form|seo|checkout|funnel)\b/i,
  // feature noun + pitch suffix: "Website booking suggestion", "Direct booking opportunity", "appointment booking path"
  /\b(?:booking|bookings|website|web\s?site|homepage|appointment|appointments|conversion|conversions|enquir(?:y|ies)|checkout|seo)\b[^.!?]*\b(?:suggestion|suggestions|idea|ideas|opportunity|opportunities|improvement|improvements|tip|tips|fix|fixes|path)\b/i,
  // German verb + feature noun
  /\b(?:verbessern|verbessere|optimieren|optimiere|steigern|steigere|erhöhen|erhöhe|beheben)\b[^.!?]*\b(?:buchung|buchungen|website|webseite|homepage|termin(?:e|buchung)?|conversion|kontaktformular|anfrage)\b/i,
  // German feature noun + pitch suffix
  /\b(?:buchung|buchungen|website|webseite|homepage|termin(?:e)?|conversion|kontaktformular)\b[^.!?]*\b(?:vorschlag|idee|chance|möglichkeit|verbesserung|tipp|hinweis)\b/i,
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

function isRevealingSubject(subject: string): boolean {
  const normalized = subject.trim();
  return REVEALING_SUBJECTS.some((pattern) => pattern.test(normalized));
}

/**
 * Subject rules, which are STEP-DEPENDENT because the subject has a different author per step.
 *
 * STEP 0 — the model authors the subject. Three genuinely distinct options, the selected one among
 * them, none generic, none giving the finding away. Unchanged.
 *
 * STEPS 1-3 — the model authors NOTHING here. A follow-up continues an existing Gmail thread, so
 * `renderEmail` builds the outgoing subject deterministically from the thread subject and discards
 * the model's selection entirely (`src/prompts/email/sequence-jobs.ts` instructs the writer to echo
 * the supplied thread subject into all three options and into `selected_subject`). Demanding three
 * unique options there rejected every correctly-threaded follow-up before the reviewer was ever
 * called — the production failure this replaces.
 *
 * The follow-up branch does NOT simply skip subject validation: it validates the contract the
 * prompt states, so a model that invents a fresh hook, drops the thread subject, or selects
 * something it did not offer still fails closed. Comparison runs through the SAME `replySubject`
 * rule the renderer uses, so an echo that already carries the reply prefix is accepted while any
 * change to the subject TEXT (including case) is a violation.
 *
 * Genericity/revealing checks do not apply to a follow-up echo: that subject is already in the
 * recipient's inbox and passed these very checks when the first email was composed. Re-judging it
 * could only reject copy that was already sent.
 */
function validateSubjects(
  out: EmailWriterOutput,
  subjects: string[],
  sequence: EmailSequencePosition,
): string[] {
  const violations: string[] = [];
  const selected = out.selected_subject.trim();

  if (sequence.step === 0) {
    if (new Set(subjects.map((s) => s.toLocaleLowerCase())).size !== 3) violations.push('subject_options_not_unique');
    if (!subjects.includes(selected)) violations.push('selected_subject_not_in_options');
    subjects.forEach((subject, index) => {
      if (isGenericSubject(subject)) violations.push(`generic_subject:${String(index + 1)}`);
      if (isRevealingSubject(subject)) violations.push(`subject_reveals_finding:${String(index + 1)}`);
    });
    return violations;
  }

  // A follow-up without a thread subject is not a recoverable state: the composition was handed no
  // thread to continue, so nothing can prove the email would land in the existing conversation.
  // Fail closed rather than let the model's invented subject start a second thread.
  const thread = sequence.threadSubject?.trim() ?? '';
  if (thread === '') return ['followup_thread_subject_missing'];

  const expected = replySubject(thread);
  subjects.forEach((subject, index) => {
    if (replySubject(subject) !== expected) violations.push(`followup_subject_not_thread_subject:${String(index + 1)}`);
  });
  if (replySubject(selected) !== expected) violations.push('followup_selected_subject_not_thread_subject');
  return violations;
}

/**
 * CTA COMPATIBILITY WITH THE SEQUENCE POSITION.
 *
 * The FINAL email closes the sequence with one clean yes/no decision, and the renderer appends a
 * deterministic binary sentence for exactly that. A demo link at that position asks for something
 * else entirely — it reopens the conversation the email exists to close — so `VIEW_CONCEPT` is
 * refused there outright rather than silently rendered as something it is not.
 *
 * Steps 1 and 2 get no extra CTA rule: their lesson jobs say nothing about which ask is appropriate
 * beyond the single-CTA requirement every step already carries, and inventing one here would be a
 * rule with no source. The "no second ask in the body" constraint is enforced globally by
 * `cta_in_model_body`, which is why the deterministic close cannot collide with a model-written one.
 */
function validateSequenceCta(out: EmailWriterOutput, sequence: EmailSequencePosition): string[] {
  if (sequence.step === FINAL_FOLLOWUP_STEP && out.primary_cta !== 'REPLY_FOR_DETAILS') {
    return [`final_step_requires_binary_reply_cta:${out.primary_cta}`];
  }
  return [];
}

/**
 * How generic the copy may honestly be, by position.
 *
 * `genericity_score` measures how reusable the copy would be for almost any business — STANDALONE.
 * A first email has nothing but itself, so it must be specific. A Follow-up #3 compression and a
 * Follow-up #4 close are deliberately short and are read INSIDE a thread that already carries the
 * specificity; judged alone they legitimately look reusable, and the same 40 ceiling would make a
 * truthful model self-reject for doing its job. The answer is not to tell the model to report a
 * lower number — it must stay honest — but to stop reading a standalone measure as if the message
 * were standalone.
 *
 * A high ceiling remains at every step: copy that would read as bulk mail to anyone, in any thread,
 * is still refused. Everything else that keeps a follow-up honest — the anti-replay gate, the
 * sequence job, forbidden phrases, evidence binding — is unchanged.
 */
const GENERICITY_CEILING: Record<SequenceStep, number> = {
  0: 40,
  // A clarity layer is about one specific issue; it should read as specifically as a first email.
  1: 40,
  // Compression and close: the thread supplies the specificity, so only outright bulk-mail copy fails.
  2: 80,
  3: 80,
};

/**
 * How many paragraphs each position may have. A cold email needs room to make its case; a follow-up
 * does not, and two of them are explicitly supposed to shrink. Requiring 2-4 paragraphs everywhere
 * was a first-email assumption that deterministically rejected copy doing its own job: Follow-up #3
 * compresses to "ideally one or two short sentences" and Follow-up #4 is a shorter final close.
 *
 * The MAXIMUM word count and every safety rule stay global and unchanged — this loosens structure
 * for the steps whose job is to be shorter, never the limits that keep copy honest.
 */
const PARAGRAPH_SHAPE: Record<SequenceStep, { min: number; max: number }> = {
  // Outreach #1: observation, why it matters, and the ask — the classic shape.
  0: { min: 2, max: 4 },
  // Follow-up #2 adds one clarity layer; it may be a single tight paragraph.
  1: { min: 1, max: 3 },
  // Follow-up #3 compresses. Two paragraphs is already generous.
  2: { min: 1, max: 2 },
  // Follow-up #4 closes. One or two short paragraphs, nothing more.
  3: { min: 1, max: 2 },
};

/**
 * A follow-up may REFERENCE what came before; it may not REPLAY it. Deterministic, model-free
 * comparison against the bodies already sent in this thread, refused before the reviewer is ever
 * called. Which checks apply depends on the step's lesson job — step 1 must add clarity, while a
 * step-2 compression and a step-3 close are not required to add anything at all. See
 * `followup-repetition.ts` for the policy, the thresholds and the normalisation.
 *
 * Referencing the same issue is explicitly fine — the shared subject of the conversation is the
 * whole point of a thread.
 */
function validateFollowupDoesNotReplay(body: string, sequence: EmailSequencePosition): string[] {
  if (sequence.step === 0) return [];
  if (sequence.priorMessageBodies.length === 0) {
    // A follow-up continues a thread that, by definition, already contains at least the initial
    // email. An empty list means the comparison CANNOT be performed — the thread could not be read,
    // or the caller did not supply it — and an unperformed check must never read as a pass.
    return ['followup_prior_messages_missing'];
  }
  const analysis = analyzeFollowupRepetition({
    step: sequence.step,
    candidateBody: body,
    priorBodies: sequence.priorMessageBodies,
    threadSubject: sequence.threadSubject,
  });
  if (!analysis.repeats) return [];
  return [
    'followup_repeats_prior_message',
    // Diagnostic companion: which rule fired and on what measurement, so a rejected draft can be
    // understood without re-running anything.
    `followup_repetition:${analysis.reason ?? 'UNKNOWN'}:run=${String(analysis.longestSharedRun)}`
      + `:reuse=${analysis.sharedBigramRatio.toFixed(2)}:novel=${String(analysis.novelContentTokens)}`,
  ];
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

  violations.push(...validateSubjects(out, subjects, ctx.sequence));
  violations.push(...validateFollowupDoesNotReplay(body, ctx.sequence));
  violations.push(...validateSequenceCta(out, ctx.sequence));
  const genericityCeiling = GENERICITY_CEILING[ctx.sequence.step];
  if (out.genericity_score > genericityCeiling) {
    violations.push(`genericity_score_too_high:${String(out.genericity_score)}`);
  }

  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const shape = PARAGRAPH_SHAPE[ctx.sequence.step];
  if (paragraphs.length < shape.min || paragraphs.length > shape.max) {
    violations.push(`unnatural_paragraph_count:${String(paragraphs.length)}`);
  }
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
  if (IMPLEMENTATION_JARGON_RE.test(allModelText)) violations.push('contains_implementation_jargon');

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
  // Clock-time colons (H:MM / HH:MM) are natural prose, not stylistic punctuation; strip them
  // before counting so a body that cites opening hours is not flagged for colon overuse.
  const styleColons = (body.replace(/\b\d{1,2}:\d{2}\b/g, '').match(/:/g) ?? []).length;
  if (styleColons > 2) violations.push('excessive_colons');
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
