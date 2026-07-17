import { escapeHtml } from '../sanitize.js';
import { type DemoContent } from '../demo-types.js';
import {
  type BodyComponentId,
  type FooterComponentId,
  type HeaderComponentId,
  type HeroStrategy,
  type MessagingEmphasis,
  type VisualDirection,
} from './design-spec.js';

/**
 * Phase 8B vetted component library. Every component is an ORIGINAL, deterministic renderer
 * that emits only safe markup: values are HTML-escaped, hrefs are pre-sanitized by the
 * content resolver, there are no scripts/forms/iframes and no external resource loads. The
 * AI composer may only *select* these components — it never authors markup. Two variants per
 * section type give visual variety while keeping the surface small enough to vet by hand.
 */

export const COMPOSER_TEMPLATE_ID = 'composer-v1';
export const COMPOSER_TEMPLATE_VERSION = 'composer-tpl-1';

/** Resolved, non-fabricating CTA passed to hero / cta_band components. */
export interface ResolvedCta {
  label: string;
  href: string;
}

export interface ComponentInput {
  content: DemoContent;
  emphasis: MessagingEmphasis;
  heroStrategy: HeroStrategy;
  cta: ResolvedCta;
  /** Pre-rendered secondary "Call us" button, or '' when not applicable. */
  secondaryCtaHtml: string;
}

// --- Theme palettes (keyed by visual direction). Colors only; structure is shared. ---

const THEME_VARS: Record<VisualDirection, string> = {
  CLEAN_CLINICAL:
    '--ink:#12303a;--ink-soft:#3a5560;--brand:#0e7c86;--brand-d:#0b5f67;--tint:#e8f6f5;--accent:#12a150;--accent-d:#0f8a45;--line:#e3ebed;--bg:#ffffff;--panel:#f6fafa;--footer:#12303a;',
  WARM_WELCOMING:
    '--ink:#3a2418;--ink-soft:#6b4a37;--brand:#c2571f;--brand-d:#9c4416;--tint:#fbeee4;--accent:#d97706;--accent-d:#b45f04;--line:#efe2d7;--bg:#fffbf7;--panel:#fdf4ec;--footer:#3a2418;',
  MODERN_BOLD:
    '--ink:#1a1a2e;--ink-soft:#3d3d5c;--brand:#4f46e5;--brand-d:#3f37c9;--tint:#eceafd;--accent:#7c3aed;--accent-d:#6428d4;--line:#e5e3f2;--bg:#ffffff;--panel:#f7f6fd;--footer:#1a1a2e;',
};

/** Our own inline dental motif (no scraped logos/photos). */
const TOOTH = (size: number, fill: string): string =>
  `<svg width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.6c-2.1 0-3 .9-4.6.9C5.2 3.5 3.3 5 3.3 8c0 2.2.7 3.6 1.3 6 .5 2 .8 5.4 2.2 6.6.9.8 1.7.2 2-1 .3-1.3.5-3.2 1.2-3.2s.9 1.9 1.2 3.2c.3 1.2 1.1 1.8 2 1 1.4-1.2 1.7-4.6 2.2-6.6.6-2.4 1.3-3.8 1.3-6 0-3-1.9-4.5-4.1-4.5-1.6 0-2.5-.9-4.6-.9Z" fill="${fill}"/></svg>`;

const CHECK = (fill: string): string =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="${fill}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// --- Vetted, generic copy (never business-specific claims / stats / testimonials). ---

const HERO_LEAD: Record<MessagingEmphasis, string> = {
  CLARITY: 'A clean, modern website concept designed to make your key information easy to find at a glance.',
  TRUST: 'A professional website concept that presents your practice clearly and puts your contact details front and centre.',
  CONVENIENCE: 'A modern website concept focused on making it simple for patients to reach you and take the next step.',
  LOCAL: 'A modern website concept that helps nearby patients find you and get in touch quickly.',
  PROFESSIONALISM: 'A polished website concept that presents your practice with a clear, professional first impression.',
};

const HERO_EYEBROW: Record<HeroStrategy, string> = {
  CLARITY_FIRST: 'Clear and easy to navigate',
  TRUST_FIRST: 'A professional first impression',
  ACTION_FIRST: 'Ready when your patients are',
  LOCAL_FIRST: 'For patients in your area',
};

const TRUST_POINTS: Record<MessagingEmphasis, [string, string][]> = {
  CLARITY: [['Easy to navigate', 'Key information is organised and simple to scan.'], ['Clear next steps', 'Visitors can see how to get in touch straight away.'], ['Works on every device', 'A layout that adapts cleanly to phones and desktops.']],
  TRUST: [['A professional presence', 'A tidy, modern layout that reflects your practice well.'], ['Details up front', 'Contact and location information are easy to find.'], ['Consistent everywhere', 'The same clear experience on mobile and desktop.']],
  CONVENIENCE: [['Get in touch fast', 'A prominent way to call or contact you.'], ['Fewer steps', 'A short, direct path to booking or enquiring.'], ['Mobile-ready', 'Comfortable to use on the go.']],
  LOCAL: [['Easy to reach', 'Your location and contact details are clearly shown.'], ['Built for your area', 'Designed to help nearby patients find you.'], ['Works on any device', 'A clean experience wherever patients look.']],
  PROFESSIONALISM: [['Polished layout', 'A considered, modern visual style.'], ['Clear structure', 'Sections are ordered to guide the visitor.'], ['Reliable on mobile', 'A dependable experience on smaller screens.']],
};

const TRUST_HEAD: Record<MessagingEmphasis, string> = {
  CLARITY: 'Designed to be clear',
  TRUST: 'A presence you can rely on',
  CONVENIENCE: 'Made to be easy',
  LOCAL: 'Easy for local patients',
  PROFESSIONALISM: 'A professional impression',
};

const CTA_BAND_HEAD: Record<MessagingEmphasis, string> = {
  CLARITY: 'Everything you need, in one place',
  TRUST: 'Ready to help you get started',
  CONVENIENCE: 'Getting in touch is simple',
  LOCAL: 'Conveniently close by',
  PROFESSIONALISM: 'Get started with confidence',
};

// --- Small shared helpers ---

const ctaButton = (cta: ResolvedCta): string => `<a class="cta" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>`;

function contactCards(content: DemoContent): string[] {
  const cards: string[] = [];
  const card = (label: string, valueHtml: string): string =>
    `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="val">${valueHtml}</div></div>`;
  if (content.phoneTel) cards.push(card('Phone', `<a href="${escapeHtml(content.phoneTel)}">${escapeHtml(content.phoneTel.replace(/^tel:/, ''))}</a>`));
  if (content.emailMailto) cards.push(card('Email', `<a href="${escapeHtml(content.emailMailto)}">${escapeHtml(content.emailMailto.replace(/^mailto:/, ''))}</a>`));
  if (content.address) cards.push(card('Address', escapeHtml(content.address)));
  if (content.officialWebsiteUrl) cards.push(card('Website', `<a href="${escapeHtml(content.officialWebsiteUrl)}" rel="nofollow noopener">${escapeHtml(content.officialWebsiteUrl)}</a>`));
  if (content.openingHours.length > 0) {
    const items = content.openingHours.map((h) => `<li><span>${escapeHtml(h)}</span></li>`).join('');
    cards.push(`<div class="card"><div class="label">Opening hours</div><ul class="hours">${items}</ul></div>`);
  }
  return cards;
}

// --- Header components ---

function headerA(name: string, hasServices: boolean): string {
  const nav = [hasServices ? '<a href="#services">Services</a>' : '', '<a href="#contact">Contact</a>'].join('');
  return `<header class="site h-a"><div class="wrap bar">
    <div class="brand">${TOOTH(24, 'var(--brand)')}<span>${name}</span></div>
    <nav>${nav}</nav>
  </div></header>`;
}

function headerB(name: string, hasServices: boolean): string {
  const nav = [hasServices ? '<a href="#services">Services</a>' : '', '<a href="#contact">Contact</a>'].join('');
  return `<header class="site h-b"><div class="wrap barc">
    <div class="brand center">${TOOTH(26, 'var(--brand)')}<span>${name}</span></div>
    <nav>${nav}</nav>
  </div></header>`;
}

export const HEADERS: Record<HeaderComponentId, (name: string, hasServices: boolean) => string> = {
  'header-a': headerA,
  'header-b': headerB,
};

// --- Footer components ---

function footerA(name: string, disclosure: string): string {
  return `<footer class="site f-a"><div class="wrap">
    <div class="fbrand">${name}</div>
    ${escapeHtml(disclosure)}
  </div></footer>`;
}

function footerB(name: string, disclosure: string): string {
  return `<footer class="site f-b"><div class="wrap">
    <div class="fbrand">${TOOTH(20, 'var(--brand)')} ${name}</div>
    <p class="fnote">${escapeHtml(disclosure)}</p>
  </div></footer>`;
}

export const FOOTERS: Record<FooterComponentId, (name: string, disclosure: string) => string> = {
  'footer-a': footerA,
  'footer-b': footerB,
};

// --- Body components ---

function heroA(i: ComponentInput): string {
  const name = escapeHtml(i.content.businessName || 'Dental practice');
  const eyebrow = escapeHtml([i.content.city, HERO_EYEBROW[i.heroStrategy]].filter(Boolean).join(' · '));
  return `<div class="hero hero-a"><div class="wrap">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${name}</h1>
    <p class="lead">${escapeHtml(HERO_LEAD[i.emphasis])}</p>
    <div class="actions">${ctaButton(i.cta)}${i.secondaryCtaHtml}</div>
    <div class="motif">${TOOTH(240, 'var(--tint)')}</div>
  </div></div>`;
}

function heroB(i: ComponentInput): string {
  const name = escapeHtml(i.content.businessName || 'Dental practice');
  const eyebrow = escapeHtml([HERO_EYEBROW[i.heroStrategy], i.content.city].filter(Boolean).join(' · '));
  return `<div class="hero hero-b center"><div class="wrap">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${name}</h1>
    <p class="lead">${escapeHtml(HERO_LEAD[i.emphasis])}</p>
    <div class="actions center">${ctaButton(i.cta)}${i.secondaryCtaHtml}</div>
  </div></div>`;
}

function servicesA(i: ComponentInput): string {
  if (i.content.services.length === 0) return '';
  const cards = i.content.services
    .map((s) => `<div class="svc"><div class="dot">${TOOTH(20, 'var(--brand)')}</div><h3>${escapeHtml(s)}</h3></div>`)
    .join('');
  return `<section id="services" class="alt svc-a"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">What we offer</p><h2>Our services</h2></div>
    <div class="grid">${cards}</div>
  </div></section>`;
}

function servicesB(i: ComponentInput): string {
  if (i.content.services.length === 0) return '';
  const rows = i.content.services
    .map((s) => `<li>${CHECK('var(--brand)')}<span>${escapeHtml(s)}</span></li>`)
    .join('');
  return `<section id="services" class="svc-b"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">What we offer</p><h2>Treatments &amp; services</h2></div>
    <ul class="svc-list">${rows}</ul>
  </div></section>`;
}

function trustA(i: ComponentInput): string {
  const points = TRUST_POINTS[i.emphasis]
    .map(([h, b]) => `<div class="trust"><div class="dot">${CHECK('var(--brand)')}</div><h3>${escapeHtml(h)}</h3><p>${escapeHtml(b)}</p></div>`)
    .join('');
  return `<section class="alt trust-a"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Why this concept</p><h2>${escapeHtml(TRUST_HEAD[i.emphasis])}</h2></div>
    <div class="grid">${points}</div>
  </div></section>`;
}

function trustB(i: ComponentInput): string {
  const items = TRUST_POINTS[i.emphasis].map(([h]) => `<li>${CHECK('var(--brand)')}<span>${escapeHtml(h)}</span></li>`).join('');
  return `<section class="trust-b"><div class="wrap band">
    <div><p class="eyebrow">Why this concept</p><h2>${escapeHtml(TRUST_HEAD[i.emphasis])}</h2></div>
    <ul class="pill-list">${items}</ul>
  </div></section>`;
}

function contactA(i: ComponentInput): string {
  const cards = contactCards(i.content);
  const body = cards.length > 0 ? `<div class="grid">${cards.join('')}</div>` : '<p>Contact details would appear here.</p>';
  return `<section id="contact" class="contact-a"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Get in touch</p><h2>Contact &amp; location</h2></div>
    ${body}
  </div></section>`;
}

function contactB(i: ComponentInput): string {
  const cards = contactCards(i.content);
  const body = cards.length > 0 ? `<div class="grid two">${cards.join('')}</div>` : '<p>Contact details would appear here.</p>';
  return `<section id="contact" class="alt contact-b"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Find us</p><h2>Get in touch</h2></div>
    ${body}
    <div class="contact-cta">${ctaButton(i.cta)}</div>
  </div></section>`;
}

function ctaBandA(i: ComponentInput): string {
  return `<section class="cta-band cta-a"><div class="wrap center">
    <h2>${escapeHtml(CTA_BAND_HEAD[i.emphasis])}</h2>
    <div class="actions center">${ctaButton(i.cta)}${i.secondaryCtaHtml}</div>
  </div></section>`;
}

function ctaBandB(i: ComponentInput): string {
  return `<section class="alt cta-b"><div class="wrap"><div class="cta-panel">
    <div><h2>${escapeHtml(CTA_BAND_HEAD[i.emphasis])}</h2></div>
    <div class="actions">${ctaButton(i.cta)}${i.secondaryCtaHtml}</div>
  </div></div></section>`;
}

export const BODY_COMPONENTS: Record<BodyComponentId, (i: ComponentInput) => string> = {
  'hero-a': heroA,
  'hero-b': heroB,
  'services-a': servicesA,
  'services-b': servicesB,
  'trust-a': trustA,
  'trust-b': trustB,
  'contact-a': contactA,
  'contact-b': contactB,
  'cta-a': ctaBandA,
  'cta-b': ctaBandB,
};

// --- Shared page style (structure) + theme palette override ---

export function pageStyle(direction: VisualDirection): string {
  return `
  :root{${THEME_VARS[direction]}}
  *{box-sizing:border-box;}
  html,body{overflow-x:hidden;}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased;}
  .brand,.hero h1,.hero p.lead,.card,.card a,.svc h3,.trust h3,h2{overflow-wrap:anywhere;word-break:break-word;}
  a{color:var(--brand-d);}
  .wrap{max-width:1040px;margin:0 auto;padding:0 22px;}
  .disclaimer{background:var(--panel);color:var(--ink-soft);font-size:12px;text-align:center;padding:6px 12px;border-bottom:1px solid var(--line);}
  header.site{position:sticky;top:0;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.2) blur(6px);border-bottom:1px solid var(--line);z-index:5;}
  .bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;flex-wrap:wrap;}
  .barc{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0;}
  .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:750;color:var(--brand-d);letter-spacing:-.01em;}
  .brand.center{justify-content:center;}
  .brand svg{flex:none;}
  nav a{margin-left:20px;text-decoration:none;color:var(--ink-soft);font-size:14.5px;font-weight:600;}
  .barc nav a:first-child{margin-left:0;}
  nav a:hover{color:var(--brand-d);}
  .hero{position:relative;background:radial-gradient(1200px 500px at 80% -10%,var(--tint),transparent),linear-gradient(180deg,var(--panel) 0%,var(--bg) 100%);padding:76px 0 68px;overflow:hidden;}
  .hero.center{text-align:center;}
  .hero .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12.5px;font-weight:700;color:var(--brand);margin:0 0 12px;}
  .hero h1{font-size:46px;line-height:1.08;letter-spacing:-.025em;margin:0 0 14px;max-width:15ch;}
  .hero.center h1{max-width:100%;}
  .hero p.lead{font-size:19px;color:var(--ink-soft);margin:0 0 30px;max-width:48ch;}
  .hero.center p.lead{margin-left:auto;margin-right:auto;}
  .actions{display:flex;gap:12px;flex-wrap:wrap;}
  .actions.center{justify-content:center;}
  .cta{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:15px 30px;border-radius:10px;font-weight:700;font-size:16.5px;box-shadow:0 8px 20px rgba(0,0,0,.14);}
  .cta:hover,.cta:focus{background:var(--accent-d);}
  .cta.secondary{background:#fff;color:var(--brand-d);border:1.5px solid var(--line);box-shadow:none;}
  .motif{position:absolute;right:-40px;bottom:-40px;opacity:.9;pointer-events:none;}
  @media(max-width:820px){.motif{display:none;}}
  section{padding:60px 0;}
  section.alt{background:var(--panel);border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
  .sec-head{max-width:52ch;margin:0 0 30px;}
  .sec-head .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;color:var(--brand);margin:0 0 8px;}
  .sec-head h2{font-size:30px;letter-spacing:-.02em;margin:0;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;}
  .grid.two{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));}
  .svc,.trust{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 2px 10px rgba(0,0,0,.04);}
  .svc .dot,.trust .dot{width:38px;height:38px;border-radius:10px;background:var(--tint);display:flex;align-items:center;justify-content:center;margin-bottom:14px;}
  .svc h3,.trust h3{font-size:17px;margin:0 0 6px;}
  .trust p{margin:0;color:var(--ink-soft);font-size:15px;}
  .svc-list,.pill-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;}
  .svc-list li,.pill-list li{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:15.5px;}
  .band{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:20px;}
  .card .label{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft);margin-bottom:6px;font-weight:700;}
  .card .val{font-size:16px;}
  .hours{list-style:none;margin:0;padding:0;}
  .hours li{display:flex;justify-content:space-between;gap:14px;padding:4px 0;border-bottom:1px dashed var(--line);font-size:15px;}
  .cta-band{background:linear-gradient(180deg,var(--tint),var(--bg));text-align:center;}
  .cta-band h2{font-size:28px;letter-spacing:-.02em;margin:0 0 22px;}
  .cta-panel{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:26px 28px;}
  .cta-panel h2{font-size:24px;margin:0;letter-spacing:-.02em;}
  .contact-cta{margin-top:24px;}
  footer.site{padding:30px 0;font-size:13px;}
  footer.f-a{background:var(--footer);color:#cfe0e3;}
  footer.f-a .fbrand{color:#fff;font-weight:700;font-size:16px;margin-bottom:6px;}
  footer.f-b{background:var(--panel);color:var(--ink-soft);border-top:1px solid var(--line);}
  footer.f-b .fbrand{display:flex;align-items:center;gap:8px;color:var(--brand-d);font-weight:700;font-size:16px;margin-bottom:6px;}
  footer.f-b .fnote{margin:0;}
  @media(max-width:640px){.hero{padding:56px 0 48px;}.hero h1{font-size:34px;}.hero p.lead{font-size:17px;}nav a{margin-left:14px;}.cta-panel{flex-direction:column;align-items:flex-start;}}
  `;
}
