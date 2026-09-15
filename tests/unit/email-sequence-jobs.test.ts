import { describe, expect, it } from 'vitest';
import {
  buildEmailReviewerMessages,
  buildEmailWriterMessages,
  EMAIL_REVIEWER_PROMPT_VERSION,
  EMAIL_WRITER_PROMPT_VERSION,
  type EmailBrief,
  type SequenceContext,
} from '../../src/prompts/email/index.js';
import { SEQUENCE_JOBS_VERSION } from '../../src/prompts/email/sequence-jobs.js';
import { EMAIL_SCHEMA_VERSION } from '../../src/domain/email/email-schema.js';
import { type EmailReviewParsed } from '../../src/domain/email/email-schema.js';
import {
  isEmailReviewApprovable,
  reviewApplicabilityMatrix,
  sequenceJobSatisfied,
} from '../../src/domain/email/email-review-gate.js';
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

describe('Follow-up #2 clarity contract (production regression)', () => {
  // The step-1 job used to say "Preserve continuity with the original email: same observation, same
  // angle, same outcome" — an instruction a model satisfies by rewriting Outreach #1, which is
  // exactly what shipped. Both prompts now demand a NEW layer and name the failure mode.
  const writerStep1 = (): string => buildEmailWriterMessages(brief, null, seq(1)).system;
  const reviewerStep1 = (): string => buildEmailReviewerMessages(brief, draft, seq(1)).system;

  it('no longer tells the writer to reproduce the same observation and outcome', () => {
    expect(writerStep1()).not.toContain('same observation, same angle, same outcome');
  });

  it('makes the reference-vs-restate distinction explicit for the writer', () => {
    const system = writerStep1();
    expect(system).toContain('REFERENCE THE PREVIOUS ISSUE — DO NOT RESTATE IT');
    expect(system).toMatch(/REFERENCE \(required\)/);
    expect(system).toMatch(/RESTATE \(forbidden\)/);
    // Synonyms are named as the trap they are.
    expect(system).toMatch(/fresh synonyms is still saying the same thing/i);
  });

  it('tells the writer to work out what the first email already established', () => {
    const system = writerStep1();
    expect(system).toMatch(/what it ALREADY established/);
    expect(system).toMatch(/WHAT COUNTS AS A NEW LAYER/);
    // ...and that a new layer is not licence to invent evidence.
    expect(system).toMatch(/A new LAYER is not a new CLAIM: invent nothing/);
  });

  it('keeps the step-1 constraints that already worked', () => {
    const system = writerStep1();
    expect(system).toContain('just following up');
    expect(system).toContain('Do NOT restart the pitch');
    expect(system).toMatch(/SHORTER and easier to read than the first email/);
    expect(system).toMatch(/No pressure, no deadline, no scarcity/);
  });

  it('gives the reviewer the question that decides the verdict', () => {
    const system = reviewerStep1();
    expect(system).toMatch(/WHAT NEW UNDERSTANDING DOES THE PROSPECT GAIN/);
    expect(system).toMatch(/If the honest answer is "none"/);
  });

  it('names every way a step-1 email can fail by adding nothing', () => {
    const system = reviewerStep1();
    expect(system).toMatch(/paraphrases the previous observation/);
    expect(system).toMatch(/repeats the same evidence without adding a clarification/);
    expect(system).toMatch(/restates the same business consequence in synonyms/);
    expect(system).toMatch(/knowing essentially nothing they did not know before/);
    expect(system).toMatch(/Fluent rewriting is not clarity/);
  });

  it('does not weaken the fabrication and honesty rules', () => {
    const system = reviewerStep1();
    expect(system).toContain('fabricationRisk');
    expect(system).toMatch(/Never invent customer behavior, revenue, performance/);
    expect(system).toContain('SINGLE-OBSERVATION, BUYER-LANGUAGE STANDARD');
  });

  it('leaves steps 2 and 3 with their own jobs', () => {
    expect(buildEmailWriterMessages(brief, null, seq(2)).system).toContain('COMPRESS THE ISSUE AND REDUCE PRESSURE');
    expect(buildEmailWriterMessages(brief, null, seq(3)).system).toContain('create ONE clean YES / NO decision');
    // The step-1 clarity block belongs to step 1 only.
    expect(buildEmailWriterMessages(brief, null, seq(2)).system).not.toContain('REFERENCE THE PREVIOUS ISSUE');
    expect(buildEmailWriterMessages(brief, null, seq(0)).system).not.toContain('REFERENCE THE PREVIOUS ISSUE');
  });

  it('records the version bump so a stored draft traces to the instructions that produced it', () => {
    expect(SEQUENCE_JOBS_VERSION).toBe('sequence-jobs-4');
    expect(EMAIL_WRITER_PROMPT_VERSION).toBe('email-writer-8');
    expect(EMAIL_REVIEWER_PROMPT_VERSION).toBe('email-reviewer-9');
    // The JSON contract did not change, so the schema version deliberately did not move.
    expect(EMAIL_SCHEMA_VERSION).toBe('email-copy-schema-5');
  });
});

describe('no step receives an instruction that contradicts its own job', () => {
  // The copy-JOB requirements — open on the observation, explain why it matters, connect it to an
  // outcome — used to be global. They are right for Outreach #1 and wrong for every follow-up: they
  // demand exactly the restatement the sequence jobs forbid, which is how a Follow-up #2 that
  // repeated Outreach #1 came to be written AND approved.
  const prompts = (step: SequenceStep): string[] => [
    buildEmailWriterMessages(brief, null, seq(step, step === 0 ? null : 'Something I noticed')).system,
    buildEmailReviewerMessages(brief, draft, seq(step, step === 0 ? null : 'Something I noticed')).system,
  ];

  /** The first-email body requirements, each phrased as it appears in the prompt. */
  const FIRST_EMAIL_REQUIREMENTS = [
    'Start email_body with a verified observation',
    'Explain why the issue matters in the customer or patient journey',
    'State the business relevance in ONE short sentence',
    'Connect that observation to ONE useful business outcome',
  ];

  it('step 0 keeps the full observation -> relevance -> outcome standard', () => {
    for (const prompt of prompts(0)) {
      for (const requirement of FIRST_EMAIL_REQUIREMENTS) expect(prompt).toContain(requirement);
    }
  });

  it.each([1, 2, 3] as const)('step %i receives NONE of them', (step) => {
    for (const prompt of prompts(step)) {
      for (const requirement of FIRST_EMAIL_REQUIREMENTS) expect(prompt).not.toContain(requirement);
    }
  });

  it.each([1, 2, 3] as const)('step %i is told it does not owe a restatement', (step) => {
    const writer = prompts(step)[0]!;
    const release = {
      1: 'YOU ARE NOT REQUIRED TO RESTATE ANYTHING',
      2: 'You are NOT required to open on the observation',
      3: 'This email carries NO observation, NO business-relevance sentence and NO outcome argument',
    }[step];
    expect(writer).toContain(release);
  });

  it('the outcome REQUIREMENT is step 0 only; the outcome GUARDRAIL is everywhere', () => {
    expect(prompts(0)[0]).toContain('Connect the evidence-backed observation to ONE of those outcomes');
    for (const step of [1, 2, 3] as const) {
      expect(prompts(step)[0]).not.toContain('Connect the evidence-backed observation to ONE of those outcomes');
      // ...while "never sell the tool, never invent a number" still applies at every step.
      expect(prompts(step)[0]).toContain('OUTCOMES GET PAID. TOOLS DON\'T.');
      expect(prompts(step)[0]).toContain('Do NOT quantify an outcome');
    }
  });

  it('keeps safety, evidence, fabrication and style rules global', () => {
    const shared = [
      'SECURITY AND EVIDENCE RULES',
      'Never invent customer behavior, revenue, performance',
      'Never write a URL',
      'FORBIDDEN PHRASES INCLUDE',
      'No em dash, en dash as separator',
      'SINGLE-OBSERVATION, BUYER-LANGUAGE STANDARD',
      'COLD EMAIL COPY STANDARD',
    ];
    for (const step of [0, 1, 2, 3] as const) {
      for (const rule of shared) {
        expect(prompts(step)[0], `writer step ${String(step)}`).toContain(rule);
        expect(prompts(step)[1], `reviewer step ${String(step)}`).toContain(rule);
      }
    }
  });

  it('the single-observation rule no longer demands an observation the job forbids', () => {
    // Step 3 carries none by design, so the rule is a ceiling ("never more than one"), not a floor.
    for (const step of [0, 1, 2, 3] as const) {
      expect(prompts(step)[0]).toContain('The body never carries more than ONE evidence-backed observation');
      expect(prompts(step)[0]).not.toContain('The body makes exactly ONE evidence-backed observation');
    }
  });
});

describe('the reviewer is never told to reject for a dimension the gate does not apply', () => {
  // The rejection instruction used to be one global sentence listing generic-opening, unclear
  // business relevance and "could be sent to almost any business". At steps 2 and 3 the approval
  // gate treats all of those as non-applicable, so instructing a REJECT for them would have the
  // reviewer refuse the job being done correctly — and the gate would never have seen the verdict.
  const reviewerAt = (step: SequenceStep): string =>
    buildEmailReviewerMessages(brief, draft, seq(step, step === 0 ? null : 'Something I noticed')).system;

  it('keeps the universal rejection conditions at every step', () => {
    for (const step of [0, 1, 2, 3] as const) {
      const prompt = reviewerAt(step);
      expect(prompt).toContain('urgency is fabricated');
      expect(prompt).toContain('competitor language is');
      expect(prompt).toContain('there is more than one CTA');
      expect(prompt).toContain('evidence does not');
      expect(prompt).toContain('promises more than the approved demo visibly delivers');
    }
  });

  it('step 0 keeps the full first-email rejection conditions', () => {
    const prompt = reviewerAt(0);
    expect(prompt).toContain('the opening is generic');
    expect(prompt).toContain('business relevance is unclear');
    expect(prompt).toContain('the email is unpersuasive');
    expect(prompt).toContain('could be sent unchanged to almost any business');
  });

  it('step 1 keeps specificity but is told not to demand the business case again', () => {
    const prompt = reviewerAt(1);
    expect(prompt).toContain('the opening is generic');
    expect(prompt).toMatch(/Do NOT reject because this email does not restate the business case/);
    expect(prompt).not.toContain('business relevance is unclear');
    expect(prompt).not.toContain('the email is unpersuasive');
  });

  it.each([2, 3] as const)('step %i is not told to reject for brevity, genericity or a missing argument', (step) => {
    const prompt = reviewerAt(step);
    // None of the first-email rejection conditions reach these positions...
    expect(prompt).not.toContain('the opening is generic');
    expect(prompt).not.toContain('business relevance is unclear');
    expect(prompt).not.toContain('the email is unpersuasive');
    expect(prompt).not.toContain('could be sent unchanged to almost any business');
    // ...and the prompt says so explicitly, in each of the four ways this can go wrong.
    expect(prompt).toMatch(/Do NOT reject this email for being short/);
    expect(prompt).toMatch(/not restating the observation or the business\s*relevance/);
    expect(prompt).toMatch(/for not arguing again/);
    expect(prompt).toMatch(/could apply to another business when\s*taken out of context/);
  });

  it('step 3 is additionally told a non-specific close is correct', () => {
    const prompt = reviewerAt(3);
    expect(prompt).toMatch(/Do NOT lower businessRelevanceClear, persuasive, sufficientlyPersonalized/);
    expect(prompt).toMatch(/THE ASK IS NOT IN THE BODY/);
  });

  it('the rejection scope matches the approval gate exactly', () => {
    // Anything the reviewer is told to reject for at this step must be a dimension the gate
    // actually requires there. This is the invariant the old global sentence broke.
    const firstEmailOnly = ['business relevance is unclear', 'the email is unpersuasive'];
    for (const step of [1, 2, 3] as const) {
      const prompt = reviewerAt(step);
      for (const condition of firstEmailOnly) {
        expect(prompt, `step ${String(step)}: ${condition}`).not.toContain(condition);
      }
      if (!reviewApplicabilityMatrix(step).openingSpecific) {
        expect(prompt, `step ${String(step)}: generic opening`).not.toContain('the opening is generic');
      }
    }
  });
});
