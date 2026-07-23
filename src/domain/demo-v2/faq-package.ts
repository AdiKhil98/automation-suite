import { z } from 'zod';
import { demoV2DirectionSchema, demoV2LanguageSchema, expectedDirection } from './clinic-intelligence.js';
import { demoV2Hash, SHA256_PATTERN } from './hash.js';
import { type ClinicIntelligenceData, type DemoV2SourceRecord } from './orchestration-types.js';

/**
 * Deterministic FAQ concierge data.
 *
 * A topic exists ONLY when specific verified evidence supports it; nothing is inferred and nothing
 * is invented. Answers deliberately point at the verified on-page section or contact channel rather
 * than restating a value, so a FAQ answer can never contradict, duplicate, or outlive the verified
 * fact it depends on. Answers never diagnose, never recommend treatment, and never assert opening
 * hours, services, availability, or contact channels that are not already verified evidence.
 */

export const FAQ_TOPICS = [
  'booking',
  'locations',
  'opening_hours',
  'urgent_contact',
  'first_visit',
  'treatment_discovery',
  'anxious_patient',
  'children_family',
  'supported_languages',
  'escalation',
] as const;
export type DemoV2FaqTopic = (typeof FAQ_TOPICS)[number];

export const FAQ_ESCALATION_TARGETS = [
  'APPOINTMENT', 'PHONE', 'EMAIL', 'WHATSAPP', 'CONTACT_FORM', 'LOCATION_PAGE', 'NONE',
] as const;
export type DemoV2FaqEscalationTarget = (typeof FAQ_ESCALATION_TARGETS)[number];

/** Phrases that would turn a concierge answer into medical advice or a treatment recommendation. */
const PROHIBITED_ANSWER_PATTERNS: RegExp[] = [
  /diagnos/i, /prescrib/i, /verschreib/i, /dosage|dosierung|posologie/i,
  /we recommend|wir empfehlen|nous recommandons/i,
  /treatment plan|behandlungsplan|plan de traitement/i,
  /\bcures?\b|\bheals?\b/i,
  /אבחון|מרשם|ממליצים/u,
  /تشخيص|وصفة|ننصح/u,
];

export const faqEntrySchema = z.object({
  topic: z.enum(FAQ_TOPICS),
  questionKey: z.string().min(1),
  answerKey: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  /** Every entry binds to the exact evidence that authorized it. */
  supportingSourceIds: z.array(z.string().min(1)).min(1),
  supportingSourceHashes: z.array(z.string().regex(SHA256_PATTERN)).min(1),
  escalationTarget: z.enum(FAQ_ESCALATION_TARGETS),
  entryHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  for (const pattern of PROHIBITED_ANSWER_PATTERNS) {
    if (pattern.test(value.answer) || pattern.test(value.question)) {
      ctx.addIssue({ code: 'custom', message: `faq_medical_or_recommendation_language_prohibited:${value.topic}` });
    }
  }
  if (value.supportingSourceIds.length !== value.supportingSourceHashes.length) {
    ctx.addIssue({ code: 'custom', message: 'faq_source_binding_mismatch' });
  }
});
export type DemoV2FaqEntry = z.infer<typeof faqEntrySchema>;

export const faqPackageSchema = z.object({
  language: demoV2LanguageSchema,
  direction: demoV2DirectionSchema,
  entries: z.array(faqEntrySchema),
  /** Stable, language-neutral topic keys the future chatbot interface can offer as prompts. The
   * display text lives in the per-topic question content items, which carry prepared English. */
  suggestedQuestionKeys: z.array(z.string().min(1)),
  omittedTopics: z.array(z.enum(FAQ_TOPICS)),
  packageHash: z.string().regex(SHA256_PATTERN),
}).superRefine((value, ctx) => {
  if (value.direction !== expectedDirection(value.language)) {
    ctx.addIssue({ code: 'custom', path: ['direction'], message: 'direction does not match language' });
  }
  const topics = value.entries.map((entry) => entry.topic);
  if (new Set(topics).size !== topics.length) {
    ctx.addIssue({ code: 'custom', path: ['entries'], message: 'faq topics must be unique' });
  }
  for (const topic of topics) {
    if (value.omittedTopics.includes(topic)) {
      ctx.addIssue({ code: 'custom', message: `faq_topic_present_and_omitted:${topic}` });
    }
  }
});
export type DemoV2FaqPackage = z.infer<typeof faqPackageSchema>;

type FaqText = Record<DemoV2FaqTopic, { q: string; a: string }>;

const FAQ_TEXT: Record<'de' | 'en' | 'fr' | 'he' | 'ar', FaqText> = {
  en: {
    booking: { q: 'How can I request an appointment?', a: 'Use the verified appointment option shown on this page.' },
    locations: { q: 'Where is the clinic located?', a: 'The verified address is shown in the location section of this page.' },
    opening_hours: { q: 'When is the clinic open?', a: 'The verified opening hours are shown in the opening hours section of this page.' },
    urgent_contact: { q: 'What should I do in an urgent situation?', a: 'Use the verified urgent contact shown on this page. This page does not provide medical advice.' },
    first_visit: { q: 'How can I arrange a first visit?', a: 'Use the verified contact option shown on this page.' },
    treatment_discovery: { q: 'Which treatments does the clinic list?', a: 'The verified treatment names are shown in the treatments section of this page.' },
    anxious_patient: { q: 'I feel anxious about dental visits. What can I do?', a: 'You can mention this when you contact the clinic using the verified contact option on this page.' },
    children_family: { q: 'Does the clinic care for children and families?', a: 'Family care is described in the verified clinic information on this page.' },
    supported_languages: { q: 'Which languages are available?', a: 'The available languages are shown in the language switcher on this page.' },
    escalation: { q: 'How can I reach the clinic directly?', a: 'Use one of the verified contact channels shown on this page.' },
  },
  de: {
    booking: { q: 'Wie kann ich einen Termin anfragen?', a: 'Nutzen Sie die auf dieser Seite angegebene verifizierte Terminoption.' },
    locations: { q: 'Wo befindet sich die Praxis?', a: 'Die verifizierte Adresse steht im Standortbereich dieser Seite.' },
    opening_hours: { q: 'Wann ist die Praxis geöffnet?', a: 'Die verifizierten Öffnungszeiten stehen im Bereich Öffnungszeiten dieser Seite.' },
    urgent_contact: { q: 'Was soll ich in einem dringenden Fall tun?', a: 'Nutzen Sie den auf dieser Seite angegebenen verifizierten Notfallkontakt. Diese Seite gibt keine medizinische Beratung.' },
    first_visit: { q: 'Wie kann ich einen ersten Termin vereinbaren?', a: 'Nutzen Sie die auf dieser Seite angegebene verifizierte Kontaktmöglichkeit.' },
    treatment_discovery: { q: 'Welche Behandlungen nennt die Praxis?', a: 'Die verifizierten Behandlungsbezeichnungen stehen im Behandlungsbereich dieser Seite.' },
    anxious_patient: { q: 'Ich habe Angst vor dem Zahnarztbesuch. Was kann ich tun?', a: 'Sie können dies erwähnen, wenn Sie die Praxis über die verifizierte Kontaktmöglichkeit auf dieser Seite kontaktieren.' },
    children_family: { q: 'Betreut die Praxis Kinder und Familien?', a: 'Die Familienbetreuung ist in den verifizierten Praxisinformationen auf dieser Seite beschrieben.' },
    supported_languages: { q: 'Welche Sprachen sind verfügbar?', a: 'Die verfügbaren Sprachen stehen in der Sprachauswahl dieser Seite.' },
    escalation: { q: 'Wie erreiche ich die Praxis direkt?', a: 'Nutzen Sie einen der verifizierten Kontaktwege auf dieser Seite.' },
  },
  fr: {
    booking: { q: 'Comment puis-je demander un rendez-vous ?', a: "Utilisez l'option de rendez-vous vérifiée indiquée sur cette page." },
    locations: { q: 'Où se trouve le cabinet ?', a: "L'adresse vérifiée figure dans la section adresse de cette page." },
    opening_hours: { q: "Quels sont les horaires d'ouverture ?", a: 'Les horaires vérifiés figurent dans la section horaires de cette page.' },
    urgent_contact: { q: "Que faire en cas d'urgence ?", a: "Utilisez le contact d'urgence vérifié indiqué sur cette page. Cette page ne fournit pas de conseil médical." },
    first_visit: { q: 'Comment organiser une première visite ?', a: 'Utilisez le moyen de contact vérifié indiqué sur cette page.' },
    treatment_discovery: { q: 'Quels soins le cabinet indique-t-il ?', a: 'Les noms de soins vérifiés figurent dans la section soins de cette page.' },
    anxious_patient: { q: "J'appréhende les soins dentaires. Que puis-je faire ?", a: 'Vous pouvez le mentionner en contactant le cabinet via le moyen de contact vérifié de cette page.' },
    children_family: { q: 'Le cabinet reçoit-il les enfants et les familles ?', a: 'La prise en charge des familles est décrite dans les informations vérifiées de cette page.' },
    supported_languages: { q: 'Quelles langues sont disponibles ?', a: 'Les langues disponibles figurent dans le sélecteur de langue de cette page.' },
    escalation: { q: 'Comment contacter directement le cabinet ?', a: "Utilisez l'un des moyens de contact vérifiés indiqués sur cette page." },
  },
  he: {
    booking: { q: 'איך אפשר לבקש תור?', a: 'יש להשתמש באפשרות קביעת התור המאומתת המופיעה בעמוד זה.' },
    locations: { q: 'היכן נמצאת המרפאה?', a: 'הכתובת המאומתת מופיעה באזור המיקום בעמוד זה.' },
    opening_hours: { q: 'מתי המרפאה פתוחה?', a: 'שעות הפתיחה המאומתות מופיעות באזור שעות הפתיחה בעמוד זה.' },
    urgent_contact: { q: 'מה לעשות במקרה דחוף?', a: 'יש להשתמש בפרטי הקשר הדחופים המאומתים המופיעים בעמוד זה. עמוד זה אינו מספק ייעוץ רפואי.' },
    first_visit: { q: 'איך אפשר לקבוע ביקור ראשון?', a: 'יש להשתמש בדרך יצירת הקשר המאומתת המופיעה בעמוד זה.' },
    treatment_discovery: { q: 'אילו טיפולים המרפאה מציינת?', a: 'שמות הטיפולים המאומתים מופיעים באזור הטיפולים בעמוד זה.' },
    anxious_patient: { q: 'אני חושש מטיפולי שיניים. מה אפשר לעשות?', a: 'אפשר לציין זאת בפנייה למרפאה דרך אמצעי הקשר המאומת בעמוד זה.' },
    children_family: { q: 'האם המרפאה מטפלת בילדים ובמשפחות?', a: 'הטיפול במשפחות מתואר במידע המאומת על המרפאה בעמוד זה.' },
    supported_languages: { q: 'אילו שפות זמינות?', a: 'השפות הזמינות מופיעות בבורר השפה בעמוד זה.' },
    escalation: { q: 'איך אפשר ליצור קשר ישיר עם המרפאה?', a: 'יש להשתמש באחד מאמצעי הקשר המאומתים המופיעים בעמוד זה.' },
  },
  ar: {
    booking: { q: 'كيف يمكنني طلب موعد؟', a: 'استخدم خيار الموعد الموثق المعروض في هذه الصفحة.' },
    locations: { q: 'أين تقع العيادة؟', a: 'العنوان الموثق معروض في قسم الموقع في هذه الصفحة.' },
    opening_hours: { q: 'ما هي ساعات عمل العيادة؟', a: 'ساعات العمل الموثقة معروضة في قسم ساعات العمل في هذه الصفحة.' },
    urgent_contact: { q: 'ماذا أفعل في حالة عاجلة؟', a: 'استخدم وسيلة الاتصال العاجل الموثقة المعروضة في هذه الصفحة. لا تقدم هذه الصفحة استشارة طبية.' },
    first_visit: { q: 'كيف يمكن ترتيب الزيارة الأولى؟', a: 'استخدم وسيلة الاتصال الموثقة المعروضة في هذه الصفحة.' },
    treatment_discovery: { q: 'ما العلاجات التي تذكرها العيادة؟', a: 'أسماء العلاجات الموثقة معروضة في قسم العلاجات في هذه الصفحة.' },
    anxious_patient: { q: 'أشعر بالقلق من علاج الأسنان. ماذا أفعل؟', a: 'يمكنك ذكر ذلك عند التواصل مع العيادة عبر وسيلة الاتصال الموثقة في هذه الصفحة.' },
    children_family: { q: 'هل تعالج العيادة الأطفال والعائلات؟', a: 'رعاية العائلات موضحة في معلومات العيادة الموثقة في هذه الصفحة.' },
    supported_languages: { q: 'ما اللغات المتاحة؟', a: 'اللغات المتاحة معروضة في مبدّل اللغة في هذه الصفحة.' },
    escalation: { q: 'كيف يمكن التواصل مباشرة مع العيادة؟', a: 'استخدم إحدى وسائل الاتصال الموثقة المعروضة في هذه الصفحة.' },
  },
};

/** Evidence keys that authorize each topic. A topic needs at least one present key. */
const TOPIC_EVIDENCE: Record<DemoV2FaqTopic, string[]> = {
  booking: ['fact.booking_url'],
  locations: ['fact.formatted_address', 'fact.official_location_page_url'],
  opening_hours: ['fact.opening_hours'],
  urgent_contact: ['claim.emergency_contact'],
  first_visit: ['fact.booking_url', 'fact.phone', 'fact.contact_email', 'fact.contact_form_url'],
  treatment_discovery: ['fact.services'],
  anxious_patient: ['claim.concern.anxiety'],
  children_family: ['claim.audience.family'],
  supported_languages: [],
  escalation: ['fact.phone', 'fact.contact_email', 'fact.whatsapp_url', 'fact.booking_url', 'fact.contact_form_url'],
};

function escalationFor(topic: DemoV2FaqTopic, present: ReadonlySet<string>): DemoV2FaqEscalationTarget {
  const phone = present.has('fact.phone');
  const email = present.has('fact.contact_email');
  const whatsapp = present.has('fact.whatsapp_url');
  const booking = present.has('fact.booking_url');
  const form = present.has('fact.contact_form_url');
  switch (topic) {
    case 'booking':
      return 'APPOINTMENT';
    case 'locations':
      return present.has('fact.official_location_page_url') ? 'LOCATION_PAGE' : 'NONE';
    case 'opening_hours':
    case 'treatment_discovery':
    case 'supported_languages':
      return 'NONE';
    case 'urgent_contact':
      return phone ? 'PHONE' : email ? 'EMAIL' : 'NONE';
    case 'first_visit':
      return booking ? 'APPOINTMENT' : phone ? 'PHONE' : email ? 'EMAIL' : 'CONTACT_FORM';
    case 'anxious_patient':
      return phone ? 'PHONE' : booking ? 'APPOINTMENT' : 'EMAIL';
    case 'children_family':
      return booking ? 'APPOINTMENT' : phone ? 'PHONE' : 'EMAIL';
    case 'escalation':
      return whatsapp ? 'WHATSAPP' : phone ? 'PHONE' : email ? 'EMAIL' : booking ? 'APPOINTMENT' : form ? 'CONTACT_FORM' : 'NONE';
  }
}

export interface BuildFaqPackageInput {
  intelligence: ClinicIntelligenceData;
  language: 'de' | 'en' | 'fr' | 'he' | 'ar';
}

/**
 * Build the deterministic FAQ package. Topics without supporting verified evidence are omitted —
 * never filled in with plausible defaults.
 */
export function buildFaqPackage(input: BuildFaqPackageInput): DemoV2FaqPackage {
  const evidence: DemoV2SourceRecord[] = input.intelligence.availableEvidence;
  const byKey = new Map<string, DemoV2SourceRecord[]>();
  for (const record of evidence) {
    byKey.set(record.key, [...(byKey.get(record.key) ?? []), record]);
  }
  const present = new Set(byKey.keys());
  const text = FAQ_TEXT[input.language];
  const entries: DemoV2FaqEntry[] = [];
  const omittedTopics: DemoV2FaqTopic[] = [];

  for (const topic of FAQ_TOPICS) {
    const supporting: DemoV2SourceRecord[] = topic === 'supported_languages'
      // Bound to the exact language-signal evidence, and only when a second language really exists.
      ? (input.intelligence.languageDecision.supportedLanguages.length > 1
        ? evidence.filter((record) => input.intelligence.languageDecision.signalSourceIds.includes(record.id))
        : [])
      : TOPIC_EVIDENCE[topic].flatMap((key) => byKey.get(key) ?? []);

    if (supporting.length === 0) {
      omittedTopics.push(topic);
      continue;
    }
    const sorted = [...supporting].sort((a, b) => a.id.localeCompare(b.id));
    const supportingSourceIds = sorted.map((record) => record.id);
    const supportingSourceHashes = sorted.map((record) => record.recordHash);
    const escalationTarget = escalationFor(topic, present);
    const base = {
      topic,
      questionKey: `faq.${topic}.question`,
      answerKey: `faq.${topic}.answer`,
      question: text[topic].q,
      answer: text[topic].a,
      supportingSourceIds,
      supportingSourceHashes,
      escalationTarget,
    };
    entries.push(faqEntrySchema.parse({ ...base, entryHash: demoV2Hash(base) }));
  }

  return faqPackageSchema.parse({
    language: input.language,
    direction: expectedDirection(input.language),
    entries,
    suggestedQuestionKeys: entries.map((entry) => entry.questionKey),
    omittedTopics,
    packageHash: demoV2Hash(entries.map((entry) => entry.entryHash)),
  });
}

/**
 * Map a primary-language FAQ question/answer to its prepared English equivalent. FAQ strings are
 * vetted, non-personalized concierge text, so the English record is a lookup rather than generated
 * prose — a verified fact can never be altered by this path.
 */
export function englishFaqEquivalent(
  language: 'de' | 'en' | 'fr' | 'he' | 'ar',
  text: string,
): string | null {
  const table = FAQ_TEXT[language];
  for (const topic of FAQ_TOPICS) {
    if (table[topic].q === text) return FAQ_TEXT.en[topic].q;
    if (table[topic].a === text) return FAQ_TEXT.en[topic].a;
  }
  return null;
}

export const DEMO_V2_FAQ_RULES_VERSION = 'demo-v2-faq-1';
