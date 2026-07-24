import { orchestrateDemoV2Fixture, type DemoV2FixtureInput } from '../domain/demo-v2/orchestration-service.js';
import { type RenderAssetBinding, type RenderInput } from '../domain/demo-v2/render/renderer.js';
import { fictionalClinicImages, ACCEPTANCE_PLAN_SECTIONS, type AcceptanceFixture } from './demo-v2-render-fixture.js';

/**
 * Complete acceptance fixtures for French, Hebrew, and Arabic (plus the German baseline via the
 * dedicated fixture). Everything is fictional `.example` data; imagery is the language-neutral
 * local pack. Each fixture ships a complete, human-reviewed English secondary package so the
 * language switcher renders; the renderer still falls back to primary-only if it is withheld.
 */

export type AcceptanceLanguage = 'fr' | 'he' | 'ar';

interface LangData {
  domain: string;
  country: string;
  business: string;
  address: string;
  hours: string;
  services: string;
  positioning: string;
  concern: string;
  anxiety: string;
  family: string;
  emergency: string;
  atmosphere: string;
  strengthAppt: string;
  strengthTransparency: string;
  team: string;
  captureText: string;
  /** English equivalents so the prepared English package is complete (mock translation glossary). */
  glossary: Record<string, string>;
}

const LANG: Record<AcceptanceLanguage, LangData> = {
  fr: {
    domain: 'clinique-lumiere.example', country: 'France', business: 'Clinique dentaire Lumière',
    address: '12 rue des Tilleuls, 75011 Ville-Exemple, France',
    hours: 'Du lundi au vendredi de 08h00 à 18h00, samedi sur rendez-vous',
    services: 'Implantologie|Soins préventifs|Parodontologie|Dentisterie esthétique',
    positioning: 'Cabinet calme avec une architecture vérifiée et un accompagnement personnalisé.',
    concern: 'Les patientes et patients souhaitent une orientation pratique claire avant de demander un rendez-vous.',
    anxiety: 'De nombreux patients expriment une appréhension avant un rendez-vous dentaire.',
    family: 'Le cabinet décrit la prise en charge des enfants et des familles.',
    emergency: 'Les demandes urgentes sont prises via le numéro de téléphone vérifié.',
    atmosphere: 'Les photographies vérifiées montrent des espaces clairs et apaisants.',
    strengthAppt: 'La demande de rendez-vous est documentée de façon vérifiée sur le site existant.',
    strengthTransparency: 'Les horaires, l’adresse et le contact sont entièrement vérifiés.',
    team: 'Dr. Exemple, chirurgien-dentiste', captureText: 'Le cabinet et le rendez-vous sont expliqués pour les patients.',
    glossary: {
      'Cabinet calme avec une architecture vérifiée et un accompagnement personnalisé.': 'A calm practice with verified architecture and personal care.',
      'Les photographies vérifiées montrent des espaces clairs et apaisants.': 'The verified photographs show bright, calm spaces.',
      'La demande de rendez-vous est documentée de façon vérifiée sur le site existant.': 'The appointment request is verifiably documented on the existing site.',
      'Les horaires, l’adresse et le contact sont entièrement vérifiés.': 'Opening hours, address and contact details are fully verified.',
      'Dr. Exemple, chirurgien-dentiste': 'Dr. Exemple, dental surgeon',
      'Du lundi au vendredi de 08h00 à 18h00, samedi sur rendez-vous': 'Monday to Friday 08:00-18:00, Saturday by arrangement',
      '12 rue des Tilleuls, 75011 Ville-Exemple, France': '12 Tilleuls Street, 75011 Ville-Exemple, France',
      'Implantologie|Soins préventifs|Parodontologie|Dentisterie esthétique': 'Implant dentistry|Preventive care|Periodontology|Aesthetic dentistry',
    },
  },
  he: {
    domain: 'clinic-or.example', country: 'Israel', business: 'מרפאת שיניים אור',
    address: 'רחוב הברושים 12, עיר לדוגמה, ישראל',
    hours: 'ראשון עד חמישי 08:00-18:00, שישי בתיאום מראש',
    services: 'שתלים|רפואה מונעת|פריודונטיה|רפואת שיניים אסתטית',
    positioning: 'מרפאה רגועה עם אדריכלות מאומתת וליווי אישי.',
    concern: 'מטופלות ומטופלים מבקשים התמצאות מעשית ברורה לפני בקשת תור.',
    anxiety: 'מטופלים רבים מדווחים על מתח לפני ביקור אצל רופא השיניים.',
    family: 'המרפאה מתארת טיפול בילדים ובמשפחות.',
    emergency: 'פניות דחופות מטופלות דרך מספר הטלפון המאומת.',
    atmosphere: 'הצילומים המאומתים מציגים חללים בהירים ורגועים.',
    strengthAppt: 'בקשת התור מתועדת באופן מאומת באתר הקיים.',
    strengthTransparency: 'שעות הפתיחה, הכתובת והקשר מאומתים במלואם.',
    team: 'ד"ר דוגמה, רופאת שיניים', captureText: 'המרפאה והתור מוסברים עבור המטופלים.',
    glossary: {
      'מרפאה רגועה עם אדריכלות מאומתת וליווי אישי.': 'A calm clinic with verified architecture and personal care.',
      'הצילומים המאומתים מציגים חללים בהירים ורגועים.': 'The verified photographs show bright, calm spaces.',
      'בקשת התור מתועדת באופן מאומת באתר הקיים.': 'The appointment request is verifiably documented on the existing site.',
      'שעות הפתיחה, הכתובת והקשר מאומתים במלואם.': 'Opening hours, address and contact details are fully verified.',
      'ד"ר דוגמה, רופאת שיניים': 'Dr. Dugma, dentist',
      'ראשון עד חמישי 08:00-18:00, שישי בתיאום מראש': 'Sunday to Thursday 08:00-18:00, Friday by arrangement',
      'רחוב הברושים 12, עיר לדוגמה, ישראל': '12 Cypress Street, Example City, Israel',
      'שתלים|רפואה מונעת|פריודונטיה|רפואת שיניים אסתטית': 'Dental implants|Preventive care|Periodontology|Aesthetic dentistry',
    },
  },
  ar: {
    domain: 'clinic-noor.example', country: 'Israel', business: 'عيادة نور لطب الأسنان',
    address: 'شارع السرو 12، مدينة نموذجية، إسرائيل',
    hours: 'من الأحد إلى الخميس 08:00-18:00، الجمعة بموعد مسبق',
    services: 'زراعة الأسنان|الطب الوقائي|أمراض اللثة|طب الأسنان التجميلي',
    positioning: 'عيادة هادئة بعمارة موثقة ورعاية شخصية.',
    concern: 'يرغب المرضى في توجيه عملي واضح قبل طلب الموعد.',
    anxiety: 'يذكر كثير من المرضى شعورهم بالقلق قبل موعد الأسنان.',
    family: 'تصف العيادة رعاية الأطفال والعائلات.',
    emergency: 'تُستقبل الطلبات العاجلة عبر رقم الهاتف الموثق.',
    atmosphere: 'تُظهر الصور الموثقة مساحات مضيئة وهادئة.',
    strengthAppt: 'طلب الموعد موثق بشكل مؤكد على الموقع الحالي.',
    strengthTransparency: 'ساعات العمل والعنوان ووسيلة الاتصال موثقة بالكامل.',
    team: 'د. مثال، طبيب أسنان', captureText: 'تُشرح العيادة والموعد للمرضى.',
    glossary: {
      'عيادة هادئة بعمارة موثقة ورعاية شخصية.': 'A calm clinic with verified architecture and personal care.',
      'تُظهر الصور الموثقة مساحات مضيئة وهادئة.': 'The verified photographs show bright, calm spaces.',
      'طلب الموعد موثق بشكل مؤكد على الموقع الحالي.': 'The appointment request is verifiably documented on the existing site.',
      'ساعات العمل والعنوان ووسيلة الاتصال موثقة بالكامل.': 'Opening hours, address and contact details are fully verified.',
      'د. مثال، طبيب أسنان': 'Dr. Mithal, dentist',
      'من الأحد إلى الخميس 08:00-18:00، الجمعة بموعد مسبق': 'Sunday to Thursday 08:00-18:00, Friday by arrangement',
      'شارع السرو 12، مدينة نموذجية، إسرائيل': '12 Cypress Street, Example City, Israel',
      'زراعة الأسنان|الطب الوقائي|أمراض اللثة|طب الأسنان التجميلي': 'Dental implants|Preventive care|Periodontology|Aesthetic dentistry',
    },
  },
};

function fixtureInput(language: AcceptanceLanguage, manifests: {
  componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string;
}): DemoV2FixtureInput {
  const data = LANG[language];
  const base = `https://${data.domain}`;
  const images = fictionalClinicImages();
  const capturedAt = '2026-07-20T10:00:00.000Z';
  const source = (
    id: string,
    kind: 'LEAD_FACT' | 'AUDIT_FINDING' | 'CAPTURE_EVIDENCE',
    role: 'IDENTITY' | 'CONTENT' | 'AUDIT' | 'LANGUAGE' | 'ASSET_CONTEXT' | 'CONTACT' | 'CLAIM',
    key: string,
    value: string,
    direct = true,
  ) => ({ id: `${language}-${id}`, kind, role, key, value, capturedAt, direct, accepted: true });

  return {
    fixtureId: `acceptance-${language}`,
    sources: [
      source('business', 'LEAD_FACT', 'IDENTITY', 'fact.business_name', data.business),
      source('website', 'LEAD_FACT', 'IDENTITY', 'fact.official_website_url', base),
      source('domain', 'LEAD_FACT', 'IDENTITY', 'fact.official_domain', data.domain),
      source('country', 'LEAD_FACT', 'IDENTITY', 'fact.country', data.country),
      source('address', 'LEAD_FACT', 'CONTACT', 'fact.formatted_address', data.address),
      source('phone', 'LEAD_FACT', 'CONTACT', 'fact.phone', '+49 30 555 0100'),
      source('email', 'LEAD_FACT', 'CONTACT', 'fact.contact_email', `praxis@${data.domain}`),
      source('booking', 'LEAD_FACT', 'CONTACT', 'fact.booking_url', `${base}/appointment`),
      source('hours', 'LEAD_FACT', 'CONTENT', 'fact.opening_hours', data.hours),
      source('services', 'LEAD_FACT', 'CONTENT', 'fact.services', data.services),
      source('lang', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.lang', language),
      source('text', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.text', data.captureText),
      source('finding', 'AUDIT_FINDING', 'AUDIT', 'audit.appointment_path', data.strengthAppt, false),
      source('positioning', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.positioning.primary', data.positioning, false),
      source('concern', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.concern.orientation', data.concern, false),
      source('anxiety', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.concern.anxiety', data.anxiety, false),
      source('family', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.audience.family', data.family, false),
      source('emergency', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.emergency_contact', data.emergency, false),
      source('atmosphere', 'CAPTURE_EVIDENCE', 'ASSET_CONTEXT', 'capture.atmosphere.interior', data.atmosphere, false),
      source('strength-appt', 'CAPTURE_EVIDENCE', 'CLAIM', 'capture.strength.appointment', data.strengthAppt, false),
      source('strength-transp', 'CAPTURE_EVIDENCE', 'CLAIM', 'capture.strength.transparency', data.strengthTransparency, false),
      source('team', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.team.verified', data.team, false),
    ],
    pages: [{
      id: `${language}-page-home`, url: base, captureEvidenceId: null,
      html: `<html lang="${language}"><body><main>`
        + `<section><h1>${data.business}</h1><img src="${images.interior.url}" alt="clinic interior"></section>`
        + `<section><img src="${images.architecture.url}" alt="clinic facade"></section>`
        + `<section><figure><img src="${images.doctor.url}" alt="verified clinician"><figcaption>team</figcaption></figure></section>`
        + `<section><img src="${images.team.url}" alt="clinic team"></section>`
        + `<section><img src="${images.location.url}" alt="clinic location standort"></section>`
        + `</main></body></html>`,
    }],
    officialWebsiteUrl: base, approvedCdnHosts: [],
    assetFetchResults: Object.fromEntries(Object.values(images).map((image) => [image.url, {
      finalUrl: image.url, redirectUrls: [] as string[], mimeType: 'image/png',
      bytes: image.bytes.length, width: image.width, height: image.height, contentHash: image.hash,
    }])),
    componentRegistry: { version: manifests.componentVersion, hash: manifests.componentHash },
    referenceLibrary: { version: manifests.referenceVersion, hash: manifests.referenceHash },
    now: '2026-07-24T10:00:00.000Z',
    translationGlossary: data.glossary,
  };
}

/** Build a complete render input for a non-German acceptance language. */
export async function buildLanguageAcceptanceFixture(
  language: AcceptanceLanguage,
  manifests: { componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string },
  options: { withEnglish?: boolean } = {},
): Promise<AcceptanceFixture> {
  const input = fixtureInput(language, manifests);
  const orchestration = await orchestrateDemoV2Fixture(input);
  const images = fictionalClinicImages();
  const bytesByHash = new Map<string, Buffer>(Object.values(images).map((image) => [image.hash, image.bytes]));
  const assets: RenderAssetBinding[] = orchestration.selections.map((selection) => {
    const asset = orchestration.assets.find((candidate) => candidate.id === selection.assetId)!;
    const bytes = bytesByHash.get(asset.contentHash);
    if (!bytes) throw new Error(`fixture_asset_bytes_missing:${asset.id}`);
    return { selection, asset, bytes, reuseApproved: true };
  });
  const base = `https://${LANG[language].domain}`;
  const renderInput: RenderInput = {
    artifactId: `artifact-acceptance-${language}`,
    referenceFamily: orchestration.report.referenceFamily,
    businessName: LANG[language].business,
    primary: orchestration.content.package,
    translation: orchestration.translation,
    translationReviewed: options.withEnglish ?? true,
    faq: orchestration.content.faq,
    planSections: ACCEPTANCE_PLAN_SECTIONS,
    assets,
    intelligenceHash: orchestration.intelligence.package.packageHash,
    creativeBriefHash: orchestration.creativeBrief.briefHash,
    experiencePlanHash: orchestration.experiencePlan.planHash,
    componentRegistryVersion: manifests.componentVersion,
    componentRegistryHash: manifests.componentHash,
    referenceLibraryVersion: manifests.referenceVersion,
    referenceLibraryHash: manifests.referenceHash,
    channels: {
      bookingUrl: `${base}/appointment`, phone: '+49 30 555 0100',
      email: `praxis@${LANG[language].domain}`, whatsappUrl: null, locationUrl: null,
    },
  };
  return { renderInput, orchestration };
}
