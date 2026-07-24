import { demoV2Hash } from '../hash.js';

/**
 * Deterministic, fail-closed structural checks on a rendered bundle.
 *
 * These checks decide ONLY whether a render is structurally eligible for later visual review.
 * A pass is explicitly NOT evidence that the design is good; aesthetic judgement belongs to the
 * (currently mock) visual reviewer and ultimately to a human.
 */

export const DEMO_V2_QUALITY_RUBRIC_VERSION = 'demo-v2-quality-rubric-1';

export type QualitySeverity = 'BLOCKER' | 'FINDING';

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  detail: string;
  language: string;
}

export interface QualityCheckInput {
  documents: readonly { language: string; path: string; html: string }[];
  primaryLanguage: string;
  supportedLanguages: readonly string[];
  /** Bundle-relative asset paths that were actually written. */
  bundledAssetPaths: readonly string[];
  expectedAnchors: readonly string[];
  faqTopicCount: number;
}

export interface QualityCheckResult {
  rubricVersion: string;
  rubricHash: string;
  issues: readonly QualityIssue[];
  blockers: readonly QualityIssue[];
  structurallyEligible: boolean;
}

const PLACEHOLDER = /\{\{[A-Za-z0-9_]+\}\}|\blorem ipsum\b|TODO:|FIXME/i;
const RAW_MARKDOWN = /(^|\n)\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/;
/** Only RESOURCE loads must be local. An anchor to a verified booking/contact destination is
 * expected and is not an external request. */
const EXTERNAL_RESOURCE = /(?:\bsrc\s*=\s*"|<link[^>]+href\s*=\s*")(?:https?:)?\/\/(?!\/)/i;
const AI_TONE = /\b(unlock|elevate|revolutioni[sz]e|seamless(?:ly)?|cutting[- ]edge|game[- ]changer|world[- ]class|next[- ]level)\b/i;

function attr(html: string, pattern: RegExp): string | null {
  return pattern.exec(html)?.[1] ?? null;
}

function countOccurrences(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

function textContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RTL_LANGUAGES = new Set(['he', 'ar']);
/** High-signal function words used to detect a document mixing two languages. */
const LANGUAGE_MARKERS: Record<string, RegExp> = {
  de: /\b(und|der|die|das|Sie|Termin|Praxis|Öffnungszeiten)\b/,
  en: /\b(and|the|your|appointment|clinic|opening hours)\b/i,
  fr: /\b(et|le|la|les|rendez-vous|cabinet|horaires)\b/,
};

export function runQualityChecks(input: QualityCheckInput): QualityCheckResult {
  const issues: QualityIssue[] = [];
  const add = (code: string, severity: QualitySeverity, detail: string, language: string) =>
    issues.push({ code, severity, detail, language });

  if (!input.supportedLanguages.includes(input.primaryLanguage)) {
    add('missing_language_content', 'BLOCKER', 'primary language is not among supported languages', input.primaryLanguage);
  }
  for (const language of input.supportedLanguages) {
    if (!input.documents.some((document) => document.language === language)) {
      add('missing_language_content', 'BLOCKER', `no document rendered for ${language}`, language);
    }
  }

  for (const document of input.documents) {
    const { html, language } = document;
    const body = textContent(html);

    // ---- technical ----
    const lang = attr(html, /<html[^>]*\blang="([^"]+)"/i);
    const dir = attr(html, /<html[^>]*\bdir="([^"]+)"/i);
    if (lang !== language) add('incorrect_lang', 'BLOCKER', `html lang="${lang ?? 'missing'}" expected "${language}"`, language);
    const expectedDir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
    if (dir !== expectedDir) add('incorrect_dir', 'BLOCKER', `html dir="${dir ?? 'missing'}" expected "${expectedDir}"`, language);
    if (!/name="robots"[^>]*noindex/i.test(html)) add('missing_noindex', 'BLOCKER', 'robots noindex meta missing', language);
    if (!/Content-Security-Policy/i.test(html)) add('missing_csp', 'BLOCKER', 'CSP meta missing', language);
    if (!/dv2-disclosure/.test(html)) add('missing_disclosure', 'BLOCKER', 'concept disclosure missing', language);
    if (EXTERNAL_RESOURCE.test(html)) add('external_request', 'BLOCKER', 'document loads a resource from an external origin', language);
    if (PLACEHOLDER.test(body)) add('unresolved_placeholder', 'BLOCKER', 'placeholder token or lorem text present', language);
    if (RAW_MARKDOWN.test(body)) add('raw_markdown', 'BLOCKER', 'raw markdown leaked into rendered text', language);

    // every referenced image must exist in the bundle
    for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
      const src = match[1]!;
      if (!input.bundledAssetPaths.includes(src)) {
        add('failed_asset', 'BLOCKER', `image not bundled: ${src}`, language);
      }
    }
    // intrinsic dimensions + alt text
    for (const match of html.matchAll(/<img[^>]*>/gi)) {
      const tag = match[0];
      if (!/\balt="/.test(tag)) add('inaccessible_control', 'BLOCKER', 'image without alt attribute', language);
      if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) {
        add('image_stretching', 'BLOCKER', 'image without intrinsic width/height', language);
      }
    }
    // duplicate ids
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    if (new Set(ids).size !== ids.length) add('duplicate_id', 'BLOCKER', 'duplicate element id', language);
    // internal navigation resolves
    for (const match of html.matchAll(/href="#([^"]+)"/g)) {
      const target = match[1]!;
      if (target !== 'top' && target !== 'main' && !ids.includes(target)) {
        add('broken_internal_navigation', 'BLOCKER', `anchor #${target} has no target`, language);
      }
    }
    if (!/id="main"/.test(html)) add('inaccessible_control', 'BLOCKER', 'main landmark missing', language);
    if (!/class="dv2-skip"/.test(html)) add('inaccessible_control', 'BLOCKER', 'skip link missing', language);

    // ---- content integrity ----
    const foreign = Object.entries(LANGUAGE_MARKERS)
      .filter(([code]) => code !== language && input.supportedLanguages.includes(code))
      .filter(([, pattern]) => pattern.test(body));
    if (foreign.length > 0) {
      add('mixed_language', 'BLOCKER', `foreign language markers: ${foreign.map(([code]) => code).join(',')}`, language);
    }
    if (AI_TONE.test(body)) add('unprofessional_copy', 'FINDING', 'promotional AI-style wording detected', language);

    // ---- visual structure ----
    const h1Count = countOccurrences(html, /<h1\b/g);
    if (h1Count !== 1) add('hero_lacks_content', 'BLOCKER', `expected exactly one h1, found ${h1Count}`, language);
    if (!/class="dv2-btn"/.test(html)) add('primary_cta_missing', 'BLOCKER', 'no primary call to action rendered', language);
    const sectionCount = countOccurrences(html, /<section\b/g);
    if (sectionCount < 5) add('empty_sections', 'BLOCKER', `only ${sectionCount} sections rendered`, language);
    const emptySections = countOccurrences(html, /<section[^>]*>\s*<\/section>/g);
    if (emptySections > 0) add('empty_sections', 'BLOCKER', 'a rendered section has no content', language);
    // rhythm must vary — an identical cadence in every section is a rejection criterion
    const rhythms = [...html.matchAll(/data-rhythm="([^"]+)"/g)].map((match) => match[1]!);
    if (rhythms.length >= 3 && new Set(rhythms).size === 1) {
      add('identical_section_rhythm', 'FINDING', 'every section uses the same rhythm', language);
    }
    // no card-grid dominance
    const people = countOccurrences(html, /class="dv2-person"/g);
    if (people > 8) add('excessive_card_repetition', 'FINDING', `${people} repeated person cards`, language);
    // long unbroken text blocks
    for (const paragraph of html.matchAll(/<p[^>]*>([^<]{600,})<\/p>/g)) {
      add('overly_long_text', 'FINDING', `paragraph of ${paragraph[1]!.length} characters`, language);
    }
    // language switcher required whenever a second language exists
    if (input.supportedLanguages.length > 1 && !/class="dv2-lang"/.test(html)) {
      add('language_switcher_missing', 'BLOCKER', 'language switcher absent', language);
    }
    // concierge must not be claimed without topics
    const hasLauncher = /dv2-concierge__launcher/.test(html);
    if (input.faqTopicCount === 0 && hasLauncher) {
      add('unsupported_faq_escalation', 'BLOCKER', 'concierge launcher rendered without verified topics', language);
    }
    if (input.faqTopicCount > 0 && !hasLauncher) {
      add('unsupported_faq_escalation', 'BLOCKER', 'verified FAQ topics exist but no concierge rendered', language);
    }
    // concierge must sit below the mobile appointment bar in z-order
    if (hasLauncher && /--z-mobile-bar/.test(html) && /--z-concierge:/.test(html)) {
      const bar = Number(attr(html, /--z-mobile-bar:(\d+)/) ?? '0');
      const panel = Number(attr(html, /--z-concierge-panel:(\d+)/) ?? '0');
      if (panel >= bar) {
        add('concierge_overlaps_cta', 'BLOCKER', 'concierge panel is above the mobile appointment bar', language);
      }
    }
    for (const anchor of input.expectedAnchors) {
      if (!ids.includes(anchor)) add('empty_sections', 'FINDING', `planned section ${anchor} not rendered`, language);
    }
  }

  const blockers = issues.filter((issue) => issue.severity === 'BLOCKER');
  return {
    rubricVersion: DEMO_V2_QUALITY_RUBRIC_VERSION,
    rubricHash: demoV2Hash({ version: DEMO_V2_QUALITY_RUBRIC_VERSION, codes: [...new Set(issues.map((i) => i.code))].sort() }),
    issues,
    blockers,
    structurallyEligible: blockers.length === 0,
  };
}
