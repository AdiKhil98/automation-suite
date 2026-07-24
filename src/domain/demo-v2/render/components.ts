import { z } from 'zod';
import { demoV2Hash } from '../hash.js';

/**
 * Code-native component registry. Every component is a closed contract: required/optional content
 * keys, allowed asset categories, fallback behaviour, language + RTL support, responsive and
 * accessibility requirements, motion preset, design-token usage, evidence restrictions, and its
 * screenshot test cases.
 *
 * No component accepts raw HTML. A component that cannot satisfy its required content keys is
 * omitted by the renderer (or fails closed when the plan marks it mandatory).
 */

export const MOTION_PRESETS = [
  'NONE', 'HERO_ENTRANCE', 'TEXT_REVEAL', 'IMAGE_REVEAL', 'STAGGERED_REVEAL',
  'STICKY_TRANSITION', 'GALLERY_TRANSITION', 'ACCORDION', 'CONCIERGE_OPEN',
  'MOBILE_MENU', 'CTA_STATE',
] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];

export const ASSET_CATEGORIES = [
  'HERO', 'CLINIC_INTERIOR', 'EXTERIOR', 'TEAM', 'DOCTOR', 'TREATMENT',
  'EQUIPMENT', 'LOCATION', 'LOGO', 'DECORATIVE',
] as const;
export type AllowedAssetCategory = (typeof ASSET_CATEGORIES)[number];

export const COMPONENT_GROUPS = [
  'GLOBAL', 'HERO', 'ACTIONS', 'TRUST', 'TREATMENTS', 'PEOPLE', 'PLACE',
  'EXPERIENCE', 'INFORMATION', 'CONVERSION', 'FOOTER',
] as const;
export type ComponentGroup = (typeof COMPONENT_GROUPS)[number];

export interface ComponentSpec {
  id: string;
  group: ComponentGroup;
  /** Content keys that MUST be present or the component cannot render. */
  requiredContentKeys: readonly string[];
  /** Additional keys used when available; absence never blocks rendering. */
  optionalContentKeys: readonly string[];
  /** Key prefixes this component may consume (repeating collections). */
  contentKeyPrefixes: readonly string[];
  allowedAssetCategories: readonly AllowedAssetCategory[];
  /** Maximum approved assets this component may place. */
  maxAssets: number;
  fallbackBehavior: string;
  supportedLanguages: 'ALL';
  rtl: 'MIRRORED' | 'FLOW_ONLY';
  responsive: string;
  accessibility: readonly string[];
  motion: MotionPreset;
  tokens: readonly string[];
  /** What this component may never assert, beyond the global evidence rules. */
  evidenceRestrictions: readonly string[];
  screenshotCases: readonly string[];
}

const ALL = 'ALL' as const;

function spec(input: ComponentSpec): ComponentSpec {
  return input;
}

export const COMPONENT_SPECS: readonly ComponentSpec[] = [
  // ---------------------------------------------------------------- GLOBAL
  spec({
    id: 'ConceptDisclosureBar', group: 'GLOBAL',
    requiredContentKeys: ['disclosure.text'], optionalContentKeys: [], contentKeyPrefixes: [],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Mandatory. The renderer fails closed if the disclosure is missing.',
    supportedLanguages: ALL, rtl: 'FLOW_ONLY',
    responsive: 'Single line on desktop, wraps to two lines on mobile; never truncated.',
    accessibility: ['role=note', 'contrast AA', 'not focus-trapping'],
    motion: 'NONE', tokens: ['colors.accentSoft', 'colors.ink', 'scale.xs', 'space.x2'],
    evidenceRestrictions: ['Must state the page is a concept for review'],
    screenshotCases: ['desktop-top', 'mobile-top'],
  }),
  spec({
    id: 'PremiumEditorialNavigation', group: 'GLOBAL',
    requiredContentKeys: ['navigation.contact'],
    optionalContentKeys: ['navigation.treatments', 'navigation.clinic', 'navigation.team', 'hero.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Renders the available subset of anchors; never invents a destination.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Horizontal ≥1024px; collapses to MobileNavigation below.',
    accessibility: ['nav landmark', 'visible focus ring', 'anchors resolve to rendered sections'],
    motion: 'STICKY_TRANSITION',
    tokens: ['colors.surface', 'colors.line', 'scale.sm', 'space.x3', 'zIndex.sticky'],
    evidenceRestrictions: ['Anchors may only target sections actually rendered'],
    screenshotCases: ['desktop-nav', 'desktop-nav-scrolled'],
  }),
  spec({
    id: 'MobileNavigation', group: 'GLOBAL',
    requiredContentKeys: ['navigation.contact'],
    optionalContentKeys: ['navigation.treatments', 'navigation.clinic', 'navigation.team'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted above the mobile breakpoint.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Below 1024px only; full-height panel; body scroll locked while open.',
    accessibility: ['aria-expanded', 'aria-controls', 'Escape closes', 'focus returns to toggle', '44px targets'],
    motion: 'MOBILE_MENU',
    tokens: ['colors.surface', 'space.x4', 'zIndex.sticky', 'motionBase'],
    evidenceRestrictions: ['Mirrors desktop navigation exactly'],
    screenshotCases: ['mobile-menu-closed', 'mobile-menu-open'],
  }),
  spec({
    id: 'LanguageSwitcher', group: 'GLOBAL',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: [],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Rendered only when a complete reviewed secondary package exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Present in both desktop and mobile navigation.',
    accessibility: ['aria-current on active language', 'real links', 'keyboard reachable'],
    motion: 'CTA_STATE',
    tokens: ['colors.accent', 'scale.xs', 'space.x1'],
    evidenceRestrictions: ['Never offers an incomplete or unreviewed language'],
    screenshotCases: ['desktop-language-switcher', 'mobile-language-switcher'],
  }),
  spec({
    id: 'SkipLink', group: 'GLOBAL',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: [],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Always rendered first in the document.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Visually hidden until focused at every viewport.',
    accessibility: ['first tab stop', 'targets #main', 'visible on focus'],
    motion: 'NONE', tokens: ['colors.accent', 'zIndex.skipLink'],
    evidenceRestrictions: [],
    screenshotCases: ['desktop-skiplink-focused'],
  }),

  // ------------------------------------------------------------------ HERO
  spec({
    id: 'ArchitectureImageHero', group: 'HERO',
    requiredContentKeys: ['hero.heading'], optionalContentKeys: ['hero.eyebrow', 'appointment.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: ['HERO', 'CLINIC_INTERIOR', 'EXTERIOR'], maxAssets: 1,
    fallbackBehavior: 'Without an approved image the renderer selects a typographic hero instead.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Full-bleed image, 16:9 desktop / 4:5 mobile crop, focal-point positioned.',
    accessibility: ['single h1', 'AA contrast over the overlay', 'meaningful alt text'],
    motion: 'HERO_ENTRANCE',
    tokens: ['colors.overlay', 'scale.display', 'space.x8', 'overlayStrength'],
    evidenceRestrictions: ['Heading is the verified business name only'],
    screenshotCases: ['desktop-hero', 'tablet-hero', 'mobile-hero'],
  }),
  spec({
    id: 'EditorialSplitHero', group: 'HERO',
    requiredContentKeys: ['hero.heading'], optionalContentKeys: ['hero.eyebrow', 'appointment.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: ['HERO', 'CLINIC_INTERIOR', 'EXTERIOR', 'EQUIPMENT'], maxAssets: 1,
    fallbackBehavior: 'Collapses to a single column when no approved asset exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Two columns ≥1024px, stacked below; image never letterboxed.',
    accessibility: ['single h1', 'logical reading order when stacked'],
    motion: 'HERO_ENTRANCE',
    tokens: ['colors.surfaceAlt', 'scale.xl', 'space.x8'],
    evidenceRestrictions: ['No claim text beyond verified content keys'],
    screenshotCases: ['desktop-hero', 'mobile-hero'],
  }),
  spec({
    id: 'CalmCareHero', group: 'HERO',
    requiredContentKeys: ['hero.heading'], optionalContentKeys: ['hero.eyebrow', 'appointment.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: ['CLINIC_INTERIOR', 'EXTERIOR', 'HERO'], maxAssets: 1,
    fallbackBehavior: 'Soft typographic panel when no approved asset exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Framed image with generous padding; stacks on mobile.',
    accessibility: ['single h1', 'AA contrast on tinted panel'],
    motion: 'HERO_ENTRANCE',
    tokens: ['colors.accentSoft', 'radiusLg', 'scale.xl'],
    evidenceRestrictions: ['No reassurance claims beyond verified content'],
    screenshotCases: ['desktop-hero', 'mobile-hero'],
  }),
  spec({
    id: 'LocationLedHero', group: 'HERO',
    requiredContentKeys: ['hero.heading'],
    optionalContentKeys: ['hero.eyebrow', 'location.value', 'hours.value', 'appointment.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: ['EXTERIOR', 'LOCATION', 'CLINIC_INTERIOR'], maxAssets: 1,
    fallbackBehavior: 'Typographic hero listing verified practical details.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Restrained band; practical details inline on desktop, stacked on mobile.',
    accessibility: ['single h1', 'address marked up as text, never an image'],
    motion: 'TEXT_REVEAL',
    tokens: ['colors.canvas', 'scale.xl', 'space.x6'],
    evidenceRestrictions: ['Only verified address and hours values'],
    screenshotCases: ['desktop-hero', 'mobile-hero'],
  }),

  // --------------------------------------------------------------- ACTIONS
  spec({
    id: 'AppointmentActionDock', group: 'ACTIONS',
    requiredContentKeys: ['appointment.heading', 'appointment.verified_method'],
    optionalContentKeys: ['contact.value'], contentKeyPrefixes: [],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Replaced by ContactChoicePanel when no appointment method is verified.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Inline dock on desktop; MobileAppointmentBar carries it on mobile.',
    accessibility: ['descriptive link text', '44px targets', 'visible focus'],
    motion: 'CTA_STATE',
    tokens: ['colors.accent', 'colors.inkOnAccent', 'radiusMd', 'space.x4'],
    evidenceRestrictions: ['Destination must be a verified channel; never an invented booking URL'],
    screenshotCases: ['desktop-appointment', 'mobile-appointment'],
  }),
  spec({
    id: 'MobileAppointmentBar', group: 'ACTIONS',
    requiredContentKeys: ['appointment.verified_method'], optionalContentKeys: ['appointment.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified appointment channel exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Fixed bottom bar below 1024px only; reserves body padding so nothing is covered.',
    accessibility: ['44px target', 'above the concierge in z-order', 'not a focus trap'],
    motion: 'CTA_STATE',
    tokens: ['colors.accent', 'zIndex.mobileBar', 'space.x2'],
    evidenceRestrictions: ['Same verified destination as the dock'],
    screenshotCases: ['mobile-appointment-bar'],
  }),
  spec({
    id: 'CallEmergencyActions', group: 'ACTIONS',
    requiredContentKeys: ['urgent.value'], optionalContentKeys: ['contact.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted entirely unless urgent contact evidence is verified.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Inline row; wraps on mobile.',
    accessibility: ['tel: links', 'explicit non-medical-advice note'],
    motion: 'NONE', tokens: ['colors.surfaceAlt', 'scale.sm'],
    evidenceRestrictions: ['Never implies emergency availability that is not verified'],
    screenshotCases: ['desktop-urgent'],
  }),
  spec({
    id: 'ContactChoicePanel', group: 'ACTIONS',
    requiredContentKeys: ['contact.value'], optionalContentKeys: ['contact.heading', 'location.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified contact channel exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Two columns on desktop, stacked on mobile.',
    accessibility: ['each channel is a real link', 'no free-text patient fields'],
    motion: 'NONE', tokens: ['colors.surface', 'space.x4', 'radiusMd'],
    evidenceRestrictions: ['Only verified channels; no contact form that collects patient data'],
    screenshotCases: ['desktop-contact'],
  }),

  // ----------------------------------------------------------------- TRUST
  spec({
    id: 'SpecialistTrustStrip', group: 'TRUST',
    requiredContentKeys: [], optionalContentKeys: ['hours.value', 'location.value'],
    contentKeyPrefixes: ['trust.'], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified strength or practical value exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Three columns desktop, one column mobile; never a card grid.',
    accessibility: ['list semantics', 'AA contrast'],
    motion: 'TEXT_REVEAL', tokens: ['colors.surfaceAlt', 'scale.sm', 'space.x6'],
    evidenceRestrictions: ['No ratings, awards, counts, or social proof'],
    screenshotCases: ['desktop-trust'],
  }),
  spec({
    id: 'VerifiedHoursStrip', group: 'TRUST',
    requiredContentKeys: ['hours.value'], optionalContentKeys: ['location.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted without verified hours.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Single band; wraps on mobile without breaking words.',
    accessibility: ['hours as text', 'AA contrast'],
    motion: 'NONE', tokens: ['colors.accentSoft', 'scale.sm'],
    evidenceRestrictions: ['Verbatim verified hours only'],
    screenshotCases: ['desktop-trust'],
  }),
  spec({
    id: 'LocationProofStrip', group: 'TRUST',
    requiredContentKeys: ['location.value'], optionalContentKeys: ['hours.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted without a verified address.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Single band; address never truncated.',
    accessibility: ['address as text'],
    motion: 'NONE', tokens: ['colors.surfaceAlt', 'scale.sm'],
    evidenceRestrictions: ['Verbatim verified address only'],
    screenshotCases: ['desktop-trust'],
  }),

  // ------------------------------------------------------------ TREATMENTS
  spec({
    id: 'EditorialTreatmentIndex', group: 'TREATMENTS',
    requiredContentKeys: [], optionalContentKeys: ['navigation.treatments'], contentKeyPrefixes: ['treatments.'],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified treatment name exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Numbered editorial list, two columns ≥1024px; never a card grid.',
    accessibility: ['ordered list semantics', 'no icon-only meaning'],
    motion: 'STAGGERED_REVEAL', tokens: ['colors.line', 'scale.md', 'space.x4'],
    evidenceRestrictions: ['Treatment names verbatim; no descriptions, prices, or outcomes'],
    screenshotCases: ['desktop-treatments', 'mobile-treatments'],
  }),
  spec({
    id: 'GroupedTreatmentDiscovery', group: 'TREATMENTS',
    requiredContentKeys: [], optionalContentKeys: ['navigation.treatments'], contentKeyPrefixes: ['treatments.'],
    allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified treatment name exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Grouped columns with a rule between groups; single column on mobile.',
    accessibility: ['group headings', 'list semantics'],
    motion: 'STAGGERED_REVEAL', tokens: ['colors.line', 'scale.base', 'space.x3'],
    evidenceRestrictions: ['Grouping is presentational only and adds no claim'],
    screenshotCases: ['desktop-treatments', 'mobile-treatments'],
  }),
  spec({
    id: 'TreatmentSpotlight', group: 'TREATMENTS',
    requiredContentKeys: [], optionalContentKeys: ['navigation.treatments'], contentKeyPrefixes: ['treatments.'],
    allowedAssetCategories: ['TREATMENT', 'EQUIPMENT'], maxAssets: 1,
    fallbackBehavior: 'Typographic spotlight when no approved treatment asset exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Large lead item plus a compact remainder list; stacks on mobile.',
    accessibility: ['heading hierarchy', 'list semantics'],
    motion: 'TEXT_REVEAL', tokens: ['scale.lg', 'space.x6'],
    evidenceRestrictions: ['Spotlight implies no recommendation or superiority'],
    screenshotCases: ['desktop-treatments'],
  }),

  // ---------------------------------------------------------------- PEOPLE
  spec({
    id: 'SpecialistPortraitRail', group: 'PEOPLE',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: ['team.'],
    allowedAssetCategories: ['DOCTOR', 'TEAM'], maxAssets: 2,
    fallbackBehavior: 'Omitted when no verified person exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Horizontal rail on desktop; vertical stack on mobile (no horizontal scroll).',
    accessibility: ['portrait alt text', 'name and role as text'],
    motion: 'IMAGE_REVEAL', tokens: ['radiusMd', 'space.x4'],
    evidenceRestrictions: ['Only verified people; never an invented name, title, or credential'],
    screenshotCases: ['desktop-team', 'mobile-team'],
  }),
  spec({
    id: 'TeamEditorialGrid', group: 'PEOPLE',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: ['team.'],
    allowedAssetCategories: ['TEAM', 'DOCTOR'], maxAssets: 2,
    fallbackBehavior: 'Text-only editorial list when no approved portrait exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Two columns ≥1024px, single column mobile.',
    accessibility: ['heading hierarchy', 'meaningful alt text'],
    motion: 'STAGGERED_REVEAL', tokens: ['colors.surface', 'space.x6'],
    evidenceRestrictions: ['Only verified people'],
    screenshotCases: ['desktop-team', 'mobile-team'],
  }),
  spec({
    id: 'DoctorFeature', group: 'PEOPLE',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: ['team.'],
    allowedAssetCategories: ['DOCTOR'], maxAssets: 1,
    fallbackBehavior: 'Omitted when no verified person exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Single feature with portrait beside text; stacks on mobile.',
    accessibility: ['portrait alt text', 'name as text'],
    motion: 'IMAGE_REVEAL', tokens: ['space.x8', 'radiusMd'],
    evidenceRestrictions: ['One verified person only; no credential invention'],
    screenshotCases: ['desktop-team'],
  }),

  // ----------------------------------------------------------------- PLACE
  spec({
    id: 'ArchitectureStory', group: 'PLACE',
    requiredContentKeys: [], optionalContentKeys: ['hero.heading'], contentKeyPrefixes: ['atmosphere.', 'trust.'],
    allowedAssetCategories: ['CLINIC_INTERIOR', 'EXTERIOR', 'HERO'], maxAssets: 1,
    fallbackBehavior: 'Omitted when neither approved interior imagery nor verified atmosphere text exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Wide image with an offset text column; stacks on mobile.',
    accessibility: ['descriptive alt text', 'heading hierarchy'],
    motion: 'IMAGE_REVEAL', tokens: ['space.x12', 'colors.surfaceAlt'],
    evidenceRestrictions: ['No architectural or design claims beyond verified atmosphere evidence'],
    screenshotCases: ['desktop-place', 'mobile-place'],
  }),
  spec({
    id: 'InteriorGallery', group: 'PLACE',
    requiredContentKeys: [], optionalContentKeys: [], contentKeyPrefixes: ['atmosphere.'],
    allowedAssetCategories: ['CLINIC_INTERIOR', 'EXTERIOR', 'HERO', 'LOCATION'], maxAssets: 3,
    fallbackBehavior: 'Omitted when fewer than one approved interior asset exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Asymmetric two/three-up on desktop; single column on mobile, no horizontal scroll.',
    accessibility: ['each image has alt text', 'no hover-only reveal'],
    motion: 'GALLERY_TRANSITION', tokens: ['space.x4', 'radiusMd'],
    evidenceRestrictions: ['Approved fictional assets only; no repeated image without plan justification'],
    screenshotCases: ['desktop-gallery', 'mobile-gallery'],
  }),
  spec({
    id: 'LocationNarrative', group: 'PLACE',
    requiredContentKeys: ['location.value'], optionalContentKeys: ['hours.value', 'location.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: ['LOCATION', 'EXTERIOR'], maxAssets: 1,
    fallbackBehavior: 'Text-only narrative when no approved location asset exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Text-led band; image optional beside it on desktop.',
    accessibility: ['address as selectable text'],
    motion: 'TEXT_REVEAL', tokens: ['scale.md', 'space.x6'],
    evidenceRestrictions: ['No map embed, no travel-time or parking claims'],
    screenshotCases: ['desktop-place'],
  }),

  // ------------------------------------------------------------ EXPERIENCE
  spec({
    id: 'PatientJourneySteps', group: 'EXPERIENCE',
    requiredContentKeys: ['appointment.verified_method'], optionalContentKeys: ['contact.value', 'hours.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified appointment path exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Numbered horizontal steps on desktop; vertical on mobile.',
    accessibility: ['ordered list', 'step numbers are text, not images'],
    motion: 'STAGGERED_REVEAL', tokens: ['colors.line', 'space.x6', 'scale.base'],
    evidenceRestrictions: ['Describes only the verified contact path; no clinical steps or timelines'],
    screenshotCases: ['desktop-journey', 'mobile-journey'],
  }),
  spec({
    id: 'CalmCareStory', group: 'EXPERIENCE',
    requiredContentKeys: [], optionalContentKeys: ['appointment.verified_method'], contentKeyPrefixes: ['atmosphere.', 'trust.'],
    allowedAssetCategories: ['CLINIC_INTERIOR', 'EXTERIOR', 'TREATMENT'], maxAssets: 1,
    fallbackBehavior: 'Omitted without verified atmosphere or strength evidence.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Narrow measure text column; optional supporting image on desktop.',
    accessibility: ['readable measure ≤ 72ch', 'heading hierarchy'],
    motion: 'TEXT_REVEAL', tokens: ['narrowWidth', 'scale.md', 'space.x8'],
    evidenceRestrictions: ['No comfort or pain claims; no sedation or outcome statements'],
    screenshotCases: ['desktop-experience'],
  }),
  spec({
    id: 'AnxiousPatientSection', group: 'EXPERIENCE',
    requiredContentKeys: ['faq.anxious_patient.answer'], optionalContentKeys: ['appointment.verified_method'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted unless anxiety-support evidence is verified and accepted.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Narrow reassurance band; stacks on mobile.',
    accessibility: ['calm contrast', 'link to verified contact'],
    motion: 'NONE', tokens: ['colors.accentSoft', 'narrowWidth'],
    evidenceRestrictions: ['No sedation, pain, diagnosis, or treatment claims'],
    screenshotCases: ['desktop-experience'],
  }),

  // ----------------------------------------------------------- INFORMATION
  spec({
    id: 'LocationHoursPanel', group: 'INFORMATION',
    requiredContentKeys: [], optionalContentKeys: ['location.value', 'hours.value', 'location.heading', 'hours.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Renders whichever verified value exists; omitted when neither does.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Two columns desktop, stacked mobile.',
    accessibility: ['definition-list semantics', 'text never inside an image'],
    motion: 'NONE', tokens: ['colors.surface', 'space.x6'],
    evidenceRestrictions: ['Verbatim verified values only'],
    screenshotCases: ['desktop-info', 'mobile-info'],
  }),
  spec({
    id: 'ContactPanel', group: 'INFORMATION',
    requiredContentKeys: ['contact.value'], optionalContentKeys: ['contact.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Omitted when no verified contact value exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Single band; channels wrap on mobile.',
    accessibility: ['real tel/mailto links', 'no data collection fields'],
    motion: 'NONE', tokens: ['colors.surfaceAlt', 'space.x4'],
    evidenceRestrictions: ['No contact form collecting patient information'],
    screenshotCases: ['desktop-info'],
  }),
  spec({
    id: 'DeterministicFaqConcierge', group: 'INFORMATION',
    requiredContentKeys: ['faq.heading'], optionalContentKeys: ['appointment.verified_method', 'contact.value'],
    contentKeyPrefixes: ['faq.'], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Launcher and panel are omitted completely when no verified FAQ topic exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Floating launcher; panel is a bottom sheet on mobile that never covers the appointment bar.',
    accessibility: ['role=dialog', 'aria-modal', 'focus trap', 'Escape closes', 'focus returns to launcher', '44px targets'],
    motion: 'CONCIERGE_OPEN', tokens: ['zIndex.concierge', 'zIndex.conciergePanel', 'radiusLg', 'shadowLift'],
    evidenceRestrictions: [
      'Answers come only from the deterministic FAQ package',
      'No free-form input, no runtime model, no diagnosis, no treatment recommendation',
      'No price or availability statements; escalation only to verified channels',
    ],
    screenshotCases: ['desktop-concierge-closed', 'desktop-concierge-open', 'mobile-concierge-open'],
  }),

  // ------------------------------------------------------------ CONVERSION
  spec({
    id: 'FinalAppointmentCta', group: 'CONVERSION',
    requiredContentKeys: ['appointment.heading', 'appointment.verified_method'], optionalContentKeys: [],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Replaced by ContactFallback when no appointment method is verified.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Full-width band; button remains ≥44px on mobile.',
    accessibility: ['descriptive link text', 'AA contrast'],
    motion: 'CTA_STATE', tokens: ['colors.accent', 'colors.inkOnAccent', 'space.x12'],
    evidenceRestrictions: ['Repeats the same verified destination; adds no urgency claim'],
    screenshotCases: ['desktop-final-cta', 'mobile-final-cta'],
  }),
  spec({
    id: 'ContactFallback', group: 'CONVERSION',
    requiredContentKeys: ['contact.value'], optionalContentKeys: ['contact.heading'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Used only when no verified appointment method exists.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Full-width band.',
    accessibility: ['real link', 'AA contrast'],
    motion: 'CTA_STATE', tokens: ['colors.accentSoft', 'space.x8'],
    evidenceRestrictions: ['Verified channel only'],
    screenshotCases: ['desktop-final-cta'],
  }),

  // ---------------------------------------------------------------- FOOTER
  spec({
    id: 'PremiumClinicFooter', group: 'FOOTER',
    requiredContentKeys: ['footer.label', 'disclosure.text'],
    optionalContentKeys: ['location.value', 'hours.value', 'contact.value'],
    contentKeyPrefixes: [], allowedAssetCategories: [], maxAssets: 0,
    fallbackBehavior: 'Mandatory; renders the available verified subset.',
    supportedLanguages: ALL, rtl: 'MIRRORED',
    responsive: 'Multi-column desktop, stacked mobile.',
    accessibility: ['contentinfo landmark', 'AA contrast'],
    motion: 'NONE', tokens: ['colors.ink', 'colors.canvas', 'space.x12'],
    evidenceRestrictions: ['Repeats the concept disclosure; no legal text is invented'],
    screenshotCases: ['desktop-footer', 'mobile-footer'],
  }),
];

export const COMPONENT_BY_ID: ReadonlyMap<string, ComponentSpec> =
  new Map(COMPONENT_SPECS.map((component) => [component.id, component]));

export const COMPONENT_IDS: readonly string[] = COMPONENT_SPECS.map((component) => component.id);

/** Registry manifest entry shape shared with design-library/component-registry.v1.json. */
export const componentManifestEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  supportedDirections: z.array(z.enum(['LTR', 'RTL'])).min(1),
  contentSlots: z.array(z.string().min(1)),
});

/** Deterministic hash of the code-native specs, bound into every render. */
export function componentSpecsHash(): string {
  return demoV2Hash(COMPONENT_SPECS.map((component) => ({
    id: component.id,
    group: component.group,
    required: component.requiredContentKeys,
    optional: component.optionalContentKeys,
    prefixes: component.contentKeyPrefixes,
    assets: component.allowedAssetCategories,
    maxAssets: component.maxAssets,
    rtl: component.rtl,
    motion: component.motion,
  })));
}

export function requireComponent(id: string): ComponentSpec {
  const found = COMPONENT_BY_ID.get(id);
  if (!found) throw new Error(`demo_v2_unknown_component:${id}`);
  return found;
}
