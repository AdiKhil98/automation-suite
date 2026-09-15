/**
 * The production Follow-up #2 failure, kept as fixture data.
 *
 * Outreach #1 went out and was correct. Follow-up #2 was written, passed deterministic validation,
 * was approved by the reviewer (fabricationRisk false, personalizationSupported true, claimHonest
 * true, addsClarityNotRestart true) — and was rejected in human review because it restated the first
 * email instead of adding clarity.
 *
 * PROVENANCE OF EACH HALF — they are NOT equally authoritative:
 *
 *   Follow-up #2  EXACT. The generated body was supplied verbatim and is reproduced here unchanged.
 *                 This is the text that must never pass again.
 *
 *   Outreach #1   RECONSTRUCTED. Only the CORE WORDING of the initial email was supplied ("in
 *                 substance"); its exact stored text was not. The body below is built from that core
 *                 wording and is good enough to exercise the comparison, but it is not a claim about
 *                 what was actually sent. Replace it with the authoritative
 *                 `outreach_messages.body` for outreach record 2ee435d5 when that is available —
 *                 see INITIAL_BODY_PROVENANCE and the REPLACE-ME marker below. Nothing else in this
 *                 file needs to change when it is.
 *
 * The prior message is stored as a RENDERED email (greeting, CTA sentence, signoff) because that is
 * what `outreach_messages` holds, and therefore what the gate really compares against.
 */

/** Stated explicitly so no reader mistakes the reconstruction for the stored original. */
export const INITIAL_BODY_PROVENANCE = 'RECONSTRUCTED_FROM_SUPPLIED_CORE_WORDING' as const;

export interface FollowupFixture {
  /** What the fixture demonstrates, for failure output. */
  label: string;
  body: string;
}

const RENDERED = (core: string): string =>
  ['Hello,', '', core, '', 'If this is relevant, reply and I will share the details.', '', 'Best regards,', '{{SENDER_NAME}}'].join('\n');

export const FOLLOWUP_REPETITION_FIXTURES = {
  initial: {
    subject: 'Something I noticed on Complete Dentistry’s mobile site',
    provenance: INITIAL_BODY_PROVENANCE,
    // REPLACE-ME: swap this reconstruction for the authoritative stored body when it is provided.
    // Do not edit the wording otherwise — the thresholds were measured against exactly this text.
    body: RENDERED([
      'The cookie banner covers part of the introductory copy on mobile. Patients can only see Accept and Read More.',
      '',
      'That creates friction while they are first trying to understand the practice.',
    ].join('\n')),
  },
  followups: {
    /** EXACTLY what production generated. It must never pass again. */
    productionRestatement: {
      label: 'production Follow-up #2: same observation, same consequence, new words',
      body: [
        "The mobile cookie banner sits over part of Complete Dentistry's introductory copy, rather than simply appearing below it. In the captured view, patients can only see Accept and Read More.",
        '',
        'That puts consent in the way of understanding the practice, adding friction at the start of the patient journey.',
      ].join('\n'),
    },
    /** The direction that was actually wanted: a distinction plus an artefact offered. */
    genuineClarification: {
      label: 'clarifies what was meant and offers the captured screenshot',
      body: [
        "Just to clarify what I meant in my last note: the issue isn't the cookie banner itself — it's that, on the mobile view I captured, it competes with the first information a new patient is trying to read about the practice.",
        '',
        'If useful, I can send the exact screenshot.',
      ].join('\n'),
    },
    /** Repeats the necessary nouns, but contributes a genuinely new detail. */
    newLayerSameNouns: {
      label: 'same issue nouns, new implication',
      body: [
        'One detail I should have included: the banner only clears after a tap, so the first screen a new patient sees on mobile is consent rather than the practice itself.',
        '',
        'Happy to send the captured screen if that helps.',
      ].join('\n'),
    },
    /** A nudge with no substance. Adds no new content at all. */
    shortNudge: {
      label: 'short nudge with nothing new',
      body: 'Following up on my note about the cookie banner on mobile.',
    },
    /** Step 2's actual job: compress the issue and lower the pressure. Adds nothing — correctly. */
    validCompression: {
      label: 'step 2: short compression, no new value added',
      body: 'Still worth a look at that mobile view, I think. Happy to leave it there if the timing is wrong.',
    },
    /** Step 2 done wrong: the whole argument re-explained at length. */
    step2Reexplanation: {
      label: 'step 2: re-explains the original observation at length',
      body: [
        'To recap what I found: the cookie banner covers part of the introductory copy on mobile, and patients can only see Accept and Read More at that point.',
        '',
        'That creates friction while they are first trying to understand the practice, which is why it seemed worth raising.',
      ].join('\n'),
    },
    /** Step 3's actual job: a clean binary close carrying no new business information. */
    validBinaryClose: {
      label: 'step 3: binary close, no new information by design',
      body: [
        'I will leave this with you — a yes or a no is a complete answer, and no is completely fine.',
        '',
        'Either way, I will not keep nudging.',
      ].join('\n'),
    },
    /** Step 3 done wrong: reopening the pitch instead of closing it. */
    step3Reexplanation: {
      label: 'step 3: reopens and re-explains instead of closing',
      body: [
        'Before I close this off: the cookie banner still covers part of the introductory copy on mobile, and patients can only see Accept and Read More.',
        '',
        'That keeps creating friction while they are first trying to understand the practice, which is worth a few minutes of someone\'s time.',
      ].join('\n'),
    },
    /**
     * A true synonym rewrite: "cookie banner" -> "consent notice", "patients" -> "visitors". It says
     * nothing new, but it shares almost no wording, so no lexical gate can see it. It lives here to
     * document the boundary between the deterministic gate and the reviewer — the reviewer is the
     * layer that must refuse it.
     */
    synonymParaphrase: {
      label: 'synonym rewrite: nothing new, almost no shared wording',
      body: [
        'On phones, the consent notice overlays a portion of the opening text. Visitors are shown only Accept and Read More at that moment.',
        '',
        'That introduces resistance right as someone begins learning about the clinic.',
      ].join('\n'),
    },
  },
} as const;
