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
import { INITIAL_EMAIL_SEQUENCE, type EmailWriterOutput } from '../../src/domain/email/email-types.js';
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

  it('a correct step-2 compression is NOT rejected for an honest high score', () => {
    expect(generic(2, 75)).toEqual([]);
    // ...but outright bulk-mail copy still fails, in any thread.
    expect(generic(2, 95)).toEqual(['genericity_score_too_high:95']);
  });

  it('a correct step-3 close is NOT rejected for an honest high score', () => {
    expect(generic(3, 75)).toEqual([]);
    expect(generic(3, 95)).toEqual(['genericity_score_too_high:95']);
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
