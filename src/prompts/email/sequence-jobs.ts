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
// Bumped for the Follow-up #2 clarity rewrite: the step-1 job used to say "same observation, same
// angle, same outcome", which invited a reworded copy of Outreach #1 — and produced one in
// production. Step 1 now has to state what the first email already established and add a
// materially new layer, and the reviewer judges exactly that.
export const SEQUENCE_JOBS_VERSION = 'sequence-jobs-5';

/**
 * The commercial principle that governs every step: we are paid for outcomes, not for tools. Copy
 * sells a useful business result, never "AI", a technology stack, a feature list, or a product tour.
 */
/**
 * The GUARDRAIL half of the outcomes principle: what may never be sold, and what may never be
 * invented. True at every step, including the ones that state no outcome at all.
 */
const OUTCOMES_PRINCIPLE = `OUTCOMES GET PAID. TOOLS DON'T.
- Never write about "AI", automation, a technology stack, a platform, a feature, or a tool for its
  own sake, and never name the technology as the value.
- Do NOT quantify an outcome. No percentages, amounts, counts, timeframes, or comparisons unless
  the supplied evidence states them. An unquantified, honest outcome beats an invented number.`;

/**
 * The REQUIREMENT half: connect the observation to an outcome. This is the FIRST email's job. A
 * follow-up that restates the outcome is repeating itself — step 1 adds a clarity layer, step 2
 * compresses, step 3 closes — so only step 0 receives it.
 */
const OUTCOMES_REQUIREMENT = `- Relevant outcome categories: revenue gained, conversions improved,
  time saved, admin reduced, leads recovered, missed follow-ups reduced, risk or friction removed.
- Connect the evidence-backed observation to ONE of those outcomes in plain business language.`;

const STEP_0 = `SEQUENCE POSITION: Outreach #1 (the first email; internal sequence step 0).

THE JOB OF THIS EMAIL: earn attention and permission, and open a conversation.
- Connect ONE real, evidence-backed business observation to a useful outcome.
- Do NOT dump the entire solution. Do not explain how it would be built, staged, or delivered.
- Do NOT make the email feel like a heavy sales process, an audit report, or an onboarding form.
- Stay concise and specific, and end on a low-friction next step the system renders for you.

${OUTCOMES_PRINCIPLE}
${OUTCOMES_REQUIREMENT}`;

const STEP_1 = `SEQUENCE POSITION: Follow-up #2 (internal sequence step 1). Outreach #1 was already
sent to this recipient in this same email thread and received no reply. Its exact text is supplied
to you below under ALREADY SENT IN THIS THREAD.

THE JOB OF THIS EMAIL: ADD CLARITY — exactly one new layer of understanding on top of the
conversation that already exists.

BEFORE YOU WRITE, work out from the sent email:
  (a) what it ALREADY established — the observation, the evidence it cited, and the business
      consequence it drew; and
  (b) what a reader could still be unclear, sceptical, or curious about after reading it.
This email exists to answer (b). If you cannot name something in (b), you have nothing to send.

REFERENCE THE PREVIOUS ISSUE — DO NOT RESTATE IT. The difference decides whether this email is worth
sending:
- REFERENCE (required): name the issue briefly so the reader knows what this is about, then move
  past it. "The banner I mentioned" is a reference.
- RESTATE (forbidden): describe the same observation again, cite the same evidence again, or draw
  the same business consequence again — in ANY wording, however rephrased. Saying the same thing in
  fresh synonyms is still saying the same thing, and the recipient learns nothing.

WHAT COUNTS AS A NEW LAYER (pick exactly ONE, drawn only from the supplied evidence):
- a DISTINCTION that corrects a likely misreading ("the issue isn't X itself, it's that ...");
- a CONSEQUENCE made concrete for one specific moment in the customer journey that the first email
  left general;
- an IMPLICATION the first email did not state;
- a CONCRETE ARTEFACT you can offer to show, when the evidence supports its existence.

YOU ARE NOT REQUIRED TO RESTATE ANYTHING. The first email already carried the observation, the
evidence and the business consequence, and they are still true. Do not reproduce them: name the issue
in passing if the reader needs the reference, and spend this email on the new layer.

HARD RULES:
- Assume the first email was read. Do NOT restart the pitch and do NOT re-introduce yourself.
- Do NOT introduce an unrelated angle, a second finding, or any material the evidence does not
  support. A new LAYER is not a new CLAIM: invent nothing.
- Never write "just following up", "circling back", "bumping this", "checking in", or any variant.
- No recap or summary of the previous email. No apology for writing again.
- No pressure, no deadline, no scarcity. Exactly one simple next action.
- SHORTER and easier to read than the first email.
- The system writes the subject line for you; produce only the body.

${OUTCOMES_PRINCIPLE}`;

const STEP_2 = `SEQUENCE POSITION: Follow-up #3 (internal sequence step 2). Outreach #1 and
Follow-up #2 were already sent in this same thread and received no reply.

THE JOB OF THIS EMAIL: COMPRESS THE ISSUE AND REDUCE PRESSURE.
- You are NOT required to open on the observation, to explain why it matters, or to state the
  business outcome again. Those were made in the first two emails. This email compresses.
- Report genericity_score HONESTLY. A compression that leans on the thread legitimately scores
  higher than a first email would, and that is not penalised at this position — do not pad the copy
  with specifics it does not need in order to report a lower number.
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
- This email carries NO observation, NO business-relevance sentence and NO outcome argument. None of
  them are required here and all of them would reopen a conversation this email exists to close.
- Report genericity_score HONESTLY, even if it is high. A short close reads as reusable out of
  context by design; that is not penalised here. Do not add specifics you do not need in order to
  report a lower number.
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
- The SYSTEM writes the closing ask for this email — a deterministic yes/no line it appends after
  your body. Do not write your own ask, and do not end the body with a question: that would leave the
  recipient with two. Write only the short, warm lead-in that line closes.
- primary_cta MUST be REPLY_FOR_DETAILS here. The approved-concept CTA is not available in the final
  email even when a demo link is allowed: sending someone to a concept asks them to do something,
  and this email asks only for a decision.
- evidence_ids still bind this email to the evidence it belongs to. That is PROVENANCE, not a
  licence to restate the finding: cite it, do not mention it.

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
Every quality dimension applies at this position, including businessRelevanceClear, persuasive,
sufficientlyPersonalized, singleObservation and confidentObservation.
The step-specific booleans addsClarityNotRestart, compressedNotExpanded, pressureReduced, and
binaryReplyClose do NOT apply to a first email — report all four as true.`;

const REVIEWER_STEP_1 = `SEQUENCE REVIEW — Follow-up #2 (internal step 1). The first email already
went out in this thread and its exact text is supplied to you.
Judge the JOB of THIS email: does it ADD CLARITY?

THE TEST THAT DECIDES addsClarityNotRestart. Read the sent email, then read this one, then answer in
your own head: WHAT NEW UNDERSTANDING DOES THE PROSPECT GAIN FROM THIS MESSAGE THAT THEY DID NOT
ALREADY HAVE? If the honest answer is "none", or if you can only answer by pointing at wording that
is different rather than at understanding that is new, then addsClarityNotRestart is FALSE.

- addsClarityNotRestart: FALSE when the email
    * paraphrases the previous observation, however well written;
    * repeats the same evidence without adding a clarification, distinction or implication;
    * restates the same business consequence in synonyms;
    * leaves the prospect knowing essentially nothing they did not know before;
    * restarts the pitch, re-introduces the sender, recaps the previous email, opens with
      "just following up"/"circling back"/"checking in";
    * or switches to a completely unrelated angle or a second finding.
  TRUE ONLY when the email names the existing issue and then ADDS one materially new layer — a
  distinction, a concrete implication, a specific moment it affects, or an artefact offered — that
  the sent email did not contain. Fluent rewriting is not clarity. Being a reasonable email is not
  enough: at this position, adding nothing is a failure.
- compressedNotExpanded: false when this email is longer or heavier than a first email would be.
- pressureReduced: false when it applies pressure, urgency, guilt, a deadline, or scarcity, or when
  it asks for more than one simple next action.
- binaryReplyClose does not apply here — report it as true.

WHAT THIS POSITION IS NOT JUDGED ON. This email does not have to make the business case again: it
was made in the first email and repeating it is the failure described above. Do NOT lower
businessRelevanceClear or persuasive because this email does not restate the observation or the
outcome — those dimensions belong to the first email, and the approval gate does not apply them
here. Judge clarity, evidence, human style, and low pressure.`;

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
- binaryReplyClose does not apply here — report it as true.

WHAT THIS POSITION IS NOT JUDGED ON. A compression adds no new observation, no new outcome argument
and no new persuasion, and it is deliberately brief. Do NOT lower businessRelevanceClear, persuasive
or sufficientlyPersonalized for any of that — none of them apply at this position. Judge whether the
issue is compressed honestly, the pressure is lower, and the copy stays evidence-bound and human.`;


const REVIEWER_STEP_3 = `SEQUENCE REVIEW — Follow-up #4 (internal step 3), the FINAL email. Judge
the JOB of THIS email: ONE clean YES / NO decision.
- binaryReplyClose: false when the recipient would have to explain themselves, schedule or accept a
  call or meeting, pick a time, or take on any task in order to answer; false when the ask is
  open-ended, multi-part, or asks a question that needs a paragraph. True ONLY when "yes" or "no"
  on its own is a complete, sufficient answer, and when saying no is presented as genuinely fine.
- pressureReduced: false for any deadline, last-chance framing, scarcity, guilt, or pressure.
- compressedNotExpanded: false when it reopens the problem, adds another explanation, teaches
  again, introduces more value, or is longer than the previous email.
- addsClarityNotRestart: false when it re-argues or re-pitches rather than simply closing.

WHAT THIS POSITION IS NOT JUDGED ON. This email is INSTRUCTED to carry no observation, no
business-relevance sentence, no outcome argument and no persuasion. Their absence is the job being
done correctly, not a defect. Do NOT lower businessRelevanceClear, persuasive, sufficientlyPersonalized,
singleObservation or confidentObservation because they are missing — none of them apply here, the
approval gate does not require them at this step, and a correct final close must not be rejected for
lacking what it was told not to write. What still applies: honesty, evidence, human style,
punctuation, exactly one ask, buyer language, and the four sequence booleans above.

THE ASK IS NOT IN THE BODY. The system appends the closing line shown to you below; the model is
forbidden from writing its own. Judge binaryReplyClose against THAT appended line together with the
body — never against the body alone, and never mark the body down for not containing an ask.`;

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
