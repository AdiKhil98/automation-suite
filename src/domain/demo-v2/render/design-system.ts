/**
 * Code-native design system for the Demo V2 renderer.
 *
 * Tokens are the ONLY styling vocabulary available to components: no component emits raw CSS and
 * no model contributes styles. Each reference family selects a different composition strategy
 * (layout rhythm, hero treatment, type scale, section ordering emphasis) so the five families are
 * visibly distinct rather than recolours of one template.
 */

export const DEMO_V2_DESIGN_SYSTEM_VERSION = 'demo-v2-design-system-1';

export const REFERENCE_FAMILIES = [
  'premium-dental-editorial',
  'warm-family-dental',
  'advanced-specialist-clinic',
  'modern-medical-minimal',
  'luxury-cosmetic-dental',
] as const;
export type ReferenceFamily = (typeof REFERENCE_FAMILIES)[number];

export interface DesignTokens {
  fontDisplay: string;
  fontBody: string;
  /** Fluid type scale, smallest → largest. */
  scale: Record<'xs' | 'sm' | 'base' | 'md' | 'lg' | 'xl' | 'display', string>;
  lineHeightTight: string;
  lineHeightBody: string;
  letterSpacingDisplay: string;
  /** Spacing rhythm (8px base, non-linear at the top for editorial breathing room). */
  space: Record<'x1' | 'x2' | 'x3' | 'x4' | 'x6' | 'x8' | 'x12' | 'x16' | 'x24', string>;
  sectionSpacing: string;
  sectionSpacingTight: string;
  contentWidth: string;
  wideWidth: string;
  narrowWidth: string;
  colors: Record<
    | 'canvas' | 'surface' | 'surfaceAlt' | 'ink' | 'inkMuted' | 'inkOnAccent'
    | 'accent' | 'accentSoft' | 'line' | 'focus' | 'overlay',
    string
  >;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  shadowSoft: string;
  shadowLift: string;
  overlayStrength: string;
  motionFast: string;
  motionBase: string;
  motionSlow: string;
  easing: string;
}

export interface FamilyComposition {
  /** Hero component this family prefers when an image is available. */
  heroVariant: 'ArchitectureImageHero' | 'EditorialSplitHero' | 'CalmCareHero' | 'LocationLedHero';
  treatmentVariant: 'EditorialTreatmentIndex' | 'GroupedTreatmentDiscovery' | 'TreatmentSpotlight';
  peopleVariant: 'SpecialistPortraitRail' | 'TeamEditorialGrid' | 'DoctorFeature';
  placeVariant: 'ArchitectureStory' | 'InteriorGallery' | 'LocationNarrative';
  experienceVariant: 'PatientJourneySteps' | 'CalmCareStory' | 'AnxiousPatientSection';
  trustVariant: 'SpecialistTrustStrip' | 'VerifiedHoursStrip' | 'LocationProofStrip';
  /** Alternating section rhythm so no family repeats an identical cadence. */
  rhythm: readonly ('airy' | 'tight' | 'banded')[];
  heroLayout: 'full-bleed' | 'split' | 'framed' | 'stacked';
}

const BASE: DesignTokens = {
  fontDisplay: "'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif",
  fontBody: "system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  scale: {
    xs: 'clamp(0.75rem,0.72rem + 0.15vw,0.82rem)',
    sm: 'clamp(0.87rem,0.84rem + 0.18vw,0.95rem)',
    base: 'clamp(1rem,0.96rem + 0.22vw,1.09rem)',
    md: 'clamp(1.19rem,1.1rem + 0.42vw,1.4rem)',
    lg: 'clamp(1.5rem,1.32rem + 0.85vw,2.05rem)',
    xl: 'clamp(2rem,1.66rem + 1.6vw,3rem)',
    display: 'clamp(2.6rem,1.95rem + 2.9vw,4.4rem)',
  },
  lineHeightTight: '1.08',
  lineHeightBody: '1.62',
  letterSpacingDisplay: '-0.021em',
  space: {
    x1: '0.5rem', x2: '0.75rem', x3: '1rem', x4: '1.5rem', x6: '2rem',
    x8: '3rem', x12: '4.5rem', x16: '6rem', x24: '9rem',
  },
  sectionSpacing: 'clamp(4rem,3rem + 4vw,7.5rem)',
  sectionSpacingTight: 'clamp(2.5rem,2rem + 2vw,4rem)',
  contentWidth: '68rem',
  wideWidth: '84rem',
  narrowWidth: '44rem',
  colors: {
    canvas: '#fbfaf8', surface: '#ffffff', surfaceAlt: '#f2efea',
    ink: '#1b1d21', inkMuted: '#585d66', inkOnAccent: '#ffffff',
    accent: '#1f4b45', accentSoft: '#e4ece9', line: '#ddd8d0',
    focus: '#8a5a20', overlay: 'rgba(18,22,25,0.46)',
  },
  radiusSm: '3px', radiusMd: '6px', radiusLg: '10px',
  shadowSoft: '0 1px 2px rgba(20,22,26,0.06), 0 8px 24px -18px rgba(20,22,26,0.4)',
  shadowLift: '0 2px 6px rgba(20,22,26,0.08), 0 22px 48px -28px rgba(20,22,26,0.45)',
  overlayStrength: '0.46',
  motionFast: '140ms', motionBase: '260ms', motionSlow: '420ms',
  easing: 'cubic-bezier(0.22,0.61,0.36,1)',
};

const FAMILY_TOKENS: Record<ReferenceFamily, Partial<DesignTokens>> = {
  'premium-dental-editorial': {
    colors: { ...BASE.colors, canvas: '#fbfaf8', surfaceAlt: '#efece6', accent: '#1f4b45', accentSoft: '#e2ebe8', focus: '#8a5a20' },
    contentWidth: '70rem', letterSpacingDisplay: '-0.024em', radiusSm: '2px', radiusMd: '4px', radiusLg: '6px',
  },
  'warm-family-dental': {
    fontDisplay: "'Segoe UI Semibold','Trebuchet MS',system-ui,sans-serif",
    colors: { ...BASE.colors, canvas: '#fffaf4', surfaceAlt: '#fdf0e2', accent: '#a8542a', accentSoft: '#fbe6d5', ink: '#2a2320', inkMuted: '#6a5c53', focus: '#2f6f63', overlay: 'rgba(58,34,20,0.4)' },
    radiusSm: '8px', radiusMd: '14px', radiusLg: '22px', overlayStrength: '0.4',
    sectionSpacing: 'clamp(3.5rem,2.8rem + 3vw,6rem)',
  },
  'advanced-specialist-clinic': {
    fontDisplay: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    colors: { ...BASE.colors, canvas: '#f7f9fb', surface: '#ffffff', surfaceAlt: '#e9eff5', accent: '#134b7a', accentSoft: '#dde9f3', ink: '#12181f', inkMuted: '#4c5866', line: '#d3dde6', focus: '#0f6d63', overlay: 'rgba(10,24,38,0.5)' },
    radiusSm: '2px', radiusMd: '4px', radiusLg: '6px', contentWidth: '72rem', letterSpacingDisplay: '-0.018em',
  },
  'modern-medical-minimal': {
    fontDisplay: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    colors: { ...BASE.colors, canvas: '#ffffff', surface: '#ffffff', surfaceAlt: '#f4f5f6', accent: '#26312c', accentSoft: '#e8eae9', ink: '#15181a', inkMuted: '#5b6166', line: '#e3e5e7', focus: '#1f6f5c', overlay: 'rgba(16,20,22,0.42)' },
    radiusSm: '0px', radiusMd: '0px', radiusLg: '2px', contentWidth: '62rem',
    sectionSpacing: 'clamp(3.25rem,2.6rem + 2.6vw,5.5rem)', shadowSoft: 'none', shadowLift: '0 1px 0 rgba(20,22,26,0.08)',
  },
  'luxury-cosmetic-dental': {
    fontDisplay: "'Didot','Bodoni MT','Iowan Old Style',Georgia,serif",
    // inkMuted darkened from #6a5f54 for AA-comfortable muted copy on the warm canvas.
    colors: { ...BASE.colors, canvas: '#f7f4f1', surface: '#ffffff', surfaceAlt: '#ece5de', accent: '#6d5333', accentSoft: '#efe6d9', ink: '#1e1a17', inkMuted: '#574d42', line: '#ddd2c5', focus: '#3f5d54', overlay: 'rgba(30,22,16,0.5)' },
    radiusSm: '1px', radiusMd: '2px', radiusLg: '3px', contentWidth: '74rem',
    // Moderate whitespace: keeps editorial airiness but removes the unfinished ~9rem gaps.
    letterSpacingDisplay: '-0.008em', sectionSpacing: 'clamp(3.5rem,2.8rem + 3vw,6rem)', overlayStrength: '0.5',
  },
};

export const FAMILY_COMPOSITION: Record<ReferenceFamily, FamilyComposition> = {
  'premium-dental-editorial': {
    heroVariant: 'ArchitectureImageHero', treatmentVariant: 'EditorialTreatmentIndex',
    peopleVariant: 'TeamEditorialGrid', placeVariant: 'ArchitectureStory',
    experienceVariant: 'PatientJourneySteps', trustVariant: 'VerifiedHoursStrip',
    rhythm: ['airy', 'banded', 'airy', 'tight'], heroLayout: 'full-bleed',
  },
  'warm-family-dental': {
    heroVariant: 'CalmCareHero', treatmentVariant: 'GroupedTreatmentDiscovery',
    peopleVariant: 'TeamEditorialGrid', placeVariant: 'InteriorGallery',
    experienceVariant: 'CalmCareStory', trustVariant: 'LocationProofStrip',
    rhythm: ['tight', 'airy', 'tight', 'banded'], heroLayout: 'split',
  },
  'advanced-specialist-clinic': {
    heroVariant: 'EditorialSplitHero', treatmentVariant: 'GroupedTreatmentDiscovery',
    peopleVariant: 'SpecialistPortraitRail', placeVariant: 'LocationNarrative',
    experienceVariant: 'PatientJourneySteps', trustVariant: 'SpecialistTrustStrip',
    rhythm: ['tight', 'tight', 'banded', 'airy'], heroLayout: 'split',
  },
  'modern-medical-minimal': {
    heroVariant: 'LocationLedHero', treatmentVariant: 'TreatmentSpotlight',
    peopleVariant: 'DoctorFeature', placeVariant: 'LocationNarrative',
    experienceVariant: 'PatientJourneySteps', trustVariant: 'VerifiedHoursStrip',
    rhythm: ['tight', 'tight', 'tight', 'airy'], heroLayout: 'stacked',
  },
  'luxury-cosmetic-dental': {
    heroVariant: 'ArchitectureImageHero', treatmentVariant: 'TreatmentSpotlight',
    peopleVariant: 'DoctorFeature', placeVariant: 'InteriorGallery',
    experienceVariant: 'CalmCareStory', trustVariant: 'LocationProofStrip',
    rhythm: ['airy', 'airy', 'banded', 'airy'], heroLayout: 'framed',
  },
};

export function tokensFor(family: string): DesignTokens {
  const key = (REFERENCE_FAMILIES as readonly string[]).includes(family)
    ? (family as ReferenceFamily) : 'modern-medical-minimal';
  return { ...BASE, ...FAMILY_TOKENS[key] };
}

export function compositionFor(family: string): FamilyComposition {
  const key = (REFERENCE_FAMILIES as readonly string[]).includes(family)
    ? (family as ReferenceFamily) : 'modern-medical-minimal';
  return FAMILY_COMPOSITION[key];
}

export const BREAKPOINTS = { mobile: 390, tablet: 1024, desktop: 1440 } as const;
export const VIEWPORTS = {
  DESKTOP: { width: 1440, height: 1000 },
  TABLET: { width: 1024, height: 1366 },
  MOBILE: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** z-index roles — the concierge must never sit above the mobile appointment bar. */
export const Z_INDEX = {
  base: '0', sticky: '20', mobileBar: '40', concierge: '30', conciergePanel: '35', skipLink: '60',
} as const;
