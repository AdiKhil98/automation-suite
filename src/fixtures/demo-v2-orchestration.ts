import { demoV2Hash } from '../domain/demo-v2/hash.js';
import { type DemoV2FixtureInput } from '../domain/demo-v2/orchestration-service.js';

export const DEMO_V2_FIXTURE_NAMES = [
  'premium-german-dental',
  'english-specialist-clinic',
  'french-clinic',
  'hebrew-rtl-clinic',
  'arabic-rtl-clinic',
] as const;
export type DemoV2FixtureName = (typeof DEMO_V2_FIXTURE_NAMES)[number];

const languageData = {
  'premium-german-dental': {
    language: 'de', country: 'Deutschland', domain: 'premium-de.example',
    business: 'Praxis am Park', services: 'Implantologie|Prophylaxe',
    text: 'Die Praxis und der Termin stehen im Mittelpunkt der Behandlung.',
    positioning: 'Ruhige Praxis mit verifizierter Architektur und persönlicher Betreuung.',
  },
  'english-specialist-clinic': {
    language: 'en', country: 'United Kingdom', domain: 'specialist-en.example',
    business: 'Northbridge Specialist Clinic', services: 'Implant dentistry|Oral surgery',
    text: 'The specialist clinic explains treatment and appointment options clearly.',
    positioning: 'Specialist clinic with verified equipment and professional roles.',
  },
  'french-clinic': {
    language: 'fr', country: 'France', domain: 'clinique-fr.example',
    business: 'Clinique du Jardin', services: 'Implantologie|Soins préventifs',
    text: 'La clinique et le rendez-vous sont expliqués pour les patients.',
    positioning: 'Cabinet calme avec des informations pratiques vérifiées.',
  },
  'hebrew-rtl-clinic': {
    language: 'he', country: 'Israel', domain: 'clinic-he.example',
    business: 'מרפאת הגן', services: 'רפואת שיניים משמרת|שתלים',
    text: 'המרפאה מסבירה את אפשרויות הטיפול ואת הדרך לקביעת תור.',
    positioning: 'מרפאה רגועה עם מידע מאומת על הצוות והקשר.',
  },
  'arabic-rtl-clinic': {
    language: 'ar', country: 'Israel', domain: 'clinic-ar.example',
    business: 'عيادة الحديقة', services: 'طب الأسنان الوقائي|زراعة الأسنان',
    text: 'توضح العيادة خيارات العلاج وطريقة طلب الموعد بوضوح.',
    positioning: 'عيادة هادئة مع معلومات موثقة عن التواصل والموقع.',
  },
} as const;

export function demoV2Fixture(
  name: DemoV2FixtureName,
  manifests: { componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string },
): DemoV2FixtureInput {
  const data = languageData[name];
  const base = `https://${data.domain}`;
  const capturedAt = '2026-07-20T10:00:00.000Z';
  const source = (
    id: string,
    kind: 'LEAD_FACT' | 'AUDIT_FINDING' | 'CAPTURE_EVIDENCE',
    role: 'IDENTITY' | 'CONTENT' | 'AUDIT' | 'LANGUAGE' | 'ASSET_CONTEXT' | 'CONTACT' | 'CLAIM',
    key: string,
    value: string,
    direct = true,
    accepted = true,
  ) => ({ id: `${name}-${id}`, kind, role, key, value, capturedAt, direct, accepted });
  const imageUrl = `${base}/media/interior-hero.jpg`;
  const doctorUrl = `${base}/media/doctor-team.jpg`;
  return {
    fixtureId: name,
    sources: [
      source('business', 'LEAD_FACT', 'IDENTITY', 'fact.business_name', data.business),
      source('website', 'LEAD_FACT', 'IDENTITY', 'fact.official_website_url', base),
      source('domain', 'LEAD_FACT', 'IDENTITY', 'fact.official_domain', data.domain),
      source('country', 'LEAD_FACT', 'IDENTITY', 'fact.country', data.country),
      source('address', 'LEAD_FACT', 'CONTACT', 'fact.formatted_address', `1 Example Street, ${data.country}`),
      source('phone', 'LEAD_FACT', 'CONTACT', 'fact.phone', '+49 30 555 0100'),
      source('booking', 'LEAD_FACT', 'CONTACT', 'fact.booking_url', `${base}/appointment`),
      source('hours', 'LEAD_FACT', 'CONTENT', 'fact.opening_hours', 'Monday-Friday 08:00-17:00'),
      source('services', 'LEAD_FACT', 'CONTENT', 'fact.services', data.services),
      source('lang', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.lang', data.language),
      source('text', 'CAPTURE_EVIDENCE', 'LANGUAGE', 'capture.text', data.text),
      source('finding', 'AUDIT_FINDING', 'AUDIT', 'audit.appointment_path', 'The verified appointment action is difficult to find.', false),
      source('positioning', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.positioning.primary', data.positioning, false),
      source('concern', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.concern.orientation', 'Patients need clear practical orientation before requesting an appointment.', false),
      source('atmosphere', 'CAPTURE_EVIDENCE', 'ASSET_CONTEXT', 'capture.atmosphere.interior', 'Verified imagery shows a calm clinic interior.', false),
      source('team', 'CAPTURE_EVIDENCE', 'CLAIM', 'claim.team.verified', 'Dr. Example, dentist', false),
    ],
    pages: [{
      id: `${name}-page-home`,
      url: base,
      captureEvidenceId: `${name}-asset-evidence`,
      html: `<html lang="${data.language}"><head><meta property="og:image" content="${imageUrl}"></head><body><main><section><h1>${data.business}</h1><img src="${imageUrl}" alt="clinic interior hero"><figure><img src="${doctorUrl}" alt="Dr. Example dentist"><figcaption>Verified clinic team</figcaption></figure></section></main></body></html>`,
    }],
    officialWebsiteUrl: base,
    approvedCdnHosts: [],
    assetFetchResults: {
      [imageUrl]: {
        finalUrl: imageUrl, redirectUrls: [], mimeType: 'image/jpeg', bytes: 450_000,
        width: 1800, height: 1100, contentHash: demoV2Hash(`${name}-interior`),
      },
      [doctorUrl]: {
        finalUrl: doctorUrl, redirectUrls: [], mimeType: 'image/jpeg', bytes: 350_000,
        width: 1200, height: 900, contentHash: demoV2Hash(`${name}-doctor`),
      },
    },
    componentRegistry: { version: manifests.componentVersion, hash: manifests.componentHash },
    referenceLibrary: { version: manifests.referenceVersion, hash: manifests.referenceHash },
    now: '2026-07-23T10:00:00.000Z',
  };
}

export type DemoV2ScenarioKind =
  | 'insufficient'
  | 'contradictory-hours'
  | 'third-party-images'
  | 'no-usable-photography'
  | 'unverified-staff-role'
  | 'faq-rich'
  | 'faq-unaccepted-claims';

export function demoV2NegativeFixture(
  kind: DemoV2ScenarioKind,
  manifests: { componentVersion: string; componentHash: string; referenceVersion: string; referenceHash: string },
): DemoV2FixtureInput {
  const fixture = demoV2Fixture('english-specialist-clinic', manifests);
  fixture.fixtureId = `negative-${kind}`;
  const capturedAt = '2026-07-20T10:00:00.000Z';
  const extra = (id: string, role: 'CONTACT' | 'CLAIM', key: string, value: string, accepted = true) =>
    ({ id: `faq-${id}`, kind: 'LEAD_FACT' as const, role, key, value, capturedAt, direct: true, accepted });

  if (kind === 'faq-rich') {
    fixture.sources.push(
      extra('emergency', 'CLAIM', 'claim.emergency_contact', 'Urgent cases are handled through the verified urgent line.'),
      extra('anxiety', 'CLAIM', 'claim.concern.anxiety', 'Patients report anxiety before dental appointments.'),
      extra('family', 'CLAIM', 'claim.audience.family', 'The clinic describes care for children and families.'),
      extra('email', 'CONTACT', 'fact.contact_email', 'reception@specialist-en.example'),
      extra('whatsapp', 'CONTACT', 'fact.whatsapp_url', 'https://specialist-en.example/whatsapp'),
    );
  }
  // Anxious-patient and urgent-contact evidence exists but was NOT accepted: both stay omitted.
  if (kind === 'faq-unaccepted-claims') {
    fixture.sources.push(
      extra('emergency', 'CLAIM', 'claim.emergency_contact', 'Unverified urgent contact claim.', false),
      extra('anxiety', 'CLAIM', 'claim.concern.anxiety', 'Unverified anxiety support claim.', false),
    );
  }
  if (kind === 'insufficient') fixture.sources = fixture.sources.filter((source) => source.key !== 'fact.business_name');
  if (kind === 'contradictory-hours') fixture.sources.push({
    ...fixture.sources.find((source) => source.key === 'fact.opening_hours')!,
    id: 'contradictory-hours-2',
    value: 'Monday-Friday 10:00-19:00',
  });
  if (kind === 'third-party-images') {
    fixture.pages[0]!.html = '<html lang="en"><body><img src="https://directory-images.example/photo.jpg" alt="clinic"></body></html>';
    fixture.assetFetchResults = {};
  }
  if (kind === 'no-usable-photography') {
    for (const result of Object.values(fixture.assetFetchResults)) {
      result.width = 120;
      result.height = 80;
    }
  }
  if (kind === 'unverified-staff-role') {
    fixture.sources = fixture.sources.map((source) =>
      source.key === 'claim.team.verified' ? { ...source, accepted: false } : source);
  }
  return fixture;
}
