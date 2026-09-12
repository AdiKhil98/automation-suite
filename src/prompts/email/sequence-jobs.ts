import { type SequenceStep } from '../../domain/outreach/sequence.js';

/**
 * Step-specific JOBS for the outreach sequence. Every email in the sequence has a DIFFERENT job;
 * a follow-up is not "another cold email". These blocks are composed into the writer system prompt
 * and the reviewer rubric so the model is instructed — and then independently judged — against the
 * job of the exact step it is writing.
 *
 * Internal step numbering (see `src/domain/outreach/sequence.ts`):
 *   step 0 = lesson Outreach #1 (day 0)
 *   step 1 = lesson Follow-up #2 (day 2)
 *   step 2 = lesson Follow-up #3 (day 4)
 *   step 3 = lesson Follow-up #4 (day 7, FINAL — nothing is scheduled after it)
 *
 * Versioned so a stored email can always be traced back to the exact instructions that produced it.
 */
export const SEQUENCE_JOBS_VERSION = 'sequence-jobs-1';

/**
 * The commercial principle that governs every step: we are paid for outcomes, not for tools. Copy
 * sells a useful business result, never "AI", a technology stack, a feature list, or a product tour.
 */
const OUTCOMES_PRINCIPLE = `OUTCOMES GET PAID. TOOLS DON'T.
- Write about a useful business outcome, never about "AI", automation, a technology stack, a
  platform, a feature, or a tool for its own sake. Never name the technology as the value.
- Relevant outcome categories: revenue gained, conversions improved, time saved, admin reduced,
  leads recovered, missed follow-ups reduced, risk or friction removed.
- Connect the evidence-backed observation to ONE of those outcomes in plain business language.
- Do NOT quantify the outcome. No percentages, amounts, counts, timeframes, or comparisons unless
  the supplied evidence states them. An unquantified, honest outcome beats an invented number.`;

const STEP_0 = `SEQUENCE POSITION: Outreach #1 (the first email; internal sequence step 0).

THE JOB OF THIS EMAIL: earn attention and permission, and open a conversation.
- Connect ONE real, evidence-backed business observation to a useful outcome.
- Do NOT dump the entire solution. Do not explain how it would be built, staged, or delivered.
- Do NOT make the email feel like a heavy sales process, an audit report, or an onboarding form.
- Stay concise and specific, and end on a low-friction next step the system renders for you.

${OUTCOMES_PRINCIPLE}`;

const STEP_1 = `SEQUENCE POSITION: Follow-up #2 (internal sequence step 1). Outreach #1 was already
sent to this recipient in this same email thread and received no reply.

THE JOB OF THIS EMAIL: ADD CLARITY. Nothing else.
- Assume the first email was read. Do NOT restart the pitch and do NOT re-introduce yourself.
- Make the ORIGINAL observation easier to understand, clarify what was meant, or make the useful
  outcome more concrete. That is the entire purpose.
- Preserve continuity with the original email: same observation, same angle, same outcome.
- Do NOT introduce a completely unrelated angle, a second finding, or new material.
- Never write "just following up", "circling back", "bumping this", "checking in", or any variant.
- No recap of the previous email. No summary of what you already said. No apology for writing again.
- No pressure, no deadline, no scarcity. Exactly one simple next action.
- Shorter than the first email.

${OUTCOMES_PRINCIPLE}`;

const STEP_2 = `SEQUENCE POSITION: Follow-up #3 (internal sequence step 2). Outreach #1 and
Follow-up #2 were already sent in this same thread and received no reply.

THE JOB OF THIS EMAIL: COMPRESS THE ISSUE AND REDUCE PRESSURE.
- The recipient already has enough context. Do NOT teach, persuade, or explain again.
- Become SHORTER than the previous email, not longer. Compress the issue into its simplest useful
  form — ideally one or two short sentences of substance.
- Do NOT add another feature, another finding, or new value just because the last email was ignored.
- Do NOT restart Outreach #1 and do NOT re-explain the observation from scratch.
- Signal, without self-pity or guilt, that you are not going to keep nudging them endlessly.
- Keep responding low-friction. No pressure, no deadline, no scarcity, no guilt.

${OUTCOMES_PRINCIPLE}`;

const STEP_3 = `SEQUENCE POSITION: Follow-up #4 (internal sequence step 3). This is the FINAL email
of the sequence. Outreach #1, Follow-up #2, and Follow-up #3 were already sent in this same thread
and received no reply. NOTHING is sent after this email.

THE JOB OF THIS EMAIL: create ONE clean YES / NO decision.
- Do NOT convince again. Do NOT teach again. Do NOT reopen or re-explain the problem.
- Do NOT add another long explanation, another angle, or more value.
- Do NOT ask them to schedule a call, book a meeting, pick a time, or hop on a quick chat.
- Do NOT make replying feel like entering a sales process.

WHY THIS MATTERS: an interested prospect often stays silent because replying feels like it commits
them to explaining themselves, booking a meeting, or starting a sales conversation. This email must
remove that fear. Make the reply feel binary and effortless — a single word is a complete answer.
- The next action must be answerable with essentially "yes" or "no", with no explanation, no
  meeting, and no further work required from the recipient.
- Make it easy and cost-free to say no. Saying no must be an acceptable, stated option.
- Short. Warm. Final. No pressure, no guilt, no deadline, no last-chance framing.

${OUTCOMES_PRINCIPLE}`;

const WRITER_JOBS: Record<SequenceStep, string> = { 0: STEP_0, 1: STEP_1, 2: STEP_2, 3: STEP_3 };

/** The writer instruction block for this sequence step. */
export function writerSequenceJob(step: SequenceStep): string {
  return WRITER_JOBS[step];
}

/**
 * Subject-line handling per step. Follow-ups continue the EXISTING Gmail thread, so their subject
 * is deterministic thread continuity ("Re: <original subject>") and is NOT authored by the model —
 * manufacturing a fresh subject would break the thread the recipient already has.
 */
const SUBJECT_FOLLOWUP = `SUBJECT LINE FOR THIS FOLLOW-UP:
- This email continues the EXISTING thread, so the system reuses the original subject verbatim as a
  reply subject. Your subject fields are NOT used as copy and must not attempt a new hook.
- Put the exact thread subject supplied below in all three subject options and in selected_subject.
- selected_subject_reason must simply state that thread continuity is preserved.`;

export function subjectInstructionFor(step: SequenceStep, threadSubject: string | null): string | null {
  if (step === 0) return null;
  return threadSubject === null
    ? null
    : `${SUBJECT_FOLLOWUP}\nTHREAD SUBJECT (use verbatim): ${JSON.stringify(threadSubject)}`;
}

const REVIEWER_STEP_0 = `SEQUENCE REVIEW — Outreach #1 (internal step 0). Judge whether the email
earns attention and permission: one evidence-backed observation tied to a useful business outcome,
no full solution dump, no heavy sales process, concise and specific.
The step-specific booleans addsClarityNotRestart, compressedNotExpanded, pressureReduced, and
binaryReplyClose do NOT apply to a first email — report all four as true.`;

const REVIEWER_STEP_1 = `SEQUENCE REVIEW — Follow-up #2 (internal step 1). The first email already
went out in this thread. Judge the JOB of THIS email: does it ADD CLARITY?
- addsClarityNotRestart: false when the email restarts the pitch, re-introduces the sender, recaps
  the previous email, opens with "just following up"/"circling back"/"checking in", or switches to a
  completely unrelated angle or a second finding. True ONLY when it clarifies the ORIGINAL
  observation or makes its outcome more concrete while preserving continuity.
- compressedNotExpanded: false when this email is longer or heavier than a first email would be.
- pressureReduced: false when it applies pressure, urgency, guilt, a deadline, or scarcity, or when
  it asks for more than one simple next action.
- binaryReplyClose does not apply here — report it as true.`;

const REVIEWER_STEP_2 = `SEQUENCE REVIEW — Follow-up #3 (internal step 2). Two emails already went
out in this thread. Judge the JOB of THIS email: COMPRESS AND REDUCE PRESSURE.
- compressedNotExpanded: false when the email is not clearly shorter and simpler than the previous
  one, when it re-teaches or re-argues the point, or when it adds a new finding, feature, or value
  simply because the last email was ignored. True ONLY when the issue is compressed to its simplest
  useful form.
- pressureReduced: false when it pressures, guilts, sets a deadline, invents scarcity, or makes
  replying feel costly. True when it lowers pressure and signals the nudging is not endless.
- addsClarityNotRestart: false when it restarts Outreach #1 or re-explains the observation from
  scratch.
- binaryReplyClose does not apply here — report it as true.`;

const REVIEWER_STEP_3 = `SEQUENCE REVIEW — Follow-up #4 (internal step 3), the FINAL email. Judge
the JOB of THIS email: ONE clean YES / NO decision.
- binaryReplyClose: false when the recipient would have to explain themselves, schedule or accept a
  call or meeting, pick a time, or take on any task in order to answer; false when the ask is
  open-ended, multi-part, or asks a question that needs a paragraph. True ONLY when "yes" or "no"
  on its own is a complete, sufficient answer, and when saying no is presented as genuinely fine.
- pressureReduced: false for any deadline, last-chance framing, scarcity, guilt, or pressure.
- compressedNotExpanded: false when it reopens the problem, adds another explanation, teaches
  again, introduces more value, or is longer than the previous email.
- addsClarityNotRestart: false when it re-argues or re-pitches rather than simply closing.`;

const REVIEWER_JOBS: Record<SequenceStep, string> = {
  0: REVIEWER_STEP_0, 1: REVIEWER_STEP_1, 2: REVIEWER_STEP_2, 3: REVIEWER_STEP_3,
};

/**
 * The reviewer rubric block for this sequence step. The reviewer fails closed on the booleans that
 * apply to the step; `isEmailReviewApprovable` enforces exactly the applicable subset.
 */
export function reviewerSequenceJob(step: SequenceStep): string {
  return REVIEWER_JOBS[step];
}

/** A prior message in the same thread, supplied to follow-up steps for continuity. */
export interface PriorSequenceMessage {
  sequenceStep: number;
  subject: string;
  body: string;
}

/**
 * Serialize the already-sent messages of this thread. Follow-up copy must preserve continuity with
 * what was actually sent, so the exact stored text is supplied — as untrusted DATA, never as
 * instructions, and never as a source of new factual claims.
 */
export function serializePriorMessages(prior: readonly PriorSequenceMessage[]): string {
  if (prior.length === 0) return '(none)';
  return prior
    .map((m) => `--- already sent (internal step ${String(m.sequenceStep)}) ---\nsubject: ${m.subject}\nbody:\n${m.body}`)
    .join('\n\n');
}
