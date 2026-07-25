import { demoV2Hash } from '../hash.js';
import { REFERENCE_FAMILIES, type ReferenceFamily } from './design-system.js';

/**
 * Versioned, reference-family-specific typography.
 *
 * All stacks are system / `ui-serif` / `ui-sans-serif` fonts or locally-available faces — nothing
 * is downloaded and no runtime font request is made. Each family uses a materially different
 * pairing (not one universal pairing with weight changes) so the five families read as distinct
 * editorial systems. Language overrides give Hebrew and Arabic correct faces and RTL behaviour and
 * keep German/French wrapping language-aware (no destructive `break-word`/`anywhere`).
 */

export const DEMO_V2_TYPOGRAPHY_VERSION = 'demo-v2-typography-1';

export type DemoV2Language = 'de' | 'en' | 'fr' | 'he' | 'ar';

export interface FamilyTypography {
  displayFont: string;
  bodyFont: string;
  navFont: string;
  buttonFont: string;
  labelFont: string;
  weights: { display: number; heading: number; body: number; label: number; button: number };
  /** Fluid clamps already fold desktop/tablet/mobile into one responsive value. */
  scale: Record<'eyebrow' | 'label' | 'body' | 'lede' | 'h3' | 'h2' | 'h1' | 'hero', string>;
  lineHeightTight: string;
  lineHeightBody: string;
  trackingDisplay: string;
  trackingLabel: string;
  /** Maximum readable measure in ch for long-form copy. */
  maxLineCh: number;
  headingWrap: 'balance' | 'pretty';
}

const HUMANIST_SANS = "ui-sans-serif,'Optima','Candara','Segoe UI',system-ui,-apple-system,sans-serif";
const NEO_GROTESK = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const TECHNICAL_SANS = "'Helvetica Neue','Arial Nova',Arial,ui-sans-serif,system-ui,sans-serif";
const ROUNDED_SANS = "'Segoe UI','Trebuchet MS','Verdana',ui-sans-serif,system-ui,sans-serif";
const EDITORIAL_SERIF = "ui-serif,'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif";
const HIGH_CONTRAST_SERIF = "'Didot','Bodoni MT','Hoefler Text',ui-serif,'Palatino Linotype',Georgia,serif";

const FAMILY_TYPOGRAPHY: Record<ReferenceFamily, FamilyTypography> = {
  'premium-dental-editorial': {
    displayFont: EDITORIAL_SERIF, bodyFont: HUMANIST_SANS, navFont: HUMANIST_SANS, buttonFont: HUMANIST_SANS, labelFont: HUMANIST_SANS,
    weights: { display: 600, heading: 600, body: 400, label: 600, button: 600 },
    scale: {
      eyebrow: 'clamp(0.72rem,0.7rem + 0.1vw,0.78rem)', label: 'clamp(0.8rem,0.78rem + 0.1vw,0.86rem)',
      body: 'clamp(1.02rem,0.98rem + 0.2vw,1.12rem)', lede: 'clamp(1.18rem,1.08rem + 0.5vw,1.42rem)',
      h3: 'clamp(1.4rem,1.24rem + 0.7vw,1.85rem)', h2: 'clamp(1.9rem,1.55rem + 1.6vw,2.9rem)',
      h1: 'clamp(2.3rem,1.8rem + 2.4vw,3.6rem)', hero: 'clamp(2.7rem,1.95rem + 3.4vw,4.6rem)',
    },
    lineHeightTight: '1.05', lineHeightBody: '1.62', trackingDisplay: '-0.022em', trackingLabel: '0.14em',
    maxLineCh: 68, headingWrap: 'balance',
  },
  'warm-family-dental': {
    displayFont: ROUNDED_SANS, bodyFont: ROUNDED_SANS, navFont: ROUNDED_SANS, buttonFont: ROUNDED_SANS, labelFont: ROUNDED_SANS,
    weights: { display: 700, heading: 600, body: 400, label: 600, button: 700 },
    scale: {
      eyebrow: 'clamp(0.74rem,0.72rem + 0.1vw,0.8rem)', label: 'clamp(0.82rem,0.8rem + 0.1vw,0.9rem)',
      body: 'clamp(1.04rem,1rem + 0.22vw,1.14rem)', lede: 'clamp(1.16rem,1.06rem + 0.46vw,1.36rem)',
      h3: 'clamp(1.36rem,1.2rem + 0.66vw,1.75rem)', h2: 'clamp(1.75rem,1.45rem + 1.35vw,2.55rem)',
      h1: 'clamp(2.1rem,1.7rem + 2vw,3.1rem)', hero: 'clamp(2.4rem,1.85rem + 2.7vw,3.8rem)',
    },
    lineHeightTight: '1.12', lineHeightBody: '1.66', trackingDisplay: '-0.012em', trackingLabel: '0.1em',
    maxLineCh: 66, headingWrap: 'pretty',
  },
  'advanced-specialist-clinic': {
    displayFont: TECHNICAL_SANS, bodyFont: NEO_GROTESK, navFont: TECHNICAL_SANS, buttonFont: TECHNICAL_SANS, labelFont: TECHNICAL_SANS,
    weights: { display: 700, heading: 700, body: 400, label: 700, button: 600 },
    scale: {
      eyebrow: 'clamp(0.7rem,0.68rem + 0.1vw,0.76rem)', label: 'clamp(0.78rem,0.76rem + 0.1vw,0.84rem)',
      body: 'clamp(1rem,0.97rem + 0.2vw,1.1rem)', lede: 'clamp(1.14rem,1.05rem + 0.44vw,1.34rem)',
      h3: 'clamp(1.34rem,1.2rem + 0.6vw,1.7rem)', h2: 'clamp(1.8rem,1.5rem + 1.4vw,2.65rem)',
      h1: 'clamp(2.15rem,1.75rem + 2vw,3.2rem)', hero: 'clamp(2.4rem,1.9rem + 2.5vw,3.9rem)',
    },
    lineHeightTight: '1.08', lineHeightBody: '1.58', trackingDisplay: '-0.018em', trackingLabel: '0.16em',
    maxLineCh: 70, headingWrap: 'balance',
  },
  'modern-medical-minimal': {
    displayFont: NEO_GROTESK, bodyFont: NEO_GROTESK, navFont: NEO_GROTESK, buttonFont: NEO_GROTESK, labelFont: NEO_GROTESK,
    weights: { display: 600, heading: 600, body: 400, label: 500, button: 600 },
    scale: {
      eyebrow: 'clamp(0.72rem,0.7rem + 0.1vw,0.78rem)', label: 'clamp(0.8rem,0.78rem + 0.1vw,0.86rem)',
      body: 'clamp(1.02rem,0.98rem + 0.2vw,1.12rem)', lede: 'clamp(1.16rem,1.06rem + 0.48vw,1.4rem)',
      h3: 'clamp(1.35rem,1.2rem + 0.62vw,1.72rem)', h2: 'clamp(1.85rem,1.5rem + 1.5vw,2.75rem)',
      h1: 'clamp(2.25rem,1.8rem + 2.2vw,3.4rem)', hero: 'clamp(2.5rem,1.95rem + 2.7vw,4rem)',
    },
    lineHeightTight: '1.1', lineHeightBody: '1.6', trackingDisplay: '-0.02em', trackingLabel: '0.08em',
    maxLineCh: 64, headingWrap: 'balance',
  },
  'luxury-cosmetic-dental': {
    displayFont: HIGH_CONTRAST_SERIF, bodyFont: HUMANIST_SANS, navFont: HUMANIST_SANS, buttonFont: HUMANIST_SANS, labelFont: HUMANIST_SANS,
    weights: { display: 500, heading: 500, body: 400, label: 500, button: 600 },
    scale: {
      eyebrow: 'clamp(0.76rem,0.74rem + 0.1vw,0.84rem)', label: 'clamp(0.84rem,0.82rem + 0.12vw,0.92rem)',
      body: 'clamp(1.08rem,1.02rem + 0.3vw,1.22rem)', lede: 'clamp(1.22rem,1.1rem + 0.58vw,1.55rem)',
      h3: 'clamp(1.45rem,1.26rem + 0.8vw,2rem)', h2: 'clamp(2.05rem,1.6rem + 1.9vw,3.2rem)',
      h1: 'clamp(2.5rem,1.9rem + 2.7vw,4rem)', hero: 'clamp(3rem,2.1rem + 4vw,5.2rem)',
    },
    lineHeightTight: '1.05', lineHeightBody: '1.7', trackingDisplay: '-0.005em', trackingLabel: '0.18em',
    maxLineCh: 68, headingWrap: 'balance',
  },
};

/** Locally-available RTL faces; Latin families are unchanged for de/en/fr. */
const RTL_FONTS: Record<'he' | 'ar', { display: string; body: string }> = {
  he: {
    display: "'Narkisim','Frank Ruehl','David','Arial Hebrew','Segoe UI',system-ui,sans-serif",
    body: "'Arial Hebrew','Segoe UI','Rubik',system-ui,sans-serif",
  },
  ar: {
    display: "'Geeza Pro','Damascus','Arabic Typesetting','Segoe UI',system-ui,sans-serif",
    body: "'Geeza Pro','Segoe UI','Noto Naskh Arabic',system-ui,sans-serif",
  },
};

export function typographyFor(family: string): FamilyTypography {
  const key = (REFERENCE_FAMILIES as readonly string[]).includes(family)
    ? (family as ReferenceFamily) : 'modern-medical-minimal';
  return FAMILY_TYPOGRAPHY[key];
}

/**
 * Build the typography CSS for a family + language. Emitted as its own hashed <style> block by the
 * renderer. German uses `hyphens:auto` (valid break opportunities only); French disables automatic
 * hyphenation and lets long strings wrap without overflowing buttons or navigation; Hebrew/Arabic
 * swap in RTL faces. No universal `break-word`/`anywhere` is ever used.
 */
export function buildTypographyCss(family: string, language: DemoV2Language): string {
  const t = typographyFor(family);
  const rtl = language === 'he' || language === 'ar';
  const display = rtl ? RTL_FONTS[language as 'he' | 'ar'].display : t.displayFont;
  const body = rtl ? RTL_FONTS[language as 'he' | 'ar'].body : t.bodyFont;
  const hyphens = language === 'de' ? 'auto' : 'manual';

  return `:root{
--font-display:${display};--font-body:${body};--font-nav:${rtl ? body : t.navFont};
--font-button:${rtl ? body : t.buttonFont};--font-label:${rtl ? body : t.labelFont};
--fw-display:${t.weights.display};--fw-heading:${t.weights.heading};--fw-body:${t.weights.body};
--fw-label:${t.weights.label};--fw-button:${t.weights.button};
--ty-eyebrow:${t.scale.eyebrow};--ty-label:${t.scale.label};--ty-body:${t.scale.body};--ty-lede:${t.scale.lede};
--ty-h3:${t.scale.h3};--ty-h2:${t.scale.h2};--ty-h1:${t.scale.h1};--ty-hero:${t.scale.hero};
--lh-tight:${t.lineHeightTight};--lh-body:${t.lineHeightBody};
--tr-display:${t.trackingDisplay};--tr-label:${t.trackingLabel};--measure:${String(t.maxLineCh)}ch;
}
body{font-family:var(--font-body);font-weight:var(--fw-body);font-size:var(--ty-body);line-height:var(--lh-body);hyphens:${hyphens};-webkit-hyphens:${hyphens}}
h1,h2,h3{font-family:var(--font-display);line-height:var(--lh-tight);letter-spacing:var(--tr-display);text-wrap:${t.headingWrap};hyphens:manual}
h1{font-size:var(--ty-h1);font-weight:var(--fw-display)}
h2{font-size:var(--ty-h2);font-weight:var(--fw-heading)}
h3{font-size:var(--ty-h3);font-weight:var(--fw-heading)}
p{line-height:var(--lh-body)}
.dv2-hero__body h1{font-size:var(--ty-hero)}
.dv2-eyebrow{font-family:var(--font-label);font-size:var(--ty-eyebrow);font-weight:var(--fw-label);letter-spacing:var(--tr-label);text-transform:uppercase}
.dv2-lede{font-size:var(--ty-lede);max-width:var(--measure)}
.dv2-nav__links a,.dv2-nav__brand{font-family:var(--font-nav)}
.dv2-btn{font-family:var(--font-button);font-weight:var(--fw-button);text-wrap:balance}
.dv2-strip__item dt,.dv2-panel dt{font-family:var(--font-label);font-weight:var(--fw-label);letter-spacing:var(--tr-label)}
.dv2-index__name,.dv2-person__name{font-family:var(--font-display)}
${rtl ? '.dv2-wrap,.dv2-hero__body{text-align:start}.dv2-btn{letter-spacing:normal}' : ''}
/* French/long labels must never overflow controls or nav. */
.dv2-btn,.dv2-nav__links a{overflow-wrap:break-word}
`;
}

export function typographyHash(): string {
  return demoV2Hash({ version: DEMO_V2_TYPOGRAPHY_VERSION, families: FAMILY_TYPOGRAPHY, rtl: RTL_FONTS });
}
