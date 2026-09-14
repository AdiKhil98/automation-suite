/**
 * The REAL production Follow-up #2 failure, kept as fixture data.
 *
 * Outreach #1 went out and was correct. Follow-up #2 was written, passed deterministic validation,
 * was approved by the reviewer (fabricationRisk false, personalizationSupported true, claimHonest
 * true, addsClarityNotRestart true) — and was rejected in human review because it restated the first
 * email instead of adding clarity. Everything here is the shape of that pair plus the counter-cases
 * that a fix must NOT break.
 *
 * The bodies are stored as RENDERED emails (greeting, CTA sentence, signoff) for the prior message,
 * because that is what `outreach_messages` holds and therefore what the gate really compares against.
 */

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
