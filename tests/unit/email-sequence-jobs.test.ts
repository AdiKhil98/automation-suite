import { describe, expect, it } from 'vitest';
import {
  buildEmailReviewerMessages,
  buildEmailWriterMessages,
  type EmailBrief,
  type SequenceContext,
} from '../../src/prompts/email/index.js';
import { type EmailReviewParsed } from '../../src/domain/email/email-schema.js';
import { isEmailReviewApprovable, sequenceJobSatisfied } from '../../src/domain/email/email-review-gate.js';
import { type EmailWriterParsed } from '../../src/domain/email/email-schema.js';
import { replySubject } from '../../src/domain/email/email-render.js';
import { type SequenceStep } from '../../src/domain/outreach/sequence.js';

/**
 * Each email in the sequence has a DIFFERENT job, so the writer must receive that step's
 * instructions and the reviewer must be judged against that step's rubric. These are deterministic
 * prompt/gate assertions — no model is called.
 */

const brief: EmailBrief = {
  businessName: 'Clinic Example',
  contactName: null,
  language: 'en',
  facts: [{ evidenceId: 'f1', type: 'business_name', value: 'Clinic Example' }],
  findings: [{ evidenceId: 'x1', findingRef: 'R1', category: 'booking', observation: 'o', recommendation: 'r' }],
  demoLinkAllowed: false,
  approvedDemoFindingRefs: [],
  competitorPackage: null,
};

const draft: EmailWriterParsed = {
  subject_options: ['a', 'b', 'c'],
  selected_subject: 'a',
  selected_subject_reason: 'reason',
  email_body: 'body',
  evidence_ids: ['x1'],
  strategic_angle: 'angle',
  business_relevance: 'relevance',
  urgency_basis: 'basis',
  competitor_evidence_used: 'NONE',
  primary_cta: 'REPLY_FOR_DETAILS',
  prohibited_phrase_scan: 'PASS',
  punctuation_scan: 'PASS',
  genericity_score: 10,
  human_style_result: 'PASS',
  demo_alignment_result: 'NOT_APPLICABLE',
};

const seq = (step: SequenceStep, threadSubject: string | null = null): SequenceContext => ({
  step,
  threadSubject,
  priorMessages: step === 0 ? [] : [{ sequenceStep: 0, subject: 'Original subject', body: 'Original body' }],
});

describe('writer prompt — each step receives its own job', () => {
  it('gives the first email the attention/permission job and the outcomes principle', () => {
    const { system } = buildEmailWriterMessages(brief, null, seq(0));
    expect(system).toContain('Outreach #1');
    expect(system).toContain('earn attention and permission');
    expect(system).toContain("OUTCOMES GET PAID. TOOLS DON'T.");
    expect(system).toContain('Do NOT dump the entire solution');
    // A first email must not be told to behave like a follow-up.
    expect(system).not.toContain('ADD CLARITY');
    expect(system).not.toContain('YES / NO decision');
  });

  it('gives internal step 1 the ADD CLARITY job (lesson Follow-up #2)', () => {
    const { system } = buildEmailWriterMessages(brief, null, seq(1, 'Original subject'));
    expect(system).toContain('Follow-up #2');
    expect(system).toContain('ADD CLARITY');
    expect(system).toContain('Do NOT restart the pitch');
    expect(system).toContain('just following up');
    expect(system).not.toContain('COMPRESS THE ISSUE AND REDUCE PRESSURE');
  });

  it('gives internal step 2 the COMPRESS job (lesson Follow-up #3)', () => {
    const { system } = buildEmailWriterMessages(brief, null, seq(2, 'Original subject'));
    expect(system).toContain('Follow-up #3');
    expect(system).toContain('COMPRESS THE ISSUE AND REDUCE PRESSURE');
    expect(system).toContain('SHORTER than the previous email');
    expect(system).toContain('not going to keep nudging them endlessly');
  });

  it('gives internal step 3 the binary-close job and forbids asking for a call', () => {
    const { system } = buildEmailWriterMessages(brief, null, seq(3, 'Original subject'));
    expect(system).toContain('Follow-up #4');
    expect(system).toContain('FINAL email');
    expect(system).toContain('YES / NO decision');
    expect(system).toContain('Do NOT ask them to schedule a call');
    expect(system).toContain('remove that fear');
    expect(system).toContain('Make it easy and cost-free to say no');
  });

  it('supplies follow-ups with the already-sent thread as untrusted continuity data', () => {
    const { user } = buildEmailWriterMessages(brief, null, seq(1, 'Original subject'));
    expect(user).toContain('ALREADY SENT IN THIS THREAD');
    expect(user).toContain('Original body');
    expect(user).toContain('never quote as new fact');
    // The first email gets no thread context at all.
    expect(buildEmailWriterMessages(brief, null, seq(0)).user).not.toContain('ALREADY SENT IN THIS THREAD');
  });

  it('tells a threaded follow-up to reuse the thread subject verbatim', () => {
    const { system } = buildEmailWriterMessages(brief, null, seq(2, 'Original subject'));
    expect(system).toContain('THREAD SUBJECT (use verbatim): "Original subject"');
    expect(system).toContain('continues the EXISTING thread');
  });

  it('defaults to the first-email context when no sequence is supplied', () => {
    expect(buildEmailWriterMessages(brief, null).system).toContain('Outreach #1');
  });
});

describe('reviewer prompt — each step receives its own rubric', () => {
  it('tells the reviewer which sequence booleans apply', () => {
    expect(buildEmailReviewerMessages(brief, draft, seq(0)).system)
      .toContain('do NOT apply to a first email');
    expect(buildEmailReviewerMessages(brief, draft, seq(1)).system)
      .toContain('does it ADD CLARITY?');
    expect(buildEmailReviewerMessages(brief, draft, seq(2)).system)
      .toContain('COMPRESS AND REDUCE PRESSURE');
    expect(buildEmailReviewerMessages(brief, draft, seq(3)).system)
      .toContain('ONE clean YES / NO decision');
  });

  it('always asks for all four sequence-job booleans', () => {
    for (const step of [0, 1, 2, 3] as const) {
      const { system } = buildEmailReviewerMessages(brief, draft, seq(step));
      for (const key of ['addsClarityNotRestart', 'compressedNotExpanded', 'pressureReduced', 'binaryReplyClose']) {
        expect(system).toContain(key);
      }
    }
  });
});

/** A review that passes every generic quality dimension; sequence booleans are set per test. */
function review(over: Partial<EmailReviewParsed> = {}): EmailReviewParsed {
  return {
    decision: 'APPROVE',
    fabricationRisk: false,
    subjectSpecific: true,
    subjectCuriosityGap: true,
    openingSpecific: true,
    businessRelevanceClear: true,
    urgencySupported: true,
    competitorClaimsSupported: true,
    humanStylePass: true,
    punctuationPass: true,
    singlePrimaryCta: true,
    sufficientlyPersonalized: true,
    evidenceSupported: true,
    demoAligned: true,
    persuasive: true,
    singleObservation: true,
    buyerLanguageOnly: true,
    conversationNotAudit: true,
    confidentObservation: true,
    addsClarityNotRestart: true,
    compressedNotExpanded: true,
    pressureReduced: true,
    binaryReplyClose: true,
    problems: [],
    requiredRevisions: [],
    ...over,
  };
}

describe('review gate — the sequence job is fail-closed per step', () => {
  it('approves a clean draft at every step', () => {
    for (const step of [0, 1, 2, 3] as const) {
      expect(isEmailReviewApprovable(review(), { sequenceStep: step })).toBe(true);
    }
  });

  it('rejects a step-1 follow-up that restarts the pitch', () => {
    const r = review({ addsClarityNotRestart: false });
    expect(isEmailReviewApprovable(r, { sequenceStep: 1 })).toBe(false);
    // The same verdict does not block a FIRST email, where the dimension does not apply.
    expect(isEmailReviewApprovable(r, { sequenceStep: 0 })).toBe(true);
  });

  it('rejects a step-2 follow-up that expanded instead of compressing', () => {
    expect(isEmailReviewApprovable(review({ compressedNotExpanded: false }), { sequenceStep: 2 })).toBe(false);
  });

  it('rejects a step-2 follow-up that adds pressure', () => {
    expect(isEmailReviewApprovable(review({ pressureReduced: false }), { sequenceStep: 2 })).toBe(false);
  });

  it('rejects a final follow-up whose CTA is not a binary, low-friction close', () => {
    const r = review({ binaryReplyClose: false });
    expect(isEmailReviewApprovable(r, { sequenceStep: 3 })).toBe(false);
    // binaryReplyClose applies ONLY to the final email.
    expect(isEmailReviewApprovable(r, { sequenceStep: 1 })).toBe(true);
    expect(isEmailReviewApprovable(r, { sequenceStep: 2 })).toBe(true);
  });

  it('never approves generic "looks good" output that fails a core dimension', () => {
    expect(isEmailReviewApprovable(review({ decision: 'APPROVE_WITH_REVISIONS' }), { sequenceStep: 1 })).toBe(false);
    expect(isEmailReviewApprovable(review({ fabricationRisk: true }), { sequenceStep: 3 })).toBe(false);
    expect(isEmailReviewApprovable(review({ evidenceSupported: false }), { sequenceStep: 2 })).toBe(false);
  });

  it('keeps the subject reviewer fail-closed where the model authors the subject', () => {
    const bad = review({ subjectCuriosityGap: false });
    // First email: the model chose the subject, so the curiosity gate still governs.
    expect(isEmailReviewApprovable(bad, { sequenceStep: 0 })).toBe(false);
    // Follow-up with NO known thread: the model chose the subject there too.
    expect(isEmailReviewApprovable(bad, { sequenceStep: 1, subjectIsThreadContinuity: false })).toBe(false);
    // Threaded follow-up: the subject is deterministic "Re: <original>", not authored copy.
    expect(isEmailReviewApprovable(bad, { sequenceStep: 1, subjectIsThreadContinuity: true })).toBe(true);
  });

  it('exposes the per-step conjunction directly', () => {
    expect(sequenceJobSatisfied(review({ binaryReplyClose: false }), 0)).toBe(true);
    expect(sequenceJobSatisfied(review({ pressureReduced: false }), 3)).toBe(false);
  });
});

describe('thread continuity', () => {
  it('prefixes the reply subject exactly once', () => {
    expect(replySubject('Something I noticed')).toBe('Re: Something I noticed');
    expect(replySubject('Re: Something I noticed')).toBe('Re: Something I noticed');
    expect(replySubject('RE: Something I noticed')).toBe('RE: Something I noticed');
  });
});
