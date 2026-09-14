import { describe, expect, it } from 'vitest';
import { type EmailValidationContext, validateEmail } from '../../src/domain/email/email-validation.js';
import {
  INITIAL_EMAIL_SEQUENCE,
  type EmailSequencePosition,
  type EmailWriterOutput,
} from '../../src/domain/email/email-types.js';
import { renderEmail, type EmailInputs } from '../../src/domain/email/email-render.js';
import { type SequenceStep } from '../../src/domain/outreach/sequence.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';

/**
 * SUBJECT RULES ARE STEP-DEPENDENT, because the subject has a different author per step.
 *
 * A first email authors three distinct subject options. A follow-up authors none: it continues an
 * existing Gmail thread, so `src/prompts/email/sequence-jobs.ts` instructs the writer to echo the
 * supplied thread subject into all three options and into `selected_subject`, and `renderEmail`
 * builds the outgoing subject deterministically from that thread subject.
 *
 * Production regression: the deterministic validator applied the FIRST-EMAIL rules to every step, so
 * a follow-up that obeyed its prompt exactly was rejected with `subject_options_not_unique` before
 * the reviewer was ever called. These tests pin both halves — the first-email rules are untouched,
 * and the follow-up contract is VALIDATED rather than merely skipped.
 */

const base = (): EmailWriterOutput =>
  EMAIL_COPY_FIXTURES.find((fixture) => fixture.name === 'strong English business email')!.writer;

const ctx = (sequence: EmailSequencePosition): EmailValidationContext => ({
  sequence,
  availableEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services', 'finding-cta', 'finding-other']),
  factEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services']),
  acceptedFindingIds: new Set(['finding-cta', 'finding-other']),
  approvedDemoFindingIds: new Set(),
  demoLinkAllowed: false,
  language: 'en',
});

const followup = (step: SequenceStep, threadSubject: string | null): EmailValidationContext =>
  ctx({ step, threadSubject });

/** The writer output shape a correctly-behaved follow-up produces: the thread subject, three times. */
const echoing = (threadSubject: string, over: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
  ...base(),
  subject_options: [threadSubject, threadSubject, threadSubject],
  selected_subject: threadSubject,
  selected_subject_reason: 'Thread continuity is preserved.',
  ...over,
});

/** Only the subject-related violations, so unrelated copy rules cannot mask or fake a result. */
const subjectViolations = (out: EmailWriterOutput, c: EmailValidationContext): string[] =>
  validateEmail(out, c).violations.filter((v) =>
    v.startsWith('subject') || v.startsWith('selected_subject') || v.startsWith('generic_subject') || v.startsWith('followup_'));

/** The exact production shape: Complete Dentistry, internal step 1 (lesson Follow-up #2). */
const PROD_THREAD_SUBJECT = 'Something I noticed on Complete Dentistry’s mobile site';

describe('step 0 — the first email still authors its own subject (unchanged)', () => {
  it('still rejects duplicate subject options', () => {
    const out = echoing('A perfectly fine first subject');
    expect(subjectViolations(out, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('subject_options_not_unique');
  });

  it('still rejects two-of-three duplicates, case-insensitively', () => {
    const out = { ...base(), subject_options: ['Alpha subject', 'ALPHA SUBJECT', 'Beta subject'], selected_subject: 'Beta subject' };
    expect(subjectViolations(out, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('subject_options_not_unique');
  });

  it('still rejects a selected subject that is not one of the options', () => {
    const out = { ...base(), selected_subject: 'Something never offered' };
    expect(subjectViolations(out, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('selected_subject_not_in_options');
  });

  it('still rejects generic and finding-revealing subjects', () => {
    const generic = { ...base(), subject_options: ['Quick question', 'Beta subject', 'Gamma subject'], selected_subject: 'Beta subject' };
    expect(subjectViolations(generic, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('generic_subject:1');

    const revealing = { ...base(), subject_options: ['Improve your online booking', 'Beta subject', 'Gamma subject'], selected_subject: 'Beta subject' };
    expect(subjectViolations(revealing, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('subject_reveals_finding:1');
  });

  it('accepts the unchanged first-email fixture', () => {
    expect(subjectViolations(base(), ctx(INITIAL_EMAIL_SEQUENCE))).toEqual([]);
    expect(validateEmail(base(), ctx(INITIAL_EMAIL_SEQUENCE)).ok).toBe(true);
  });
});

describe('steps 1-3 — a follow-up echoes the thread subject', () => {
  it('accepts the EXACT production draft that was rejected before this fix', () => {
    const out = echoing(PROD_THREAD_SUBJECT);
    const result = validateEmail(out, followup(1, PROD_THREAD_SUBJECT));
    expect(result.violations).not.toContain('subject_options_not_unique');
    expect(subjectViolations(out, followup(1, PROD_THREAD_SUBJECT))).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([1, 2, 3] as const)('accepts the repeated thread subject at step %i', (step) => {
    const out = echoing(PROD_THREAD_SUBJECT);
    expect(subjectViolations(out, followup(step, PROD_THREAD_SUBJECT))).toEqual([]);
    expect(validateEmail(out, followup(step, PROD_THREAD_SUBJECT)).ok).toBe(true);
  });

  it('accepts an echo that already carries the reply prefix the renderer would add', () => {
    // `replySubject` is idempotent and is the single rule for what a threaded subject looks like,
    // so "Re: X" and "X" are the same subject — but any change to the TEXT is not.
    const out = echoing(`Re: ${PROD_THREAD_SUBJECT}`);
    expect(subjectViolations(out, followup(1, PROD_THREAD_SUBJECT))).toEqual([]);
  });

  it('does NOT re-judge a thread subject for genericity or revealed findings', () => {
    // That subject is already in the recipient's inbox; it passed these checks as a first email.
    // Re-judging it could only reject copy that was already sent.
    const sent = 'Improve your online booking';
    expect(subjectViolations(echoing(sent), followup(1, sent))).toEqual([]);
    // ...while the same string is still refused where the model actually authors a subject.
    const authored = { ...base(), subject_options: [sent, 'Beta subject', 'Gamma subject'], selected_subject: 'Beta subject' };
    expect(subjectViolations(authored, ctx(INITIAL_EMAIL_SEQUENCE))).toContain('subject_reveals_finding:1');
  });
});

describe('steps 1-3 — the follow-up contract fails closed', () => {
  it('rejects a follow-up that invents a fresh hook', () => {
    const out = echoing(PROD_THREAD_SUBJECT, {
      subject_options: ['A new angle on your booking flow', 'A new angle on your booking flow', 'A new angle on your booking flow'],
      selected_subject: 'A new angle on your booking flow',
    });
    const v = subjectViolations(out, followup(1, PROD_THREAD_SUBJECT));
    expect(v).toContain('followup_subject_not_thread_subject:1');
    expect(v).toContain('followup_selected_subject_not_thread_subject');
    expect(validateEmail(out, followup(1, PROD_THREAD_SUBJECT)).ok).toBe(false);
  });

  it('rejects a single mutated option, naming which one', () => {
    const out = echoing(PROD_THREAD_SUBJECT, {
      subject_options: [PROD_THREAD_SUBJECT, `${PROD_THREAD_SUBJECT} — following up`, PROD_THREAD_SUBJECT],
    });
    const v = subjectViolations(out, followup(1, PROD_THREAD_SUBJECT));
    expect(v).toEqual(['followup_subject_not_thread_subject:2']);
  });

  it('rejects a change of case, which is still a mutated subject', () => {
    const out = echoing(PROD_THREAD_SUBJECT.toUpperCase());
    expect(subjectViolations(out, followup(1, PROD_THREAD_SUBJECT)).length).toBeGreaterThan(0);
  });

  it('rejects a selected_subject that differs from the thread subject', () => {
    const out = echoing(PROD_THREAD_SUBJECT, { selected_subject: 'Checking in on my last email' });
    expect(subjectViolations(out, followup(1, PROD_THREAD_SUBJECT)))
      .toEqual(['followup_selected_subject_not_thread_subject']);
  });

  it.each([1, 2, 3] as const)('fails closed at step %i when no thread subject was supplied', (step) => {
    // A follow-up with no thread to continue is not a recoverable state: the model's invented
    // subject would silently start a SECOND thread beside the conversation the recipient has.
    const out = echoing(PROD_THREAD_SUBJECT);
    expect(subjectViolations(out, followup(step, null))).toEqual(['followup_thread_subject_missing']);
    expect(validateEmail(out, followup(step, null)).ok).toBe(false);
  });

  it('fails closed on a blank thread subject too', () => {
    const out = echoing(PROD_THREAD_SUBJECT);
    expect(subjectViolations(out, followup(1, '   '))).toEqual(['followup_thread_subject_missing']);
  });
});

describe('render and validation agree on one subject', () => {
  const inputs = (threadSubject: string | null): EmailInputs => ({
    facts: [], findings: [], demo: null, threadSubject,
  });

  it('renders the thread subject as a reply, not the model’s selection', () => {
    const out = echoing(PROD_THREAD_SUBJECT);
    expect(renderEmail(out, inputs(PROD_THREAD_SUBJECT)).subject).toBe(`Re: ${PROD_THREAD_SUBJECT}`);
  });

  it('never double-prefixes a stored subject that is already a reply (the resume path)', () => {
    const stored = `Re: ${PROD_THREAD_SUBJECT}`;
    const out = echoing(PROD_THREAD_SUBJECT);
    // Resume re-renders from the STORED subject; it must reproduce it byte-identically, and the
    // same draft must still validate against it.
    expect(renderEmail(out, inputs(stored)).subject).toBe(stored);
    expect(subjectViolations(out, followup(1, stored))).toEqual([]);
  });

  it('a first email still renders the model’s selected subject', () => {
    expect(renderEmail(base(), inputs(null)).subject).toBe(base().selected_subject);
  });
});
