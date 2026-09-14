import { describe, expect, it } from 'vitest';
import {
  analyzeFollowupRepetition,
  contentTokens,
  REPETITION_LIMITS,
} from '../../src/domain/email/followup-repetition.js';
import { type EmailValidationContext, validateEmail } from '../../src/domain/email/email-validation.js';
import { INITIAL_EMAIL_SEQUENCE, type EmailWriterOutput } from '../../src/domain/email/email-types.js';
import { isEmailReviewApprovable } from '../../src/domain/email/email-review-gate.js';
import { type EmailReviewParsed } from '../../src/domain/email/email-schema.js';
import { EMAIL_COPY_FIXTURES } from '../fixtures/email-copy-standard.js';
import { FOLLOWUP_REPETITION_FIXTURES } from '../fixtures/followup-clarity.js';

/**
 * FOLLOW-UP #2 MUST ADD SOMETHING.
 *
 * The production failure: Outreach #1 reported that the mobile cookie banner covers the introductory
 * copy and that patients can only see Accept and Read More. Follow-up #2 said the same thing in
 * different words — the reviewer approved it (fabricationRisk false, addsClarityNotRestart true),
 * and only human review caught that the prospect learned nothing. The exact pair is fixture data
 * here, so it can never pass again.
 *
 * Two layers answer it, and these tests keep them honest about which does what:
 *   - the DETERMINISTIC gate (this file's first half) refuses replayed wording and messages that add
 *     no new content. It is conservative by construction and cannot detect a true synonym rewrite.
 *   - the REVIEWER (`addsClarityNotRestart`, enforced by `isEmailReviewApprovable`) is the layer that
 *     reads for meaning. A step-1 email it marks false can never be approved.
 */

const { initial, followups } = FOLLOWUP_REPETITION_FIXTURES;

const analyze = (body: string, priorBodies: readonly string[] = [initial.body]) =>
  analyzeFollowupRepetition({ candidateBody: body, priorBodies, threadSubject: initial.subject });

describe('deterministic anti-repetition gate — the production pair', () => {
  it('REJECTS the exact follow-up #2 that shipped', () => {
    const analysis = analyze(followups.productionRestatement.body);
    expect(analysis.repeats).toBe(true);
    expect(analysis.reason).toBe('VERBATIM_CLAUSE_REPLAY');
    // It replayed a whole clause: "patients ... see Accept and Read More".
    expect(analysis.longestSharedRun).toBeGreaterThanOrEqual(REPETITION_LIMITS.maxSharedContentRun);
  });

  it('ACCEPTS the kind of clarification that was actually wanted', () => {
    const analysis = analyze(followups.genuineClarification.body);
    expect(analysis.repeats).toBe(false);
    expect(analysis.reason).toBeNull();
  });

  it('ACCEPTS a follow-up that repeats the necessary nouns but adds a new layer', () => {
    // "banner", "mobile", "patient", "practice" are the shared subject of the conversation. A gate
    // that punished them would forbid continuity itself.
    const analysis = analyze(followups.newLayerSameNouns.body);
    expect(analysis.repeats).toBe(false);
    expect(contentTokens(followups.newLayerSameNouns.body, initial.subject)).toContain('banner');
  });

  it('REJECTS a short nudge that adds nothing, even though it reuses almost no wording', () => {
    const analysis = analyze(followups.shortNudge.body);
    expect(analysis.repeats).toBe(true);
    expect(analysis.reason).toBe('NO_NEW_CONTENT');
    expect(analysis.novelContentTokens).toBeLessThan(REPETITION_LIMITS.minNovelContentTokens);
  });

  it('separates the failing and passing cases by a wide margin, not a hair', () => {
    // The thresholds were set from these measurements, and this records them so a future tweak has
    // to confront the evidence.
    const bad = analyze(followups.productionRestatement.body);
    const good = analyze(followups.genuineClarification.body);
    const newLayer = analyze(followups.newLayerSameNouns.body);
    expect(bad.longestSharedRun).toBeGreaterThan(good.longestSharedRun + 1);
    expect(bad.sharedBigramRatio).toBeGreaterThan(good.sharedBigramRatio + 0.2);
    expect(newLayer.sharedBigramRatio).toBeLessThan(REPETITION_LIMITS.maxSharedBigramRatio);
  });

  it('ignores greetings, CTA boilerplate, signature and the thread subject', () => {
    const tokens = contentTokens(initial.body, initial.subject);
    for (const boilerplate of ['hello', 'regard', 'relevant', 'reply', 'detail', 'sender_name']) {
      expect(tokens).not.toContain(boilerplate);
    }
    // ...and the subject's own words are not counted as reuse.
    expect(tokens).not.toContain('noticed');
  });

  it('normalises case, punctuation, typography and trivial inflection', () => {
    const shouty = analyze(followups.productionRestatement.body.toLocaleUpperCase().replace(/,/g, ';'));
    expect(shouty.repeats).toBe(true);
    // "patients" and "patient" are the same word for this purpose.
    expect(contentTokens('patients', null)).toEqual(contentTokens('patient', null));
  });

  it('says nothing when there is nothing to repeat', () => {
    expect(analyze(followups.genuineClarification.body, []).repeats).toBe(false);
  });
});

describe('the gate inside validateEmail', () => {
  const writer = (body: string): EmailWriterOutput => ({
    ...EMAIL_COPY_FIXTURES.find((f) => f.name === 'strong English business email')!.writer,
    subject_options: [initial.subject, initial.subject, initial.subject],
    selected_subject: initial.subject,
    selected_subject_reason: 'Thread continuity is preserved.',
    email_body: body,
  });

  const ctx = (step: 0 | 1 | 2 | 3, priorMessageBodies: readonly string[]): EmailValidationContext => ({
    sequence: step === 0
      ? INITIAL_EMAIL_SEQUENCE
      : { step, threadSubject: initial.subject, priorMessageBodies },
    availableEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services', 'finding-cta', 'finding-other']),
    factEvidenceIds: new Set(['fact-business', 'fact-city', 'fact-services']),
    acceptedFindingIds: new Set(['finding-cta', 'finding-other']),
    approvedDemoFindingIds: new Set(),
    demoLinkAllowed: false,
    language: 'en',
  });

  it('emits followup_repeats_prior_message for the production restatement', () => {
    const result = validateEmail(writer(followups.productionRestatement.body), ctx(1, [initial.body]));
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('followup_repeats_prior_message');
    // ...with a diagnostic companion naming the rule and the measurement.
    expect(result.violations.some((v) => v.startsWith('followup_repetition:VERBATIM_CLAUSE_REPLAY:'))).toBe(true);
  });

  it('passes a genuine clarification', () => {
    const result = validateEmail(writer(followups.genuineClarification.body), ctx(1, [initial.body]));
    expect(result.violations).not.toContain('followup_repeats_prior_message');
  });

  it.each([2, 3] as const)('applies to step %i as well, against everything already sent', (step) => {
    const prior = [initial.body, followups.genuineClarification.body];
    // Replaying the SECOND email is as bad as replaying the first.
    const replay = validateEmail(writer(followups.genuineClarification.body), ctx(step, prior));
    expect(replay.violations).toContain('followup_repeats_prior_message');
    const fresh = validateEmail(writer(followups.newLayerSameNouns.body), ctx(step, prior));
    expect(fresh.violations).not.toContain('followup_repeats_prior_message');
  });

  it('never applies to a first email', () => {
    // Step 0 has no thread; the gate must not run and must not be reachable by accident.
    const result = validateEmail(writer(followups.productionRestatement.body), ctx(0, []));
    expect(result.violations).not.toContain('followup_repeats_prior_message');
  });

  it('leaves thread-subject continuity untouched', () => {
    const result = validateEmail(writer(followups.genuineClarification.body), ctx(1, [initial.body]));
    expect(result.violations.filter((v) => v.startsWith('followup_subject'))).toEqual([]);
    expect(result.violations).not.toContain('subject_options_not_unique');
  });

  it('costs nothing: the gate is a pure function, reached before any model call', () => {
    // Proven structurally — `analyzeFollowupRepetition` takes strings and returns a verdict. If it
    // ever acquired a provider dependency, this import-only test would need one too.
    const before = validateEmail(writer(followups.shortNudge.body), ctx(1, [initial.body]));
    const again = validateEmail(writer(followups.shortNudge.body), ctx(1, [initial.body]));
    expect(again.violations).toEqual(before.violations);
  });
});

describe('the reviewer is the layer that reads for meaning', () => {
  const review = (over: Partial<EmailReviewParsed> = {}): EmailReviewParsed => ({
    decision: 'APPROVE', fabricationRisk: false, subjectSpecific: true, subjectCuriosityGap: true,
    openingSpecific: true, businessRelevanceClear: true, urgencySupported: true,
    competitorClaimsSupported: true, humanStylePass: true, punctuationPass: true, singlePrimaryCta: true,
    sufficientlyPersonalized: true, evidenceSupported: true, demoAligned: true, persuasive: true,
    singleObservation: true, buyerLanguageOnly: true, conversationNotAudit: true, confidentObservation: true,
    addsClarityNotRestart: true, compressedNotExpanded: true, pressureReduced: true, binaryReplyClose: true,
    problems: [], requiredRevisions: [], ...over,
  });

  it('cannot approve step 1 when addsClarityNotRestart is false', () => {
    const verdict = review({ addsClarityNotRestart: false });
    expect(isEmailReviewApprovable(verdict, { sequenceStep: 1, subjectIsThreadContinuity: true })).toBe(false);
    // Even with every other dimension perfect and an APPROVE decision.
    expect(verdict.decision).toBe('APPROVE');
    expect(verdict.fabricationRisk).toBe(false);
  });

  it('is what must catch a synonym rewrite, which no lexical gate can see', () => {
    // A true paraphrase ("cookie banner" -> "consent notice") shares almost no wording, so the
    // deterministic gate passes it — measured, not assumed. This is the documented boundary between
    // the two layers, and the reviewer is where it is decided.
    const analysis = analyze(followups.synonymParaphrase.body);
    expect(analysis.repeats).toBe(false);
    // The rubric now names this exact failure, and the gate refuses it once the reviewer reports it.
    expect(isEmailReviewApprovable(review({ addsClarityNotRestart: false }), { sequenceStep: 1 })).toBe(false);
  });

  it('still approves a genuine step-1 clarification', () => {
    expect(isEmailReviewApprovable(review(), { sequenceStep: 1, subjectIsThreadContinuity: true })).toBe(true);
  });

  it('leaves steps 2 and 3 judged by their own jobs', () => {
    // Step 2 compresses; step 3 closes. Each still requires its own booleans.
    expect(isEmailReviewApprovable(review({ compressedNotExpanded: false }), { sequenceStep: 2 })).toBe(false);
    expect(isEmailReviewApprovable(review({ binaryReplyClose: false }), { sequenceStep: 3 })).toBe(false);
    expect(isEmailReviewApprovable(review({ binaryReplyClose: false }), { sequenceStep: 1 })).toBe(true);
    // A first email is unaffected by every sequence-job boolean.
    expect(isEmailReviewApprovable(review({ addsClarityNotRestart: false }), { sequenceStep: 0 })).toBe(true);
  });
});
