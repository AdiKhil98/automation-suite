import { describe, expect, it } from 'vitest';
import { type EmailValidationContext, validateEmail } from '../../src/domain/email/email-validation.js';
import {
  ctaSentenceFor,
  renderEmail,
  type EmailInputs,
} from '../../src/domain/email/email-render.js';
import {
  isEmailReviewApprovable,
  reviewApplicabilityMatrix,
} from '../../src/domain/email/email-review-gate.js';
import {
  INITIAL_EMAIL_SEQUENCE,
  PARAGRAPH_SHAPE,
  paragraphRangeText,
  type EmailWriterOutput,
} from '../../src/domain/email/email-types.js';
import {
  buildEmailReviewerMessages,
  buildEmailWriterMessages,
  type EmailBrief,
  type SequenceContext,
} from '../../src/prompts/email/index.js';
import { type EmailWriterParsed } from '../../src/domain/email/email-schema.js';
import { type EmailReviewParsed } from '../../src/domain/email/email-schema.js';
import { type SequenceStep } from '../../src/domain/outreach/sequence.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';
import { FOLLOWUP_REPETITION_FIXTURES } from '../fixtures/followup-clarity.js';

/**
 * THE WHOLE SEQUENCE, THROUGH THE REAL COMPONENTS.
 *
 * Lexical tests prove the anti-replay arithmetic. These prove the thing that actually matters: that
 * a correct email at each position survives deterministic validation, the approval gate, and the
 * renderer — and that the production failure does not. Every step has a different job, so "valid"
 * means something different at each one:
 *
 *   0  Outreach #1   observation -> why it matters -> outcome, 2-4 paragraphs
 *   1  Follow-up #2  one new clarity layer
 *   2  Follow-up #3  compression: shorter, no new argument
 *   3  Follow-up #4  binary close: no observation, no outcome, no persuasion, one yes/no ask
 *
 * No model is called anywhere in this file: every check here is deterministic code.
 */

const { initial, followups } = FOLLOWUP_REPETITION_FIXTURES;
const firstEmail = (): EmailWriterOutput =>
  EMAIL_COPY_FIXTURES.find((f) => f.name === 'strong English business email')!.writer;

/** A writer output for a given step: follow-ups echo the thread subject, as the contract requires. */
const draftFor = (step: SequenceStep, body: string, over: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
  ...firstEmail(),
  ...(step === 0 ? {} : {
    subject_options: [initial.subject, initial.subject, initial.subject],
    selected_subject: initial.subject,
    selected_subject_reason: 'Thread continuity is preserved.',
  }),
  email_body: body,
  ...over,
});

const ctxFor = (step: SequenceStep, priorBodies: readonly string[]): EmailValidationContext => ({
  sequence: step === 0
    ? INITIAL_EMAIL_SEQUENCE
    : { step, threadSubject: initial.subject, priorMessageBodies: priorBodies },
  availableEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services', 'finding-cta', 'finding-other']),
  factEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services']),
  acceptedFindingIds: new Set(['finding-cta', 'finding-other']),
  approvedDemoFindingIds: new Set(),
  demoLinkAllowed: false,
  language: 'en',
});

const inputs: EmailInputs = { facts: [], findings: [], demo: null, threadSubject: initial.subject };

const review = (over: Partial<EmailReviewParsed> = {}): EmailReviewParsed => ({
  decision: 'APPROVE', fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true,
  openingSpecific: true, businessRelevanceClear: true, urgencySupported: true,
  competitorClaimsSupported: true, humanStylePass: true, punctuationPass: true, singlePrimaryCta: true,
  sufficientlyPersonalized: true, evidenceSupported: true, demoAligned: true, persuasive: true,
  singleObservation: true, buyerLanguageOnly: true, conversationNotAudit: true, confidentObservation: true,
  addsClarityNotRestart: true, compressedNotExpanded: true, pressureReduced: true, binaryReplyClose: true,
  problems: [], requiredRevisions: [], ...over,
});

/** Minimal brief + draft, so the prompts can be generated without touching a model. */
const brief: EmailBrief = {
  businessName: 'Complete Dentistry',
  contactName: null,
  language: 'en',
  facts: [{ evidenceId: 'fact-business', type: 'business_name', value: 'Complete Dentistry' }],
  findings: [{ evidenceId: 'finding-cta', findingRef: 'F1', category: 'CTA_CLARITY', observation: 'o', recommendation: 'r' }],
  demoLinkAllowed: false,
  approvedDemoFindingRefs: [],
  competitorPackage: null,
};
const writerDraft = firstEmail() as EmailWriterParsed;
const seqFor = (step: SequenceStep): SequenceContext => ({
  step,
  threadSubject: step === 0 ? null : initial.subject,
  priorMessages: step === 0 ? [] : [{ sequenceStep: 0, subject: initial.subject, body: initial.body }],
});

describe('1-2. Follow-up #2: the production failure is refused, a real clarification is not', () => {
  it('the exact production restatement fails deterministic validation, before any reviewer call', () => {
    const result = validateEmail(draftFor(1, followups.productionRestatement.body), ctxFor(1, [initial.body]));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('followup_repeats_prior_message');
  });

  it('a genuine clarification survives the full deterministic gate', () => {
    const result = validateEmail(draftFor(1, followups.genuineClarification.body), ctxFor(1, [initial.body]));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('...and is approvable when the reviewer says it adds clarity', () => {
    expect(isEmailReviewApprovable(review(), { sequenceStep: 1, subjectIsThreadContinuity: true })).toBe(true);
    expect(isEmailReviewApprovable(review({ addsClarityNotRestart: false }), { sequenceStep: 1, subjectIsThreadContinuity: true })).toBe(false);
  });
});

describe('3-4. Follow-up #3: a compression passes the REAL validator and needs no new argument', () => {
  const compression = followups.validCompression.body;

  it('passes paragraph structure — one short paragraph is the job, not a defect', () => {
    const result = validateEmail(draftFor(2, compression), ctxFor(2, [initial.body]));
    expect(result.violations.filter((v) => v.startsWith('unnatural_paragraph_count'))).toEqual([]);
    expect(result.ok).toBe(true);
    // The same single-paragraph body WOULD be refused as a first email, where 2-4 is required.
    const asFirstEmail = validateEmail(draftFor(0, compression), ctxFor(0, []));
    expect(asFirstEmail.violations).toContain('unnatural_paragraph_count:1');
  });

  it('is not required to carry a fresh observation, outcome or persuasion', () => {
    const matrix = reviewApplicabilityMatrix(2);
    expect(matrix.businessRelevanceClear).toBe(false);
    expect(matrix.persuasive).toBe(false);
    expect(isEmailReviewApprovable(
      review({ businessRelevanceClear: false, persuasive: false, sufficientlyPersonalized: false }),
      { sequenceStep: 2, subjectIsThreadContinuity: true },
    )).toBe(true);
  });

  it('but a compression that re-explains the whole argument is still refused', () => {
    const result = validateEmail(draftFor(2, followups.step2Reexplanation.body), ctxFor(2, [initial.body]));
    expect(result.violations).toContain('followup_repeats_prior_message');
  });
});

describe('5-8. Follow-up #4: a binary close with no observation, outcome or persuasion', () => {
  const close = followups.validBinaryClose.body;

  it('passes the full deterministic gate', () => {
    const result = validateEmail(draftFor(3, close), ctxFor(3, [initial.body]));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is approvable with the first-email dimensions reported FALSE', () => {
    // A correct final close carries none of these by instruction. Their absence is the job being
    // done, and the gate must not read it as a defect.
    const matrix = reviewApplicabilityMatrix(3);
    for (const dimension of ['openingSpecific', 'businessRelevanceClear', 'persuasive', 'sufficientlyPersonalized', 'singleObservation', 'confidentObservation']) {
      expect(matrix[dimension], dimension).toBe(false);
    }
    // "I will leave this with you" is a correct final opening: there is no material left to be
    // specific about, and the thread carries the context.
    const verdict = review({
      openingSpecific: false, businessRelevanceClear: false, persuasive: false,
      sufficientlyPersonalized: false, singleObservation: false, confidentObservation: false,
    });
    expect(isEmailReviewApprovable(verdict, { sequenceStep: 3, subjectIsThreadContinuity: true })).toBe(true);
  });

  it('still fails closed on every UNIVERSAL dimension', () => {
    for (const broken of [
      { fabricationRisk: true }, { evidenceSupported: false }, { humanStylePass: false },
      { punctuationPass: false }, { singlePrimaryCta: false }, { buyerLanguageOnly: false },
      { urgencySupported: false }, { competitorClaimsSupported: false }, { demoAligned: false },
      { conversationNotAudit: false },
      { decision: 'REJECT' as const },
      // ...and on its own sequence job.
      { binaryReplyClose: false }, { pressureReduced: false },
    ]) {
      expect(isEmailReviewApprovable(review(broken), { sequenceStep: 3, subjectIsThreadContinuity: true }), JSON.stringify(broken)).toBe(false);
    }
  });

  it('renders exactly ONE binary yes/no CTA, written by the system', () => {
    const rendered = renderEmail(draftFor(3, close), inputs, { step: 3, threadSubject: initial.subject, priorMessageBodies: [initial.body] });
    const cta = ctaSentenceFor('en', 'REPLY_FOR_DETAILS', 3);

    expect(rendered.body).toContain(cta);
    expect(cta).toMatch(/reply yes/i);
    expect(cta).toMatch(/no is a complete answer/i);
    // Exactly one ask: the earlier reply sentence is NOT also present, and the body did not add one.
    expect(rendered.body).not.toContain('reply and I will share the details');
    expect(rendered.body.split(cta)).toHaveLength(2);
    expect(rendered.ctaKind).toBe('reply');
    expect(rendered.hasDemoUrlPlaceholder).toBe(false);
  });

  it('steps 0-2 keep their existing deterministic CTA', () => {
    for (const step of [0, 1, 2] as const) {
      expect(ctaSentenceFor('en', 'REPLY_FOR_DETAILS', step)).toBe('If this is relevant, reply and I will share the details.');
    }
    // German follows the same rule, in German.
    expect(ctaSentenceFor('de', 'REPLY_FOR_DETAILS', 3)).not.toBe(ctaSentenceFor('de', 'REPLY_FOR_DETAILS', 0));
  });

  it('7. a final email asking for the demo instead of a decision fails closed', () => {
    const result = validateEmail(draftFor(3, close, { primary_cta: 'VIEW_CONCEPT' }), ctxFor(3, [initial.body]));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('final_step_requires_binary_reply_cta:VIEW_CONCEPT');
    // ...while the same CTA is perfectly legal earlier in the sequence.
    expect(validateEmail(draftFor(1, followups.genuineClarification.body, { primary_cta: 'VIEW_CONCEPT' }), ctxFor(1, [initial.body]))
      .violations.some((v) => v.startsWith('final_step_requires_binary_reply_cta'))).toBe(false);
  });

  it('8. a final email that reopens and re-explains the pitch is refused', () => {
    const result = validateEmail(draftFor(3, followups.step3Reexplanation.body), ctxFor(3, [initial.body]));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('followup_repeats_prior_message');
  });
});

describe('genericity is judged against the position, not against a standalone email', () => {
  // `genericity_score` measures how reusable the copy would look ON ITS OWN. A compression and a
  // close are short and lean on the thread, so a TRUTHFUL model reports a higher number for doing
  // its job correctly. The answer is not to tell it to report a lower one — it must stay honest —
  // but to stop reading a standalone measure as if the message were standalone.
  const generic = (step: SequenceStep, score: number) => validateEmail(
    draftFor(step, step === 0 ? firstEmail().email_body : followups[step === 1 ? 'genuineClarification' : step === 2 ? 'validCompression' : 'validBinaryClose'].body,
      { genericity_score: score }),
    ctxFor(step, step === 0 ? [] : [initial.body]),
  ).violations.filter((v) => v.startsWith('genericity_score_too_high'));

  it('step 0 still fails a generic first email', () => {
    expect(generic(0, 41)).toEqual(['genericity_score_too_high:41']);
    expect(generic(0, 40)).toEqual([]);
  });

  it('step 1 keeps the same specificity bar: a clarity layer is about ONE specific issue', () => {
    expect(generic(1, 41)).toEqual(['genericity_score_too_high:41']);
    expect(generic(1, 40)).toEqual([]);
  });

  it.each([2, 3] as const)('step %i does not use the standalone score as a rejection criterion at all', (step) => {
    // A close like "I will leave this with you. Either way, I will not keep nudging." honestly
    // scores at the top of the scale standalone and is still exactly the right message, because the
    // THREAD carries the specificity. Any ceiling here would reject copy for having the property its
    // position is supposed to have — and there is no lesson rule that imposes one.
    for (const score of [41, 75, 100]) {
      expect(generic(step, score), `score ${String(score)}`).toEqual([]);
    }
  });

  it('what actually protects steps 2 and 3 is unchanged', () => {
    // Dropping one metric does not open a hole: the gates that describe BAD copy at those positions
    // still fire on the same fixtures.
    const replay2 = validateEmail(draftFor(2, followups.step2Reexplanation.body, { genericity_score: 100 }), ctxFor(2, [initial.body]));
    expect(replay2.violations).toContain('followup_repeats_prior_message');

    const replay3 = validateEmail(draftFor(3, followups.step3Reexplanation.body, { genericity_score: 100 }), ctxFor(3, [initial.body]));
    expect(replay3.violations).toContain('followup_repeats_prior_message');

    // ...as do the forbidden-phrase and CTA rules, at any score.
    const spam = validateEmail(
      draftFor(3, 'I hope this email finds you well. Just wanted to reach out one more time.', { genericity_score: 100 }),
      ctxFor(3, [initial.body]),
    );
    expect(spam.ok).toBe(false);
    expect(spam.violations.some((v) => v.startsWith('forbidden_phrase') || v.startsWith('generic_opening'))).toBe(true);
  });
});

describe('openingSpecific applies where the job calls for a specific opening', () => {
  it('is required for the first email and the clarity layer', () => {
    for (const step of [0, 1] as const) {
      expect(reviewApplicabilityMatrix(step).openingSpecific, `step ${String(step)}`).toBe(true);
      expect(isEmailReviewApprovable(review({ openingSpecific: false }), { sequenceStep: step, subjectIsThreadContinuity: step > 0 })).toBe(false);
    }
  });

  it('is NOT required for a compression or a close', () => {
    for (const step of [2, 3] as const) {
      expect(reviewApplicabilityMatrix(step).openingSpecific, `step ${String(step)}`).toBe(false);
      expect(isEmailReviewApprovable(review({ openingSpecific: false }), { sequenceStep: step, subjectIsThreadContinuity: true })).toBe(true);
    }
  });
});

describe('the paragraph rule the model is GIVEN matches the one it is JUDGED by', () => {
  // The copy standard used to say "2-4 short natural paragraphs" at every step while validation had
  // become sequence-aware: a model could follow its instructions at step 2 or 3 and be rejected by
  // our own validator. Both now read the same constant.
  const paragraphs = (n: number): string =>
    Array.from({ length: n }, (_, i) => `Short paragraph number ${String(i + 1)} about the mobile view.`).join('\n\n');

  const paragraphViolations = (step: SequenceStep, n: number): string[] =>
    validateEmail(draftFor(step, paragraphs(n)), ctxFor(step, step === 0 ? [] : [initial.body]))
      .violations.filter((v) => v.startsWith('unnatural_paragraph_count'));

  it.each([0, 1, 2, 3] as const)('step %i: the prompt states the range the validator enforces', (step) => {
    const { min, max } = PARAGRAPH_SHAPE[step];
    const writer = buildEmailWriterMessages(brief, null, seqFor(step)).system;
    const reviewer = buildEmailReviewerMessages(brief, writerDraft, seqFor(step)).system;

    // The sentence is generated from the same constant, so this cannot drift.
    expect(writer).toContain(`email_body contains ${paragraphRangeText(step)}.`);
    expect(reviewer).toContain(`email_body contains ${paragraphRangeText(step)}.`);
    expect(paragraphRangeText(step)).toContain(String(min));
    expect(paragraphRangeText(step)).toContain(String(max));

    // ...and the global standard no longer contradicts it.
    expect(writer).not.toContain('email_body contains 2-4 short natural paragraphs');
  });

  it.each([0, 1, 2, 3] as const)('step %i: every count the prompt permits is accepted by the validator', (step) => {
    const { min, max } = PARAGRAPH_SHAPE[step];
    for (let n = min; n <= max; n += 1) {
      expect(paragraphViolations(step, n), `step ${String(step)} with ${String(n)} paragraphs`).toEqual([]);
    }
  });

  it.each([0, 1, 2, 3] as const)('step %i: counts outside the stated range are still refused', (step) => {
    const { min, max } = PARAGRAPH_SHAPE[step];
    if (min > 1) expect(paragraphViolations(step, min - 1)).toEqual([`unnatural_paragraph_count:${String(min - 1)}`]);
    expect(paragraphViolations(step, max + 1)).toEqual([`unnatural_paragraph_count:${String(max + 1)}`]);
  });

  it('the ranges shrink along the sequence, as the lesson jobs require', () => {
    expect(PARAGRAPH_SHAPE[0]).toEqual({ min: 2, max: 4 });
    expect(PARAGRAPH_SHAPE[1]).toEqual({ min: 1, max: 3 });
    expect(PARAGRAPH_SHAPE[2]).toEqual({ min: 1, max: 2 });
    expect(PARAGRAPH_SHAPE[3]).toEqual({ min: 1, max: 2 });
  });
});

describe('9. the first email is unchanged by any of this', () => {
  it('still requires 2-4 paragraphs, its own subject, and the full quality bar', () => {
    const result = validateEmail(firstEmail(), ctxFor(0, []));
    expect(result.ok).toBe(true);

    // One paragraph is still wrong for a cold email.
    expect(validateEmail(draftFor(0, 'A single line that says something.'), ctxFor(0, []))
      .violations).toContain('unnatural_paragraph_count:1');

    // Every quality dimension still applies at step 0.
    const matrix = reviewApplicabilityMatrix(0);
    for (const dimension of Object.keys(matrix)) expect(matrix[dimension], dimension).toBe(true);
    for (const broken of [{ persuasive: false }, { businessRelevanceClear: false }, { singleObservation: false }]) {
      expect(isEmailReviewApprovable(review(broken), { sequenceStep: 0 })).toBe(false);
    }
  });

  it('still renders the original CTA and its own authored subject', () => {
    const rendered = renderEmail(firstEmail(), { facts: [], findings: [], demo: null }, INITIAL_EMAIL_SEQUENCE);
    expect(rendered.body).toContain('If this is relevant, reply and I will share the details.');
    expect(rendered.subject).toBe(firstEmail().selected_subject);
  });
});

describe('10. the deterministic sequence checks cost nothing', () => {
  it('validation, the gate and the renderer are pure functions', async () => {
    // Structural proof: this file imports no provider, and none of these modules can reach one.
    // If any of them ever acquired a model dependency, this import list would have to change.
    const modules = await Promise.all([
      import('../../src/domain/email/email-validation.js'),
      import('../../src/domain/email/email-review-gate.js'),
      import('../../src/domain/email/followup-repetition.js'),
      import('../../src/domain/email/email-render.js'),
    ]);
    for (const mod of modules) {
      expect(Object.keys(mod).some((k) => /provider|llm|openai/i.test(k))).toBe(false);
    }
    // ...and repeated evaluation is identical, because nothing external is consulted.
    const once = validateEmail(draftFor(3, followups.validBinaryClose.body), ctxFor(3, [initial.body]));
    const twice = validateEmail(draftFor(3, followups.validBinaryClose.body), ctxFor(3, [initial.body]));
    expect(twice).toEqual(once);
  });
});
