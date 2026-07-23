import { clinicIntelligencePackageSchema, expectedDirection, type ClinicIntelligencePackage } from './clinic-intelligence.js';
import { demoV2Hash } from './hash.js';
import {
  clinicIntelligenceDataSchema,
  type ClinicIntelligenceData,
  type DemoV2Assertion,
  type DemoV2SourceRecord,
} from './orchestration-types.js';

export interface DemoV2RawSource {
  id: string;
  kind: DemoV2SourceRecord['kind'];
  role: DemoV2SourceRecord['role'];
  key: string;
  value: string;
  capturedAt: Date;
  direct: boolean;
  accepted: boolean;
}

export interface ClinicIntelligenceBuildInput {
  id: string;
  artifactId: string;
  version: number;
  sources: DemoV2RawSource[];
  now: Date;
  staleAfterDays?: number;
}

const PROHIBITED_CLAIMS = [
  'awards without verified evidence',
  'clinical or business results',
  'prices not present in verified evidence',
  'popularity or market leadership',
  'years of experience not directly verified',
  'medical efficacy or outcome claims',
] as const;

const roleForFact: Record<string, keyof ClinicIntelligenceData | undefined> = {
  business_name: 'businessIdentity',
  category: 'businessIdentity',
  ownership_type: 'businessIdentity',
  official_website_url: 'officialWebsite',
  official_domain: 'officialWebsite',
  domain: 'officialWebsite',
  formatted_address: 'locations',
  city: 'locations',
  country: 'locations',
  official_location_page_url: 'locations',
  phone: 'contactChannels',
  contact_email: 'contactChannels',
  contact_form_url: 'contactChannels',
  booking_url: 'appointmentMethods',
  opening_hours: 'openingHours',
  services: 'services',
};

function languageCode(value: string): 'de' | 'en' | 'fr' | 'he' | 'ar' | null {
  const normalized = value.trim().toLowerCase().split(/[-_]/)[0];
  return normalized === 'de' || normalized === 'en' || normalized === 'fr'
    || normalized === 'he' || normalized === 'ar' ? normalized : null;
}

function languageFromText(value: string): 'de' | 'en' | 'fr' | 'he' | 'ar' | null {
  if (/[\u0590-\u05ff]/u.test(value)) return 'he';
  if (/[\u0600-\u06ff]/u.test(value)) return 'ar';
  const lower = ` ${value.toLowerCase()} `;
  const scores = {
    de: [' der ', ' die ', ' und ', ' termin ', ' praxis '].filter((word) => lower.includes(word)).length,
    en: [' the ', ' and ', ' appointment ', ' clinic ', ' contact '].filter((word) => lower.includes(word)).length,
    fr: [' le ', ' la ', ' et ', ' rendez-vous ', ' clinique '].filter((word) => lower.includes(word)).length,
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return ranked[0]![1] >= 2 && ranked[0]![1] > ranked[1]![1]
    ? ranked[0]![0] as 'de' | 'en' | 'fr'
    : null;
}

function detectLanguages(sources: DemoV2SourceRecord[]): ClinicIntelligenceData['languageDecision'] {
  const scores = new Map<'de' | 'en' | 'fr' | 'he' | 'ar', number>();
  const sourceIds = new Set<string>();
  const add = (language: 'de' | 'en' | 'fr' | 'he' | 'ar' | null, weight: number, id: string): void => {
    if (!language) return;
    scores.set(language, (scores.get(language) ?? 0) + weight);
    sourceIds.add(id);
  };
  for (const source of sources) {
    if (source.key === 'capture.lang') add(languageCode(source.value), 5, source.id);
    if (source.key === 'capture.text') add(languageFromText(source.value), 3, source.id);
    if (source.key === 'fact.country') {
      const country = source.value.toLowerCase();
      add(/germany|deutschland|austria|österreich|switzerland|schweiz/.test(country) ? 'de'
        : /france|belgique/.test(country) ? 'fr'
          : /israel/.test(country) ? 'he' : null, 2, source.id);
    }
    if (source.key === 'fact.official_website_url' || source.key === 'fact.official_domain') {
      const match = source.value.toLowerCase().match(/\.(de|at|ch|fr|il)(?:\/|$)/);
      add(match?.[1] === 'fr' ? 'fr' : match?.[1] === 'il' ? 'he' : match ? 'de' : null, 1, source.id);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const primary = ranked[0]?.[0] ?? 'en';
  const manualReviewRequired = ranked.length > 1 && ranked[0]![1] - ranked[1]![1] < 2;
  const supported = ranked.filter((entry) => entry[1] >= 3).map((entry) => entry[0]);
  if (!supported.includes(primary)) supported.unshift(primary);
  return {
    primaryLanguage: primary,
    primaryDirection: expectedDirection(primary),
    supportedLanguages: supported,
    signalSourceIds: [...sourceIds].sort(),
    manualReviewRequired,
  };
}

function assertion(source: DemoV2SourceRecord): DemoV2Assertion {
  return {
    key: source.key,
    value: source.value,
    classification: source.direct ? 'DIRECT_FACT' : 'EVIDENCE_BOUND_DERIVATION',
    sourceIds: [source.id],
  };
}

export function buildClinicIntelligence(input: ClinicIntelligenceBuildInput): {
  package: ClinicIntelligencePackage;
  data: ClinicIntelligenceData;
  sources: DemoV2SourceRecord[];
} {
  const staleMs = (input.staleAfterDays ?? 365) * 86_400_000;
  const sources = input.sources.map((source): DemoV2SourceRecord => {
    const capturedAt = source.capturedAt.toISOString();
    const stale = input.now.getTime() - source.capturedAt.getTime() > staleMs;
    return {
      ...source,
      capturedAt,
      stale,
      recordHash: demoV2Hash({
        id: source.id,
        kind: source.kind,
        key: source.key,
        value: source.value,
        capturedAt,
        direct: source.direct,
      }),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const usable = sources.filter((source) => source.accepted && !source.stale && source.value.trim() !== '');
  const excludedSourceIds = sources.filter((source) => !usable.includes(source)).map((source) => source.id);

  const grouped = new Map<string, DemoV2SourceRecord[]>();
  for (const source of usable) {
    const values = grouped.get(source.key) ?? [];
    values.push(source);
    grouped.set(source.key, values);
  }
  const contradictions = [...grouped.entries()]
    .filter(([, values]) => new Set(values.map((source) => source.value.trim().toLowerCase())).size > 1)
    .map(([key, values]) => ({
      key,
      sourceIds: values.map((source) => source.id).sort(),
      values: [...new Set(values.map((source) => source.value.trim()))].sort(),
    }));

  const data: ClinicIntelligenceData = {
    businessIdentity: [],
    officialWebsite: [],
    locations: [],
    contactChannels: [],
    appointmentMethods: [],
    openingHours: [],
    emergencyContact: [],
    services: [],
    teamMembers: [],
    positioning: [],
    differentiators: [],
    audienceConcerns: [],
    atmosphereCues: [],
    websiteStrengths: [],
    acceptedAuditFindings: [],
    conversionWeaknesses: [],
    prohibitedClaims: [...PROHIBITED_CLAIMS],
    availableEvidence: usable,
    excludedSourceIds,
    contradictions,
    missingInformation: [],
    languageDecision: detectLanguages(usable),
  };

  for (const source of usable) {
    if (source.key.startsWith('fact.')) {
      const target = roleForFact[source.key.slice(5)];
      if (target && Array.isArray(data[target])) {
        (data[target] as DemoV2Assertion[]).push(assertion(source));
      }
    } else if (source.key.startsWith('audit.')) {
      data.acceptedAuditFindings.push(assertion(source));
      data.conversionWeaknesses.push(assertion(source));
    } else if (source.key.startsWith('capture.strength.')) {
      data.websiteStrengths.push(assertion(source));
    } else if (source.key.startsWith('capture.atmosphere.')) {
      data.atmosphereCues.push(assertion(source));
    } else if (source.key.startsWith('claim.team.')) {
      data.teamMembers.push(assertion(source));
    } else if (source.key.startsWith('claim.positioning.')) {
      data.positioning.push(assertion(source));
    } else if (source.key.startsWith('claim.differentiator.')) {
      data.differentiators.push(assertion(source));
    } else if (source.key.startsWith('claim.concern.')) {
      data.audienceConcerns.push(assertion(source));
    } else if (source.key === 'claim.emergency_contact') {
      data.emergencyContact.push(assertion(source));
    }
  }

  if (data.businessIdentity.length === 0) data.missingInformation.push('business identity');
  if (data.officialWebsite.length === 0) data.missingInformation.push('verified official website');
  if (data.appointmentMethods.length === 0) data.missingInformation.push('verified appointment method');
  if (data.openingHours.length === 0) data.missingInformation.push('verified opening hours');
  if (data.teamMembers.length === 0) data.missingInformation.push('verified team and roles');
  if (data.emergencyContact.length === 0) data.missingInformation.push('verified emergency contact');

  const criticalContradiction = contradictions.some((item) =>
    ['fact.business_name', 'fact.official_domain', 'fact.official_website_url', 'fact.opening_hours'].includes(item.key));
  const blocked = criticalContradiction
    || data.languageDecision.manualReviewRequired
    || data.businessIdentity.length === 0
    || data.officialWebsite.length === 0;
  const parsedData = clinicIntelligenceDataSchema.parse(data);
  const inputFingerprint = demoV2Hash({
    version: DEMO_V2_INTELLIGENCE_RULES_VERSION,
    sources: sources.map((source) => ({ id: source.id, hash: source.recordHash, accepted: source.accepted, stale: source.stale })),
  });
  const packageHash = demoV2Hash(parsedData);
  const result = clinicIntelligencePackageSchema.parse({
    id: input.id,
    artifactId: input.artifactId,
    version: input.version,
    schemaVersion: DEMO_V2_INTELLIGENCE_RULES_VERSION,
    status: blocked ? 'BLOCKED' : 'READY',
    primaryLanguage: parsedData.languageDecision.primaryLanguage,
    primaryDirection: parsedData.languageDecision.primaryDirection,
    supportedLanguages: parsedData.languageDecision.supportedLanguages,
    package: parsedData,
    inputFingerprint,
    packageHash,
  });
  return { package: result, data: parsedData, sources };
}

export const DEMO_V2_INTELLIGENCE_RULES_VERSION = 'demo-v2-intelligence-1';
