import { type EmailWriterOutput } from '../../src/domain/email/email-types.js';

export interface EmailCopyFixture {
  name: string;
  businessDomain: string;
  language: 'en' | 'de';
  demoAllowed?: boolean;
  approvedDemoFindingIds?: string[];
  expectedOk: boolean;
  expectedViolation?: string;
  writer: EmailWriterOutput;
}

const english = (overrides: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
  subject_options: [
    'A clearer booking path for Linden Dental',
    'The hidden appointment step at Linden Dental',
    'Less friction before a Linden Dental booking',
  ],
  selected_subject: 'A clearer booking path for Linden Dental',
  selected_subject_reason: 'It ties the verified booking-path issue to the specific practice.',
  email_body: [
    "Linden Dental's appointment action is difficult to find on the main page.",
    'That creates avoidable friction when a patient is ready to move from researching care to booking.',
  ].join('\n\n'),
  evidence_ids: ['fact-business', 'finding-cta'],
  strategic_angle: 'Lead with the verified appointment-path obstacle.',
  business_relevance: 'Clear appointment access supports patient orientation and the path to booking.',
  urgency_basis: 'The verified issue affects the moment between patient interest and booking.',
  competitor_evidence_used: 'NONE',
  primary_cta: 'REPLY_FOR_DETAILS',
  prohibited_phrase_scan: 'PASS',
  punctuation_scan: 'PASS',
  genericity_score: 10,
  human_style_result: 'PASS',
  demo_alignment_result: 'NOT_APPLICABLE',
  ...overrides,
});

const german = (overrides: Partial<EmailWriterOutput> = {}): EmailWriterOutput => ({
  subject_options: [
    'Ein klarerer Terminweg für Zahnarztpraxis Linden',
    'Der versteckte Terminschritt bei Praxis Linden',
    'Weniger Reibung vor der Terminanfrage',
  ],
  selected_subject: 'Ein klarerer Terminweg für Zahnarztpraxis Linden',
  selected_subject_reason: 'Der Betreff verbindet die Praxis mit der belegten Hürde.',
  email_body: [
    'Der Terminbutton der Zahnarztpraxis Linden ist auf der Hauptseite schwer zu finden.',
    'Das erschwert Patienten die Orientierung genau dann, wenn sie den nächsten Schritt zur Buchung suchen.',
  ].join('\n\n'),
  evidence_ids: ['fact-business', 'finding-cta'],
  strategic_angle: 'Mit der belegten Hürde im Terminweg beginnen.',
  business_relevance: 'Ein klarer Terminweg unterstützt Orientierung und Buchung.',
  urgency_basis: 'Die belegte Hürde liegt zwischen Interesse und Terminanfrage.',
  competitor_evidence_used: 'NONE',
  primary_cta: 'REPLY_FOR_DETAILS',
  prohibited_phrase_scan: 'PASS',
  punctuation_scan: 'PASS',
  genericity_score: 9,
  human_style_result: 'PASS',
  demo_alignment_result: 'NOT_APPLICABLE',
  ...overrides,
});

export const EMAIL_COPY_FIXTURES: EmailCopyFixture[] = [
  {
    name: 'strong German dental email',
    businessDomain: 'zahnarzt-linden.example',
    language: 'de',
    expectedOk: true,
    writer: german(),
  },
  {
    name: 'strong English business email',
    businessDomain: 'linden-dental.example',
    language: 'en',
    expectedOk: true,
    writer: english(),
  },
  {
    name: 'generic AI-written email',
    businessDomain: 'generic-practice.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'generic_subject:1',
    writer: english({
      subject_options: ['Quick question', 'Improve your website', 'Website idea for Generic Practice'],
      selected_subject: 'Quick question',
      email_body: [
        "I hope this email finds you well. In today's digital world, a seamless user experience matters.",
        'A tailored solution can unlock your full potential.',
      ].join('\n\n'),
      genericity_score: 95,
    }),
  },
  {
    name: 'fake urgency',
    businessDomain: 'urgent-dental.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'contains_fake_urgency',
    writer: english({
      email_body: [
        "Linden Dental's appointment action is difficult to find.",
        'Act now because this concept is only available this week.',
      ].join('\n\n'),
    }),
  },
  {
    name: 'unsupported competitor comparison',
    businessDomain: 'market-claim.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'unsupported_competitor_language',
    writer: english({
      email_body: [
        "Linden Dental's appointment action is difficult to find.",
        'Other clinics make this easier, so competitors are winning more patients.',
      ].join('\n\n'),
    }),
  },
  {
    name: 'multiple CTAs',
    businessDomain: 'multi-cta.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'cta_in_model_body',
    writer: english({
      email_body: [
        "Linden Dental's appointment action is difficult to find.",
        'Reply to this email, then book a call and take a look at the concept.',
      ].join('\n\n'),
    }),
  },
  {
    name: 'excessive cautious language',
    businessDomain: 'cautious-copy.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'excessive_cautious_wording',
    writer: english({
      email_body: [
        "Linden Dental's appointment action might be difficult to find.",
        'Perhaps it could potentially add friction and maybe the path should perhaps be reviewed.',
      ].join('\n\n'),
    }),
  },
  {
    name: 'punctuation violations',
    businessDomain: 'punctuation.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'contains_em_dash',
    writer: english({
      email_body: [
        "Linden Dental's appointment action is hidden — especially on the main page.",
        'That creates friction -- at the point of booking.',
      ].join('\n\n'),
    }),
  },
  {
    name: 'generic subject',
    businessDomain: 'generic-subject.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'generic_subject:1',
    writer: english({
      subject_options: ['New website concept', 'A booking-path issue at Linden Dental', 'Finding the appointment action'],
      selected_subject: 'New website concept',
    }),
  },
  {
    name: 'overpromises compared with demo',
    businessDomain: 'demo-overpromise.example',
    language: 'en',
    demoAllowed: true,
    approvedDemoFindingIds: ['finding-cta'],
    expectedOk: false,
    expectedViolation: 'demo_claim_not_bound_to_demo_finding',
    writer: english({
      email_body: [
        "Linden Dental's service information is difficult to scan.",
        'The approved concept demonstrates a complete service comparison and instant online booking.',
      ].join('\n\n'),
      evidence_ids: ['fact-business', 'finding-other'],
      primary_cta: 'VIEW_CONCEPT',
      demo_alignment_result: 'PASS',
    }),
  },
  {
    name: 'evidence mismatch',
    businessDomain: 'evidence-mismatch.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'evidence_id_not_available:unknown-evidence',
    writer: english({ evidence_ids: ['fact-business', 'unknown-evidence'] }),
  },
  {
    name: 'valid conversion hub language',
    businessDomain: 'conversion-hub-valid.example',
    language: 'en',
    expectedOk: true,
    writer: english({
      email_body: [
        "Linden Dental's appointment action is difficult to find.",
        'Treating the site as a conversion hub makes sense here because it should guide patient interest toward booking.',
      ].join('\n\n'),
      business_relevance: 'The conversion hub description clarifies the verified path from interest to booking.',
    }),
  },
  {
    name: 'forced conversion hub language',
    businessDomain: 'conversion-hub-forced.example',
    language: 'en',
    expectedOk: false,
    expectedViolation: 'forced_conversion_hub_language',
    writer: english({
      email_body: [
        'The typography at Linden Dental uses a small heading.',
        'The website should become a conversion hub for stronger digital energy.',
      ].join('\n\n'),
      business_relevance: 'A conversion hub creates strategic digital energy.',
    }),
  },
];
