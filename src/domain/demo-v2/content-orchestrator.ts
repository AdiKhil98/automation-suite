import { randomUUID } from 'node:crypto';
import {
  contentItemSchema,
  primaryContentPackageSchema,
  type PrimaryContentPackage,
} from './content-package.js';
import { buildFaqPackage, englishFaqEquivalent, type DemoV2FaqPackage } from './faq-package.js';
import { demoV2Hash } from './hash.js';
import { type ClinicIntelligenceData } from './orchestration-types.js';
import {
  translationPackageSchema,
  type TranslationPackage,
} from './translation-package.js';

type Language = 'de' | 'en' | 'fr' | 'he' | 'ar';
type ClaimClass = 'VERBATIM_FACT' | 'EVIDENCE_BOUND_DERIVATION' | 'UI_LABEL' | 'LEGAL_DISCLOSURE';
type ContentKind = 'LABEL' | 'NAV_LABEL' | 'HEADING' | 'BODY' | 'CTA_LABEL' | 'SERVICE_NAME'
  | 'FAQ_QUESTION' | 'FAQ_ANSWER' | 'ALT_TEXT' | 'CONTACT' | 'HOURS' | 'LEGAL' | 'STRUCTURED';

const UI: Record<Language, Record<string, string>> = {
  en: {
    navTreatments: 'Treatments', navClinic: 'Clinic', navTeam: 'Team', navContact: 'Contact',
    heroEyebrow: 'Your visit, clearly explained', appointment: 'Request an appointment',
    hours: 'Opening hours', location: 'Location', contact: 'Contact', faq: 'Common questions',
    disclosure: 'Concept website for review. Information must be confirmed by the clinic before publication.',
    footer: 'Clinic information and legal details',
  },
  de: {
    navTreatments: 'Behandlungen', navClinic: 'Praxis', navTeam: 'Team', navContact: 'Kontakt',
    heroEyebrow: 'Ihr Besuch, klar erklärt', appointment: 'Termin anfragen',
    hours: 'Öffnungszeiten', location: 'Standort', contact: 'Kontakt', faq: 'Häufige Fragen',
    disclosure: 'Konzeptwebsite zur Prüfung. Angaben müssen vor einer Veröffentlichung von der Praxis bestätigt werden.',
    footer: 'Praxisinformationen und rechtliche Hinweise',
  },
  fr: {
    navTreatments: 'Soins', navClinic: 'Cabinet', navTeam: 'Équipe', navContact: 'Contact',
    heroEyebrow: 'Votre visite, expliquée clairement', appointment: 'Demander un rendez-vous',
    hours: "Horaires d'ouverture", location: 'Adresse', contact: 'Contact', faq: 'Questions fréquentes',
    disclosure: 'Site conceptuel à vérifier. Les informations doivent être confirmées par le cabinet avant publication.',
    footer: 'Informations du cabinet et mentions légales',
  },
  he: {
    navTreatments: 'טיפולים', navClinic: 'המרפאה', navTeam: 'צוות', navContact: 'יצירת קשר',
    heroEyebrow: 'הביקור שלך, מוסבר בבירור', appointment: 'בקשת תור',
    hours: 'שעות פתיחה', location: 'מיקום', contact: 'יצירת קשר', faq: 'שאלות נפוצות',
    disclosure: 'אתר קונספט לבדיקה. יש לאשר את המידע מול המרפאה לפני פרסום.',
    footer: 'פרטי המרפאה ומידע משפטי',
  },
  ar: {
    navTreatments: 'العلاجات', navClinic: 'العيادة', navTeam: 'الفريق', navContact: 'اتصل بنا',
    heroEyebrow: 'زيارتك موضحة بوضوح', appointment: 'طلب موعد',
    hours: 'ساعات العمل', location: 'الموقع', contact: 'اتصل بنا', faq: 'أسئلة شائعة',
    disclosure: 'موقع تصوري للمراجعة. يجب أن تؤكد العيادة المعلومات قبل النشر.',
    footer: 'معلومات العيادة والتفاصيل القانونية',
  },
};

export interface BuiltPrimaryContent {
  package: PrimaryContentPackage;
  bindings: Array<{ contentItemId: string; sourceIds: string[]; relationship: 'SUPPORTS' | 'SOURCE_TEXT' }>;
  faq: DemoV2FaqPackage;
}

export function buildPrimaryContent(input: {
  id: string;
  artifactId: string;
  intelligencePackageId: string;
  intelligenceHash: string;
  intelligence: ClinicIntelligenceData;
  version: number;
}): BuiltPrimaryContent {
  const language = input.intelligence.languageDecision.primaryLanguage;
  const direction = input.intelligence.languageDecision.primaryDirection;
  const labels = UI[language];
  const items: PrimaryContentPackage['items'] = [];
  const bindings: BuiltPrimaryContent['bindings'] = [];

  const add = (
    key: string,
    kind: ContentKind,
    claimClass: ClaimClass,
    textValue: string,
    sourceIds: string[] = [],
    translatable = true,
  ): void => {
    if (!textValue.trim()) return;
    if ((claimClass === 'VERBATIM_FACT' || claimClass === 'EVIDENCE_BOUND_DERIVATION') && sourceIds.length === 0) {
      throw new Error(`demo_v2_personalized_content_missing_evidence:${key}`);
    }
    const id = `${input.id}:${key}`;
    const item = contentItemSchema.parse({
      id,
      contentKey: key,
      contentKind: kind,
      claimClass,
      textValue,
      structuredValue: null,
      translatable,
      position: items.length,
      itemHash: demoV2Hash({ key, kind, claimClass, textValue, sourceIds, translatable }),
    });
    items.push(item);
    if (sourceIds.length > 0) bindings.push({
      contentItemId: id,
      sourceIds: [...new Set(sourceIds)].sort(),
      relationship: claimClass === 'VERBATIM_FACT' ? 'SOURCE_TEXT' : 'SUPPORTS',
    });
  };

  /** Machine-readable payload (chatbot prompts, escalation routing). Never translated: it carries
   * stable keys, not display prose. */
  const addStructured = (key: string, structured: Record<string, unknown>): void => {
    const id = `${input.id}:${key}`;
    items.push(contentItemSchema.parse({
      id,
      contentKey: key,
      contentKind: 'STRUCTURED',
      claimClass: 'UI_LABEL',
      textValue: null,
      structuredValue: structured,
      translatable: false,
      position: items.length,
      itemHash: demoV2Hash({ key, structured }),
    }));
  };

  const first = (category: keyof ClinicIntelligenceData) => {
    const value = input.intelligence[category];
    return Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'value' in value[0]
      ? value[0] as { value: string; sourceIds: string[] }
      : null;
  };

  add('navigation.treatments', 'NAV_LABEL', 'UI_LABEL', labels.navTreatments);
  add('navigation.clinic', 'NAV_LABEL', 'UI_LABEL', labels.navClinic);
  add('navigation.team', 'NAV_LABEL', 'UI_LABEL', labels.navTeam);
  add('navigation.contact', 'NAV_LABEL', 'UI_LABEL', labels.navContact);
  add('hero.eyebrow', 'LABEL', 'UI_LABEL', labels.heroEyebrow);
  const business = first('businessIdentity');
  if (business) add('hero.heading', 'HEADING', 'VERBATIM_FACT', business.value, business.sourceIds);

  for (const [index, service] of input.intelligence.services.entries()) {
    add(`treatments.${String(index)}.label`, 'SERVICE_NAME', 'VERBATIM_FACT', service.value, service.sourceIds);
  }
  for (const [index, strength] of input.intelligence.websiteStrengths.entries()) {
    add(`trust.${String(index)}.text`, 'BODY', 'EVIDENCE_BOUND_DERIVATION', strength.value, strength.sourceIds);
  }
  for (const [index, team] of input.intelligence.teamMembers.entries()) {
    add(`team.${String(index)}.text`, 'BODY', team.classification === 'DIRECT_FACT' ? 'VERBATIM_FACT' : 'EVIDENCE_BOUND_DERIVATION', team.value, team.sourceIds);
  }

  const appointment = first('appointmentMethods') ?? first('contactChannels');
  if (appointment) {
    add('appointment.heading', 'HEADING', 'UI_LABEL', labels.appointment);
    add('appointment.verified_method', 'CONTACT', 'VERBATIM_FACT', appointment.value, appointment.sourceIds, false);
  }
  const hours = first('openingHours');
  if (hours) {
    add('hours.heading', 'HEADING', 'UI_LABEL', labels.hours);
    add('hours.value', 'HOURS', 'VERBATIM_FACT', hours.value, hours.sourceIds);
  }
  const location = first('locations');
  if (location) {
    add('location.heading', 'HEADING', 'UI_LABEL', labels.location);
    add('location.value', 'CONTACT', 'VERBATIM_FACT', location.value, location.sourceIds);
  }
  const contact = first('contactChannels');
  if (contact) {
    add('contact.heading', 'HEADING', 'UI_LABEL', labels.contact);
    add('contact.value', 'CONTACT', 'VERBATIM_FACT', contact.value, contact.sourceIds, false);
  }
  // Deterministic FAQ concierge: only evidence-supported topics appear, each bound to the exact
  // sources that authorized it. Unsupported topics are omitted, never invented.
  const faq = buildFaqPackage({ intelligence: input.intelligence, language });
  if (faq.entries.length > 0) {
    add('faq.heading', 'HEADING', 'UI_LABEL', labels.faq);
    for (const entry of faq.entries) {
      add(entry.questionKey, 'FAQ_QUESTION', 'UI_LABEL', entry.question);
      add(entry.answerKey, 'FAQ_ANSWER', 'EVIDENCE_BOUND_DERIVATION', entry.answer, entry.supportingSourceIds);
    }
    addStructured('faq.suggested_questions', {
      questionKeys: faq.suggestedQuestionKeys,
      escalationTargets: Object.fromEntries(faq.entries.map((entry) => [entry.topic, entry.escalationTarget])),
      packageHash: faq.packageHash,
    });
  }
  add('disclosure.text', 'LEGAL', 'LEGAL_DISCLOSURE', labels.disclosure);
  add('footer.label', 'LEGAL', 'LEGAL_DISCLOSURE', labels.footer);

  const sourceFingerprint = demoV2Hash({
    intelligenceHash: input.intelligenceHash,
    bindings,
    schema: DEMO_V2_CONTENT_RULES_VERSION,
  });
  const contentHash = demoV2Hash(items);
  const pkg = primaryContentPackageSchema.parse({
    id: input.id,
    artifactId: input.artifactId,
    clinicIntelligencePackageId: input.intelligencePackageId,
    clinicIntelligenceHash: input.intelligenceHash,
    version: input.version,
    schemaVersion: DEMO_V2_CONTENT_RULES_VERSION,
    language,
    direction,
    status: items.length >= 8 && business ? 'READY' : 'REJECTED',
    sourceFingerprint,
    contentHash,
    items,
  });
  return { package: pkg, bindings, faq };
}

export interface DemoV2TranslationProvider {
  readonly name: 'mock';
  translate(primary: PrimaryContentPackage, targetLanguage: 'en'): Promise<Array<{
    sourceContentItemId: string;
    translatedText: string | null;
    translatedStructuredValue: Record<string, unknown> | null;
  }>>;
}

/** Zero-network translation preparation. It never grants human review approval. */
export class MockDemoV2TranslationProvider implements DemoV2TranslationProvider {
  readonly name = 'mock' as const;
  async translate(primary: PrimaryContentPackage): Promise<Array<{
    sourceContentItemId: string;
    translatedText: string | null;
    translatedStructuredValue: Record<string, unknown> | null;
  }>> {
    return primary.items.filter((item) => item.translatable).map((item) => {
      const known = Object.entries(UI[primary.language]).find(([, value]) => value === item.textValue)?.[0];
      const factualTranslations: Record<string, string> = {
        Implantologie: 'Implant dentistry',
        Prophylaxe: 'Preventive care',
        'Soins préventifs': 'Preventive care',
        'רפואת שיניים משמרת': 'Preventive dentistry',
        שתלים: 'Dental implants',
        'طب الأسنان الوقائي': 'Preventive dentistry',
        'زراعة الأسنان': 'Dental implants',
      };
      // Vetted UI and FAQ concierge strings resolve to their prepared English wording; verified
      // facts pass through unchanged (only known service names have a vetted English name).
      const faqEnglish = item.textValue ? englishFaqEquivalent(primary.language, item.textValue) : null;
      const translatedText = known
        ? UI.en[known]!
        : faqEnglish
          ?? (item.contentKind === 'SERVICE_NAME' && item.textValue
            ? item.textValue.split('|').map((value) => factualTranslations[value] ?? value).join('|')
            : item.textValue);
      return {
        sourceContentItemId: item.id,
        translatedText,
        translatedStructuredValue: item.structuredValue,
      };
    });
  }
}

export async function prepareEnglishTranslation(input: {
  id?: string;
  artifactId: string;
  primary: PrimaryContentPackage;
  version: number;
  provider: DemoV2TranslationProvider;
}): Promise<TranslationPackage | null> {
  if (input.primary.language === 'en') return null;
  const output = await input.provider.translate(input.primary, 'en');
  const expected = input.primary.items.filter((item) => item.translatable);
  const outputById = new Map(output.map((record) => [record.sourceContentItemId, record]));
  const records = expected.map((item) => {
    const translated = outputById.get(item.id);
    if (!translated || (translated.translatedText === null) === (translated.translatedStructuredValue === null)) {
      return {
        sourceContentItemId: item.id,
        sourceItemHash: item.itemHash,
        translatedText: null,
        translatedStructuredValue: null,
        translationItemHash: null,
        status: 'MISSING' as const,
      };
    }
    const translationItemHash = demoV2Hash({
      sourceItemHash: item.itemHash,
      translatedText: translated.translatedText,
      translatedStructuredValue: translated.translatedStructuredValue,
    });
    return {
      sourceContentItemId: item.id,
      sourceItemHash: item.itemHash,
      translatedText: translated.translatedText,
      translatedStructuredValue: translated.translatedStructuredValue,
      translationItemHash,
      status: 'TRANSLATED' as const,
    };
  });
  const complete = records.every((record) => record.status === 'TRANSLATED');
  const translation = translationPackageSchema.parse({
    id: input.id ?? randomUUID(),
    artifactId: input.artifactId,
    sourceContentPackageId: input.primary.id,
    version: input.version,
    language: 'en',
    direction: 'LTR',
    status: complete ? 'READY_FOR_REVIEW' : 'INCOMPLETE',
    sourceContentHash: input.primary.contentHash,
    sourceFingerprint: demoV2Hash({
      sourceContentHash: input.primary.contentHash,
      sourceItems: expected.map((item) => ({ id: item.id, hash: item.itemHash })),
    }),
    translationHash: complete ? demoV2Hash(records) : null,
    reviewStatus: 'NOT_REVIEWED',
    reviewActorType: null,
    reviewActorId: null,
    records,
  });
  assertTranslationPreservesClaims(input.primary, translation);
  return translation;
}

export function assertTranslationPreservesClaims(
  primary: PrimaryContentPackage,
  translation: TranslationPackage,
): void {
  const expected = primary.items.filter((item) => item.translatable);
  if (translation.records.length !== expected.length) throw new Error('demo_v2_translation_partial');
  for (const source of expected) {
    const record = translation.records.find((item) => item.sourceContentItemId === source.id);
    if (!record || record.sourceItemHash !== source.itemHash || record.status === 'MISSING') {
      throw new Error(`demo_v2_translation_source_mismatch:${source.id}`);
    }
    if (/https?:\/\//i.test(record.translatedText ?? '') && !/https?:\/\//i.test(source.textValue ?? '')) {
      throw new Error(`demo_v2_translation_introduced_url:${source.id}`);
    }
    if (/https?:\/\//i.test(source.textValue ?? '') && record.translatedText !== source.textValue) {
      throw new Error(`demo_v2_translation_changed_url:${source.id}`);
    }
    if (source.structuredValue
      && demoV2Hash(record.translatedStructuredValue) !== demoV2Hash(source.structuredValue)) {
      throw new Error(`demo_v2_translation_changed_structured_fact:${source.id}`);
    }
    if (source.contentKind === 'SERVICE_NAME') {
      const sourceCount = (source.textValue ?? '').split('|').length;
      const translatedParts = (record.translatedText ?? '').split('|').filter((value) => value.trim() !== '');
      if (translatedParts.length !== sourceCount) {
        throw new Error(`demo_v2_translation_changed_service_set:${source.id}`);
      }
    }
  }
}

export const DEMO_V2_CONTENT_RULES_VERSION = 'demo-v2-content-1';
