import { type MockResponder } from '../integrations/llm/mock-llm.js';

const BUSINESS_LINE = /^BUSINESS NAME: (.*)$/m;
const LANGUAGE_LINE = /^OUTPUT LANGUAGE: (.*)$/m;
const DEMO_ALLOWED_LINE = /^- link allowed: (YES|NO)$/m;
const FACT_EVIDENCE = /^- evidence_id=(\S+) type=(\S+) value=/gm;
const FINDING_EVIDENCE = /^- evidence_id=(\S+) finding_ref=(\S+) category=(\S+)/gm;

function writerResponse(user: string): Record<string, unknown> {
  const business = BUSINESS_LINE.exec(user)?.[1]?.trim() || 'the business';
  const german = (LANGUAGE_LINE.exec(user)?.[1] ?? '').startsWith('German');
  const demoAllowed = (DEMO_ALLOWED_LINE.exec(user)?.[1] ?? 'NO') === 'YES';
  const factMatches = [...user.matchAll(FACT_EVIDENCE)];
  const findingMatches = [...user.matchAll(FINDING_EVIDENCE)];
  const businessFactId = factMatches.find((match) => match[2] === 'business_name')?.[1];
  const findingId = findingMatches[0]?.[1];
  const evidenceIds = [businessFactId, findingId].filter((id): id is string => id !== undefined);

  if (german) {
    return {
      subject_options: [
        `Ein klarerer Kontaktweg für ${business}`,
        `Der schwer auffindbare Terminschritt bei ${business}`,
        `Weniger Reibung vor der Terminanfrage`,
      ],
      selected_subject: `Ein klarerer Kontaktweg für ${business}`,
      selected_subject_reason: 'Der Betreff verbindet die Praxis direkt mit der belegten Hürde.',
      email_body: [
        `Der wichtigste Kontaktweg auf der Website von ${business} ist derzeit schwer zu finden.`,
        'Das schafft unnötige Reibung genau dann, wenn ein Patient den nächsten Schritt zur Terminanfrage sucht.',
        ...(demoAllowed
          ? ['Das freigegebene Konzept zeigt, wie dieser Weg früher sichtbar wird und klar zur Anfrage führt.']
          : []),
      ].join('\n\n'),
      evidence_ids: evidenceIds,
      strategic_angle: 'Den belegten Kontaktweg als konkrete Hürde in der Patientenreise erklären.',
      business_relevance: 'Ein klarer Weg zur Terminanfrage hilft Patienten bei Orientierung und nächstem Schritt.',
      urgency_basis: 'Die belegte Hürde liegt unmittelbar zwischen Interesse und Terminanfrage.',
      competitor_evidence_used: 'NONE',
      primary_cta: demoAllowed ? 'VIEW_CONCEPT' : 'REPLY_FOR_DETAILS',
      prohibited_phrase_scan: 'PASS',
      punctuation_scan: 'PASS',
      genericity_score: 12,
      human_style_result: 'PASS',
      demo_alignment_result: demoAllowed ? 'PASS' : 'NOT_APPLICABLE',
    };
  }

  return {
    subject_options: [
      `A clearer contact path for ${business}`,
      `The hard-to-find enquiry step at ${business}`,
      'Less friction before a patient enquiry',
    ],
    selected_subject: `A clearer contact path for ${business}`,
    selected_subject_reason: 'It connects the specific business to the verified contact-path issue.',
    email_body: [
      `The main contact action on ${business}'s website is currently difficult to find.`,
      'That adds avoidable friction at the point when a patient is deciding how to make an enquiry.',
      ...(demoAllowed
        ? ['The approved concept shows how that action can appear earlier and create a clearer path to the enquiry.']
        : []),
    ].join('\n\n'),
    evidence_ids: evidenceIds,
    strategic_angle: 'Lead with the verified contact-path obstacle and its effect on the patient journey.',
    business_relevance: 'A clear enquiry path supports orientation and the next step between interest and contact.',
    urgency_basis: 'The verified obstacle sits directly between patient interest and an enquiry.',
    competitor_evidence_used: 'NONE',
    primary_cta: demoAllowed ? 'VIEW_CONCEPT' : 'REPLY_FOR_DETAILS',
    prohibited_phrase_scan: 'PASS',
    punctuation_scan: 'PASS',
    genericity_score: 12,
    human_style_result: 'PASS',
    demo_alignment_result: demoAllowed ? 'PASS' : 'NOT_APPLICABLE',
  };
}

export const defaultMockEmailResponder: MockResponder = (request) => {
  if (request.task === 'email_write') return { rawJson: writerResponse(request.user) };
  return {
    rawJson: {
      decision: 'APPROVE',
      fabricationRisk: false,
      subjectSpecific: true,
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
      problems: [],
      requiredRevisions: [],
    },
  };
};
