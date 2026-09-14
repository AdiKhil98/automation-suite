import { describe, expect, it } from 'vitest';
import {
  buildEmailReviewerMessages,
  buildEmailWriterMessages,
  type EmailBrief,
  type SequenceContext,
} from '../../src/prompts/email/index.js';
import { type EmailWriterParsed } from '../../src/domain/email/email-schema.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';

/**
 * WHAT THE MODEL IS ACTUALLY TOLD about the subject, per sequence step.
 *
 * The copy standard used to state "Produce exactly three distinct, specific subject options"
 * GLOBALLY, for both the writer and the reviewer, while the step blocks told steps 1-3 to put the
 * SAME thread subject in all three options. Both models received a self-contradicting instruction,
 * and the reviewer could reject a correctly-threaded follow-up for having no curiosity gap.
 *
 * These tests inspect the generated prompts rather than the code that assembles them.
 */

const THREAD_SUBJECT = 'Something I noticed on Complete Dentistry’s mobile site';

const brief: EmailBrief = {
  businessName: 'Complete Dentistry',
  contactName: null,
  language: 'en',
  facts: [{ evidenceId: 'fact-1', type: 'business_name', value: 'Complete Dentistry' }],
  findings: [{
    evidenceId: 'finding-1', findingRef: 'F1', category: 'CTA_CLARITY',
    observation: 'The appointment action is hard to find.',
    recommendation: 'Surface the appointment action on the homepage.',
  }],
  demoLinkAllowed: false,
  approvedDemoFindingRefs: [],
  competitorPackage: null,
};

const draft = (): EmailWriterParsed =>
  EMAIL_COPY_FIXTURES.find((f) => f.name === 'strong English business email')!.writer as EmailWriterParsed;

const initial: SequenceContext = { step: 0, threadSubject: null, priorMessages: [] };
const followup = (step: 1 | 2 | 3): SequenceContext => ({
  step,
  threadSubject: THREAD_SUBJECT,
  priorMessages: [{ sequenceStep: 0, subject: THREAD_SUBJECT, body: 'The main contact action is hard to find.' }],
});

const writerPrompt = (seq: SequenceContext): string => {
  const m = buildEmailWriterMessages(brief, null, seq);
  return `${m.system}\n${m.user}`;
};
const reviewerPrompt = (seq: SequenceContext): string => {
  const m = buildEmailReviewerMessages(brief, draft(), seq);
  return `${m.system}\n${m.user}`;
};

/** The instruction that contradicted the follow-up contract. */
const THREE_DISTINCT = /three distinct, specific subject options/i;
const CURIOSITY_RULES = /SUBJECT = CURIOSITY GAP/;
const THREAD_CONTINUITY = /continues the EXISTING thread/i;

describe('writer prompt — subject instructions are per step', () => {
  it('step 0 gets the distinct-subject and curiosity-gap rules', () => {
    const p = writerPrompt(initial);
    expect(p).toMatch(THREE_DISTINCT);
    expect(p).toMatch(CURIOSITY_RULES);
    expect(p).not.toMatch(THREAD_CONTINUITY);
  });

  it.each([1, 2, 3] as const)('step %i gets the thread-continuity contract and the exact subject to echo', (step) => {
    const p = writerPrompt(followup(step));
    expect(p).toMatch(THREAD_CONTINUITY);
    expect(p).toContain('THREAD SUBJECT (use verbatim)');
    expect(p).toContain(THREAD_SUBJECT);
  });

  it.each([1, 2, 3] as const)('step %i is NEVER told to produce three distinct subjects', (step) => {
    const p = writerPrompt(followup(step));
    expect(p).not.toMatch(THREE_DISTINCT);
    expect(p).not.toMatch(CURIOSITY_RULES);
  });

  it('asks a follow-up with no resolvable thread for neither rule', () => {
    // There is no thread to continue and inventing a subject would start a second conversation, so
    // nothing is asked of the model and `validateEmail` fails the composition closed.
    const p = writerPrompt({ step: 1, threadSubject: null, priorMessages: [] });
    expect(p).not.toMatch(THREE_DISTINCT);
    expect(p).not.toMatch(THREAD_CONTINUITY);
  });
});

describe('reviewer prompt — a threaded follow-up subject is not judged', () => {
  it('step 0 keeps the full curiosity-gap rubric', () => {
    const p = reviewerPrompt(initial);
    expect(p).toMatch(THREE_DISTINCT);
    expect(p).toMatch(CURIOSITY_RULES);
    expect(p).toContain('Set subjectCuriosityGap to false when');
  });

  it.each([1, 2, 3] as const)('step %i is told the repeated subject is correct and must not be rejected', (step) => {
    const p = reviewerPrompt(followup(step));
    expect(p).toContain('do not judge it');
    expect(p).toMatch(/SUPPOSED to be identical to the thread subject/);
    expect(p).toMatch(/Report subjectSpecific and subjectCuriosityGap as true/);
  });

  it.each([1, 2, 3] as const)('step %i never receives the distinct-subject or curiosity rubric', (step) => {
    const p = reviewerPrompt(followup(step));
    expect(p).not.toMatch(THREE_DISTINCT);
    expect(p).not.toMatch(CURIOSITY_RULES);
    expect(p).not.toContain('Set subjectCuriosityGap to false when');
  });

  it('falls back to the authored-subject rubric for a follow-up with no thread subject', () => {
    const p = reviewerPrompt({ step: 1, threadSubject: null, priorMessages: [] });
    expect(p).toMatch(CURIOSITY_RULES);
  });
});

describe('unrelated email quality rules are still in every prompt', () => {
  const alwaysPresent = [
    'COLD EMAIL COPY STANDARD',
    'SINGLE-OBSERVATION, BUYER-LANGUAGE STANDARD',
    'OUTCOMES GET PAID, TOOLS DO NOT',
    'FORBIDDEN PHRASES INCLUDE',
  ];

  it.each([0, 1, 2, 3] as const)('writer step %i', (step) => {
    const p = writerPrompt(step === 0 ? initial : followup(step));
    for (const rule of alwaysPresent) expect(p).toContain(rule);
  });

  it.each([0, 1, 2, 3] as const)('reviewer step %i', (step) => {
    const p = reviewerPrompt(step === 0 ? initial : followup(step));
    for (const rule of alwaysPresent) expect(p).toContain(rule);
    // The body-quality booleans stay fail-closed at every step.
    for (const dimension of ['singleObservation', 'buyerLanguageOnly', 'conversationNotAudit', 'confidentObservation']) {
      expect(p).toContain(dimension);
    }
  });
});
