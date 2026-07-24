import { createHash } from 'node:crypto';
import { telHref, mailtoHref, sanitizeUrl } from '../../demo/sanitize.js';
import { expectedDirection } from '../clinic-intelligence.js';
import { demoV2Hash } from '../hash.js';
import { type PrimaryContentPackage } from '../content-package.js';
import { type TranslationPackage } from '../translation-package.js';
import { type DemoV2FaqPackage } from '../faq-package.js';
import { type DemoV2AssetCandidate, type DemoV2AssetSelectionProposal } from '../orchestration-types.js';
import { componentSpecsHash, requireComponent, type ComponentSpec } from './components.js';
import { compositionFor } from './design-system.js';
import { buildStylesheet } from './stylesheet.js';
import { buildTypographyCss, typographyHash } from './typography.js';
import { buildRuntimeScript } from './runtime.js';
import {
  renderDocument, renderFictionalBaseline,
  type RenderAsset, type RenderModel, type RenderSection,
} from './render-html.js';

export const DEMO_V2_RENDERER_VERSION = 'demo-v2-renderer-1';

type Language = 'de' | 'en' | 'fr' | 'he' | 'ar';

/** Maps an ExperiencePlan component family onto a concrete component, honouring family variants. */
export function resolveComponentId(componentFamily: string, referenceFamily: string): string {
  const composition = compositionFor(referenceFamily);
  const map: Record<string, string> = {
    disclosure: 'ConceptDisclosureBar',
    navigation: 'PremiumEditorialNavigation',
    'language-switcher': 'PremiumEditorialNavigation',
    'image-led hero': composition.heroVariant,
    'appointment-actions': 'AppointmentActionDock',
    'trust strip': composition.trustVariant,
    'editorial treatment discovery': composition.treatmentVariant,
    'team and specialist presentation': composition.peopleVariant,
    'architecture or interior gallery': composition.placeVariant,
    // Distinct sections: the story is narrative, the journey is the verified contact path.
    'clinic story': 'CalmCareStory',
    'patient journey': 'PatientJourneySteps',
    'anxious patient support': 'AnxiousPatientSection',
    'location and opening hours': 'LocationHoursPanel',
    'deterministic FAQ concierge': 'DeterministicFaqConcierge',
    'final CTA': 'FinalAppointmentCta',
    footer: 'PremiumClinicFooter',
  };
  const resolved = map[componentFamily];
  if (!resolved) throw new Error(`demo_v2_render_unsupported_component_family:${componentFamily}`);
  return resolved;
}

const ANCHORS: Record<string, string> = {
  ConceptDisclosureBar: 'disclosure', PremiumEditorialNavigation: 'nav',
  ArchitectureImageHero: 'hero', EditorialSplitHero: 'hero', CalmCareHero: 'hero', LocationLedHero: 'hero',
  AppointmentActionDock: 'appointment',
  SpecialistTrustStrip: 'trust', VerifiedHoursStrip: 'trust', LocationProofStrip: 'trust',
  EditorialTreatmentIndex: 'treatments', GroupedTreatmentDiscovery: 'treatments', TreatmentSpotlight: 'treatments',
  SpecialistPortraitRail: 'team', TeamEditorialGrid: 'team', DoctorFeature: 'team',
  ArchitectureStory: 'place', InteriorGallery: 'place', LocationNarrative: 'place',
  PatientJourneySteps: 'journey', CalmCareStory: 'journey', AnxiousPatientSection: 'anxious',
  LocationHoursPanel: 'information', ContactPanel: 'information', ContactChoicePanel: 'information',
  DeterministicFaqConcierge: 'concierge',
  FinalAppointmentCta: 'final-cta', ContactFallback: 'final-cta',
  PremiumClinicFooter: 'footer',
};

const LABELS: Record<Language, Record<string, string>> = {
  de: { skip: 'Zum Inhalt springen', menu: 'Menü', close: 'Schließen', appointment: 'Termin anfragen', contact: 'Kontakt', whatsapp: 'WhatsApp', location: 'Anfahrt', faq: 'Häufige Fragen', treatments: 'Behandlungen', team: 'Team', clinic: 'Praxis', journey: 'Ihr Weg zum Termin', story: 'Die Praxis', faqMore: 'Weitere {n} Fragen im Assistenten', verified: 'Verifiziert', primaryNav: 'Hauptnavigation', mobileNav: 'Mobile Navigation', languageGroup: 'Sprache', conciergeNote: 'Konzeptdemo. Antworten stammen ausschließlich aus verifizierten Angaben. Keine medizinische Beratung.' },
  en: { skip: 'Skip to content', menu: 'Menu', close: 'Close', appointment: 'Request an appointment', contact: 'Contact', whatsapp: 'WhatsApp', location: 'Directions', faq: 'Common questions', treatments: 'Treatments', team: 'Team', clinic: 'Clinic', journey: 'Your route to an appointment', story: 'The practice', faqMore: '{n} more questions in the assistant', verified: 'Verified', primaryNav: 'Primary navigation', mobileNav: 'Mobile navigation', languageGroup: 'Language', conciergeNote: 'Concept demo. Answers come only from verified information. This is not medical advice.' },
  fr: { skip: 'Aller au contenu', menu: 'Menu', close: 'Fermer', appointment: 'Demander un rendez-vous', contact: 'Contact', whatsapp: 'WhatsApp', location: 'Accès', faq: 'Questions fréquentes', treatments: 'Soins', team: 'Équipe', clinic: 'Cabinet', journey: 'Votre parcours vers un rendez-vous', story: 'Le cabinet', faqMore: '{n} autres questions dans l’assistant', verified: 'Vérifié', primaryNav: 'Navigation principale', mobileNav: 'Navigation mobile', languageGroup: 'Langue', conciergeNote: "Démo conceptuelle. Les réponses proviennent uniquement d'informations vérifiées. Ceci n'est pas un conseil médical." },
  he: { skip: 'דלג לתוכן', menu: 'תפריט', close: 'סגירה', appointment: 'בקשת תור', contact: 'יצירת קשר', whatsapp: 'וואטסאפ', location: 'הגעה', faq: 'שאלות נפוצות', treatments: 'טיפולים', team: 'צוות', clinic: 'המרפאה', journey: 'הדרך לקביעת תור', story: 'המרפאה שלנו', faqMore: 'עוד {n} שאלות בעוזר', verified: 'מאומת', primaryNav: 'ניווט ראשי', mobileNav: 'ניווט נייד', languageGroup: 'שפה', conciergeNote: 'הדגמת קונספט. התשובות מבוססות על מידע מאומת בלבד. אין זה ייעוץ רפואי.' },
  ar: { skip: 'تخطَّ إلى المحتوى', menu: 'القائمة', close: 'إغلاق', appointment: 'طلب موعد', contact: 'اتصل بنا', whatsapp: 'واتساب', location: 'الوصول', faq: 'أسئلة شائعة', treatments: 'العلاجات', team: 'الفريق', clinic: 'العيادة', journey: 'طريقك إلى الموعد', story: 'عن العيادة', faqMore: '{n} أسئلة أخرى في المساعد', verified: 'موثق', primaryNav: 'التنقل الرئيسي', mobileNav: 'تنقل الجوال', languageGroup: 'اللغة', conciergeNote: 'عرض تصوري. الإجابات مستمدة من معلومات موثقة فقط. هذه ليست استشارة طبية.' },
};

const LANGUAGE_LABEL: Record<Language, string> = { de: 'DE', en: 'EN', fr: 'FR', he: 'עב', ar: 'ع' };

export interface RenderAssetBinding {
  selection: DemoV2AssetSelectionProposal;
  asset: DemoV2AssetCandidate;
  /** Bytes of the approved fictional asset; hashed and written into the bundle. */
  bytes: Buffer;
  /** Explicit fictional reuse approval — an asset without it is refused. */
  reuseApproved: boolean;
}

export interface RenderInput {
  artifactId: string;
  referenceFamily: string;
  businessName: string;
  primary: PrimaryContentPackage;
  /** Only supplied when complete AND human-reviewed; otherwise the primary package renders alone. */
  translation: TranslationPackage | null;
  translationReviewed: boolean;
  faq: DemoV2FaqPackage;
  /** English FAQ rendering uses the translated question/answer records. */
  planSections: readonly { order: number; componentFamily: string }[];
  assets: readonly RenderAssetBinding[];
  intelligenceHash: string;
  creativeBriefHash: string;
  experiencePlanHash: string;
  componentRegistryVersion: string;
  componentRegistryHash: string;
  referenceLibraryVersion: string;
  referenceLibraryHash: string;
  /** Verified channel values used to derive hrefs. Never invented. */
  channels: {
    bookingUrl: string | null;
    phone: string | null;
    email: string | null;
    whatsappUrl: string | null;
    locationUrl: string | null;
  };
}

export interface RenderedFile {
  path: string;
  bytes: Buffer;
}

export interface RenderResult {
  renderHash: string;
  rendererVersion: string;
  files: readonly RenderedFile[];
  documents: readonly { language: string; path: string; html: string }[];
  /** Fictional "current site" baseline used only in the operator review package. */
  baselineHtml: string;
  supportedLanguages: readonly string[];
  primaryLanguage: string;
  sectionAnchors: readonly string[];
  usedAssetHashes: readonly string[];
  componentIds: readonly string[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function cspHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64');
}

function contentMapFor(
  primary: PrimaryContentPackage,
  translation: TranslationPackage | null,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of primary.items) {
    if (item.textValue === null) continue;
    if (!translation) {
      map[item.contentKey] = item.textValue;
      continue;
    }
    if (!item.translatable) {
      // Verified facts are intentionally identical in both packages.
      map[item.contentKey] = item.textValue;
      continue;
    }
    const record = translation.records.find((entry) => entry.sourceContentItemId === item.id);
    if (!record || record.status !== 'TRANSLATED' || record.translatedText === null) {
      throw new Error(`demo_v2_render_incomplete_translation:${item.contentKey}`);
    }
    if (record.sourceItemHash !== item.itemHash) {
      throw new Error(`demo_v2_render_stale_translation:${item.contentKey}`);
    }
    map[item.contentKey] = record.translatedText;
  }
  return map;
}

/**
 * Deterministic render. Fails closed on stale hashes, incomplete translations, unapproved assets,
 * unsupported components, and missing required content.
 */
export function renderDemoV2(input: RenderInput): RenderResult {
  const primaryLanguage = input.primary.language as Language;
  if (input.primary.status !== 'READY') throw new Error('demo_v2_render_content_not_ready');
  if (input.primary.direction !== expectedDirection(primaryLanguage)) {
    throw new Error('demo_v2_render_direction_mismatch');
  }

  // A secondary language is offered ONLY when complete, reviewed, and bound to this exact content.
  let translation: TranslationPackage | null = null;
  if (input.translation) {
    const t = input.translation;
    if (t.sourceContentHash !== input.primary.contentHash) {
      throw new Error('demo_v2_render_stale_translation_binding');
    }
    const complete = t.records.length > 0 && t.records.every((record) => record.status === 'TRANSLATED');
    const statusUsable = t.status === 'READY_FOR_REVIEW' || t.status === 'REVIEWED';
    // A missing, incomplete, or unreviewed secondary package renders the primary language ONLY —
    // never a partially translated or broken English option.
    if (input.translationReviewed && statusUsable && complete) translation = t;
  }

  // ---- assets: approved fictional selections only ----
  for (const binding of input.assets) {
    if (!binding.reuseApproved) throw new Error(`demo_v2_render_asset_not_reuse_approved:${binding.asset.id}`);
    if (binding.selection.boundAssetRecordHash !== binding.asset.recordHash) {
      throw new Error(`demo_v2_render_asset_binding_stale:${binding.asset.id}`);
    }
    if (sha256(binding.bytes) !== binding.asset.contentHash) {
      throw new Error(`demo_v2_render_asset_content_hash_mismatch:${binding.asset.id}`);
    }
    if (binding.asset.quality !== 'SUITABLE') {
      throw new Error(`demo_v2_render_asset_unsuitable:${binding.asset.id}`);
    }
    if (binding.asset.ownership !== 'FIRST_PARTY' && binding.asset.ownership !== 'APPROVED_FIRST_PARTY_CDN') {
      throw new Error(`demo_v2_render_asset_not_first_party:${binding.asset.id}`);
    }
  }

  const assetFiles: RenderedFile[] = [];
  const assetByCategory = new Map<string, RenderAsset[]>();
  const usedAssetHashes: string[] = [];
  for (const binding of [...input.assets].sort((a, b) => a.asset.id.localeCompare(b.asset.id))) {
    const path = `assets/${binding.asset.id}.png`;
    assetFiles.push({ path, bytes: binding.bytes });
    usedAssetHashes.push(binding.asset.contentHash);
    const rendered: RenderAsset = {
      id: binding.asset.id,
      category: binding.asset.category,
      href: path,
      alt: binding.asset.altText ?? binding.asset.nearbyCaption ?? binding.selection.intendedUse,
      width: binding.asset.width,
      height: binding.asset.height,
      focalX: binding.selection.focalPoint.x,
      focalY: binding.selection.focalPoint.y,
      contentHash: binding.asset.contentHash,
    };
    assetByCategory.set(rendered.category, [...(assetByCategory.get(rendered.category) ?? []), rendered]);
  }

  const composition = compositionFor(input.referenceFamily);
  const takeAssets = (spec: ComponentSpec, used: Set<string>): RenderAsset[] => {
    if (spec.maxAssets === 0) return [];
    const picked: RenderAsset[] = [];
    for (const category of spec.allowedAssetCategories) {
      for (const asset of assetByCategory.get(category) ?? []) {
        if (used.has(asset.id) || picked.length >= spec.maxAssets) continue;
        picked.push(asset);
        used.add(asset.id);
      }
      if (picked.length >= spec.maxAssets) break;
    }
    return picked;
  };

  // ---- sections ----
  const usedAssets = new Set<string>();
  const ordered = [...input.planSections].sort((a, b) => a.order - b.order);
  const sections: RenderSection[] = [];
  const takenAnchors = new Set<string>();
  let rhythmIndex = 0;
  for (const planned of ordered) {
    const componentId = resolveComponentId(planned.componentFamily, input.referenceFamily);
    const spec = requireComponent(componentId);
    const rhythm = composition.rhythm[rhythmIndex % composition.rhythm.length] ?? 'airy';
    rhythmIndex += 1;
    // Anchors must be unique even when a family maps two planned sections to one component.
    const base = ANCHORS[componentId] ?? `section-${String(planned.order)}`;
    let anchor = base;
    let suffix = 2;
    while (takenAnchors.has(anchor)) { anchor = `${base}-${String(suffix)}`; suffix += 1; }
    takenAnchors.add(anchor);
    sections.push({
      order: planned.order,
      componentId,
      contentKeys: [...spec.requiredContentKeys, ...spec.optionalContentKeys],
      assets: takeAssets(spec, usedAssets),
      rhythm,
      anchor,
    });
  }
  if (!sections.some((section) => section.componentId === 'ConceptDisclosureBar')) {
    throw new Error('demo_v2_render_missing_disclosure');
  }

  const css = buildStylesheet(input.referenceFamily);
  const script = buildRuntimeScript();
  const styleHash = cspHash(css);
  const scriptHash = cspHash(script);

  const languages: Language[] = translation ? [primaryLanguage, 'en'] : [primaryLanguage];
  const documents: { language: string; path: string; html: string }[] = [];
  let baselineHtml = '';

  for (const language of languages) {
    const isPrimary = language === primaryLanguage;
    const content = isPrimary
      ? contentMapFor(input.primary, null)
      : contentMapFor(input.primary, translation);
    const faqEntries = input.faq.entries.map((entry) => ({
      topic: entry.topic,
      question: content[entry.questionKey] ?? entry.question,
      answer: content[entry.answerKey] ?? entry.answer,
      escalationTarget: entry.escalationTarget,
    })).filter((entry) => content[`faq.${entry.topic}.question`] !== undefined);

    const alternateLanguage = languages.find((candidate) => candidate !== language) ?? null;
    const model: RenderModel = {
      language,
      direction: expectedDirection(language),
      referenceFamily: input.referenceFamily,
      businessName: input.businessName,
      content,
      faq: faqEntries,
      sections,
      alternate: alternateLanguage
        ? {
            language: alternateLanguage,
            href: alternateLanguage === primaryLanguage ? 'index.html' : `${alternateLanguage}.html`,
            label: LANGUAGE_LABEL[alternateLanguage],
          }
        : null,
      selfLanguageLabel: LANGUAGE_LABEL[language],
      labels: LABELS[language],
      appointmentHref: sanitizeUrl(input.channels.bookingUrl) ?? telHref(input.channels.phone),
      contactHref: telHref(input.channels.phone) ?? mailtoHref(input.channels.email),
      urgentHref: telHref(input.channels.phone),
      locationHref: sanitizeUrl(input.channels.locationUrl),
      whatsappHref: sanitizeUrl(input.channels.whatsappUrl),
      styleHash, scriptHash, css, script,
      typographyCss: buildTypographyCss(input.referenceFamily, language),
    };
    documents.push({
      language,
      path: isPrimary ? 'index.html' : `${language}.html`,
      html: renderDocument(model),
    });
    if (isPrimary) baselineHtml = renderFictionalBaseline(model);
  }

  const files: RenderedFile[] = [
    ...documents.map((document) => ({ path: document.path, bytes: Buffer.from(document.html, 'utf8') })),
    { path: 'baseline.html', bytes: Buffer.from(baselineHtml, 'utf8') },
    ...assetFiles,
  ].sort((a, b) => a.path.localeCompare(b.path));

  const renderHash = demoV2Hash({
    rendererVersion: DEMO_V2_RENDERER_VERSION,
    componentSpecsHash: componentSpecsHash(),
    typographyHash: typographyHash(),
    componentRegistryHash: input.componentRegistryHash,
    referenceLibraryHash: input.referenceLibraryHash,
    referenceFamily: input.referenceFamily,
    intelligenceHash: input.intelligenceHash,
    contentHash: input.primary.contentHash,
    translationHash: translation?.translationHash ?? null,
    creativeBriefHash: input.creativeBriefHash,
    experiencePlanHash: input.experiencePlanHash,
    assets: usedAssetHashes,
    files: files.map((file) => ({ path: file.path, hash: sha256(file.bytes) })),
  });

  return {
    renderHash,
    rendererVersion: DEMO_V2_RENDERER_VERSION,
    files,
    documents,
    baselineHtml,
    supportedLanguages: languages,
    primaryLanguage,
    sectionAnchors: sections.map((section) => section.anchor),
    usedAssetHashes,
    componentIds: sections.map((section) => section.componentId),
  };
}
