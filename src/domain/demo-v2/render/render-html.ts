import { createHash } from 'node:crypto';
import { escapeHtml, sanitizeUrl } from '../../demo/sanitize.js';
import { compositionFor, type FamilyComposition } from './design-system.js';
import { requireComponent } from './components.js';

/**
 * Deterministic HTML generation. Every string that reaches the document is escaped, every href is
 * scheme-allow-listed, and no component ever receives or emits raw markup. Identical inputs always
 * produce byte-identical output.
 */

export interface RenderAsset {
  id: string;
  category: string;
  /** Bundle-relative path — always local, never a remote origin. */
  href: string;
  /** Native-language alt (matches the primary render's language). */
  alt: string;
  /** English descriptor used when the document language is English, so no source-language alt leaks. */
  altEnglish: string;
  width: number;
  height: number;
  focalX: number;
  focalY: number;
  contentHash: string;
}

export interface RenderFaqEntry {
  topic: string;
  question: string;
  answer: string;
  escalationTarget: string;
}

export interface RenderSection {
  order: number;
  componentId: string;
  /** Content keys the plan bound to this section. */
  contentKeys: readonly string[];
  assets: readonly RenderAsset[];
  rhythm: 'airy' | 'tight' | 'banded';
  anchor: string;
}

export interface RenderModel {
  language: string;
  direction: 'LTR' | 'RTL';
  referenceFamily: string;
  businessName: string;
  content: Readonly<Record<string, string>>;
  faq: readonly RenderFaqEntry[];
  sections: readonly RenderSection[];
  /** Present only when a complete reviewed secondary package exists. */
  alternate: { language: string; href: string; label: string } | null;
  selfLanguageLabel: string;
  labels: Readonly<Record<string, string>>;
  appointmentHref: string | null;
  contactHref: string | null;
  urgentHref: string | null;
  locationHref: string | null;
  whatsappHref: string | null;
  styleHash: string;
  scriptHash: string;
  css: string;
  script: string;
  /** Per-language typography block (family fonts + RTL faces + language-aware wrapping). */
  typographyCss: string;
}

const A = escapeHtml;

/** Reset per document in {@link renderDocument}; rendering is synchronous so this stays isolated. */
let focal = new Map<string, string>();

/** Language of the document currently rendering; set in {@link renderDocument} to localize alt text. */
let renderLanguage = '';

function text(model: RenderModel, key: string): string | null {
  const value = model.content[key];
  return value && value.trim() !== '' ? value : null;
}

function collect(model: RenderModel, prefix: string): { key: string; value: string }[] {
  return Object.keys(model.content)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => ({ key, value: model.content[key]! }))
    .filter((item) => item.value.trim() !== '');
}

/**
 * A per-render map of focal-point classes → CSS. Focal positioning is dynamic per image, so it is
 * emitted into a hashed <style> block (covered by the CSP) rather than an inline style attribute,
 * which a strict CSP without 'unsafe-hashes' would reject.
 */
function focalClass(asset: RenderAsset, focal: Map<string, string>): string {
  const x = (asset.focalX * 100).toFixed(1);
  const y = (asset.focalY * 100).toFixed(1);
  const cls = `dv2-fp-${x.replace('.', '_')}-${y.replace('.', '_')}`;
  focal.set(cls, `.${cls}{object-position:${x}% ${y}%}`);
  return cls;
}

function img(asset: RenderAsset, sizes: string, lazy: boolean, focal: Map<string, string>): string {
  const cls = focalClass(asset, focal);
  // An English document uses the approved English descriptor; every other language uses the native
  // alt. This guarantees an English render never carries a source-language alt string.
  const alt = renderLanguage === 'en' ? (asset.altEnglish || asset.alt) : asset.alt;
  return `<img src="${A(asset.href)}" alt="${A(alt)}" width="${asset.width}" height="${asset.height}"`
    + ` sizes="${A(sizes)}" class="${cls}"`
    + ` ${lazy ? 'loading="lazy" decoding="async"' : 'loading="eager" fetchpriority="high" decoding="sync"'}>`;
}

/** Priority order for the condensed FAQ preview (booking/first-visit/hours/urgent first). */
const FAQ_PREVIEW_PRIORITY = ['booking', 'first_visit', 'opening_hours', 'urgent_contact', 'locations', 'treatment_discovery'];
export const FAQ_PREVIEW_MAX = 4;

export function pickFaqPreview(entries: readonly RenderFaqEntry[]): RenderFaqEntry[] {
  const byTopic = new Map(entries.map((entry) => [entry.topic, entry]));
  const ordered: RenderFaqEntry[] = [];
  for (const topic of FAQ_PREVIEW_PRIORITY) {
    const entry = byTopic.get(topic);
    if (entry) ordered.push(entry);
  }
  for (const entry of entries) if (!ordered.includes(entry)) ordered.push(entry);
  return ordered.slice(0, FAQ_PREVIEW_MAX);
}

function anchorLinks(model: RenderModel, renderedAnchors: ReadonlySet<string>): { href: string; label: string }[] {
  const links: { href: string; label: string }[] = [];
  const rendered = renderedAnchors;
  const maybe = (key: string, anchor: string) => {
    const label = text(model, key);
    if (label && rendered.has(anchor)) links.push({ href: `#${anchor}`, label });
  };
  maybe('navigation.treatments', 'treatments');
  maybe('navigation.clinic', 'place');
  maybe('navigation.team', 'team');
  maybe('navigation.contact', 'information');
  return links;
}

function languageSwitcher(model: RenderModel): string {
  if (!model.alternate) return '';
  const current = `<a href="?lang=${A(model.language)}" aria-current="true" hreflang="${A(model.language)}"`
    + ` data-dv2-lang-link="${A(model.language)}">${A(model.selfLanguageLabel)}</a>`;
  const other = `<a href="${A(model.alternate.href)}?lang=${A(model.alternate.language)}"`
    + ` hreflang="${A(model.alternate.language)}" data-dv2-lang-link="${A(model.alternate.language)}"`
    + `>${A(model.alternate.label)}</a>`;
  return `<div class="dv2-lang" role="group" aria-label="${A(model.labels.languageGroup ?? 'Language')}">${current}${other}</div>`;
}

// ------------------------------------------------------------------ components

function conceptDisclosureBar(model: RenderModel, section: RenderSection): string {
  const value = text(model, 'disclosure.text');
  if (!value) throw new Error('demo_v2_render_missing_required_content:disclosure.text');
  return `<div id="${A(section.anchor)}" class="dv2-disclosure" role="note"`
    + ` data-dv2-component="ConceptDisclosureBar">${A(value)}</div>`;
}

function navigation(model: RenderModel, section: RenderSection, renderedAnchors: ReadonlySet<string>): string {
  const links = anchorLinks(model, renderedAnchors);
  const linkHtml = links.map((link) => `<a href="${A(link.href)}">${A(link.label)}</a>`).join('');
  const appointment = model.appointmentHref
    ? `<a class="dv2-btn" href="${A(model.appointmentHref)}">${A(text(model, 'appointment.heading') ?? model.labels.appointment ?? '')}</a>`
    : '';
  return `<header id="${A(section.anchor)}" class="dv2-nav" data-dv2-component="PremiumEditorialNavigation">`
    + `<div class="dv2-wrap dv2-wrap--wide dv2-nav__inner">`
    + `<a class="dv2-nav__brand" href="#top">${A(model.businessName)}</a>`
    + `<nav class="dv2-nav__links" aria-label="${A(model.labels.primaryNav ?? 'Primary')}">${linkHtml}${languageSwitcher(model)}${appointment}</nav>`
    + `<button class="dv2-nav__toggle" type="button" aria-expanded="false" aria-controls="dv2-mobilenav">`
    + `${A(model.labels.menu ?? 'Menu')}</button>`
    + `</div>`
    + `<div class="dv2-mobilenav" id="dv2-mobilenav" data-open="false" data-dv2-component="MobileNavigation">`
    + `<nav aria-label="${A(model.labels.mobileNav ?? 'Mobile')}">${linkHtml}</nav>`
    + `${languageSwitcher(model)}${appointment}</div>`
    + `</header>`;
}

function heroBody(model: RenderModel, includeFacts: boolean): string {
  const eyebrow = text(model, 'hero.eyebrow');
  const heading = text(model, 'hero.heading');
  if (!heading) throw new Error('demo_v2_render_missing_required_content:hero.heading');
  const facts = includeFacts
    ? [text(model, 'location.value'), text(model, 'hours.value')].filter((value): value is string => value !== null)
    : [];
  const factHtml = facts.length > 0
    ? `<p class="dv2-hero__facts">${facts.map((value) => `<span>${A(value)}</span>`).join('')}</p>` : '';
  const cta = model.appointmentHref
    ? `<p class="dv2-hero__actions"><a class="dv2-btn" href="${A(model.appointmentHref)}">`
      + `${A(text(model, 'appointment.heading') ?? model.labels.appointment ?? '')}</a></p>` : '';
  return `<div class="dv2-wrap dv2-hero__body">`
    + `${eyebrow ? `<p class="dv2-eyebrow">${A(eyebrow)}</p>` : ''}`
    + `<h1>${A(heading)}</h1>${factHtml}${cta}</div>`;
}

function hero(model: RenderModel, section: RenderSection, composition: FamilyComposition): string {
  const asset = section.assets[0] ?? null;
  const layout = asset ? composition.heroLayout : 'stacked';
  const media = asset
    ? `<div class="dv2-hero__media">${img(asset, '100vw', false, focal)}`
      + `${layout === 'full-bleed' ? '<div class="dv2-hero__overlay"></div>' : ''}</div>`
    : '';
  const includeFacts = section.componentId === 'LocationLedHero';
  const inner = layout === 'split'
    ? `<div class="dv2-wrap dv2-wrap--wide dv2-hero__split">${heroBody(model, includeFacts)}${media}</div>`
    : `${layout === 'full-bleed' ? media : ''}${heroBody(model, includeFacts)}${layout !== 'full-bleed' ? `<div class="dv2-wrap dv2-wrap--wide">${media}</div>` : ''}`;
  return `<section id="${A(section.anchor)}" class="dv2-hero dv2-hero--${A(layout)}"`
    + ` data-motion="HERO_ENTRANCE" data-dv2-component="${A(section.componentId)}">`
    + inner
    + `</section>`;
}

function appointmentDock(model: RenderModel, section: RenderSection): string {
  const heading = text(model, 'appointment.heading');
  const method = text(model, 'appointment.verified_method');
  if (!heading || !method || !model.appointmentHref) return '';
  // The verified destination is the link target, never visible label text — a raw URL as body copy
  // reads as unfinished and adds no meaning the button does not already carry.
  const methodIsUrl = /^https?:\/\//i.test(method);
  // On mobile the hero CTA + the sticky appointment bar already carry the primary action, so the
  // dock's primary appointment button is hidden below the mobile breakpoint (see .dv2-dock__primary)
  // to avoid a second adjacent full-width appointment CTA. The subordinate contact action remains.
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="tight"`
    + ` data-motion="TEXT_REVEAL" data-dv2-component="AppointmentActionDock">`
    + `<div class="dv2-wrap"><h2>${A(heading)}</h2>`
    + `${methodIsUrl ? '' : `<p class="dv2-lede">${A(method)}</p>`}`
    + `<p class="dv2-hero__actions"><a class="dv2-btn dv2-dock__primary" href="${A(model.appointmentHref)}">${A(heading)}</a>`
    + `${model.contactHref ? `<a class="dv2-btn dv2-btn--ghost" href="${A(model.contactHref)}">${A(text(model, 'contact.heading') ?? model.labels.contact ?? '')}</a>` : ''}`
    + `</p></div></section>`;
}

function trustStrip(model: RenderModel, section: RenderSection): string {
  const items: { label: string; value: string }[] = [];
  for (const entry of collect(model, 'trust.')) items.push({ label: model.labels.verified ?? '', value: entry.value });
  const hours = text(model, 'hours.value');
  const location = text(model, 'location.value');
  if (hours) items.push({ label: text(model, 'hours.heading') ?? '', value: hours });
  if (location) items.push({ label: text(model, 'location.heading') ?? '', value: location });
  if (items.length === 0) return '';
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="tight"`
    + ` data-motion="TEXT_REVEAL" data-dv2-component="${A(section.componentId)}">`
    + `<dl class="dv2-wrap dv2-wrap--wide dv2-strip">`
    + items.slice(0, 3).map((item) =>
      `<div class="dv2-strip__item"><dt>${A(item.label)}</dt><dd>${A(item.value)}</dd></div>`).join('')
    + `</dl></section>`;
}

function treatments(model: RenderModel, section: RenderSection): string {
  const list = collect(model, 'treatments.');
  if (list.length === 0) return '';
  const heading = text(model, 'navigation.treatments') ?? model.labels.treatments ?? '';
  if (section.componentId === 'TreatmentSpotlight') {
    const [lead, ...rest] = list;
    // TreatmentSpotlight may place one approved TREATMENT/EQUIPMENT asset; when present it renders
    // beside the spotlight copy so a reserved treatment image is actually shown in context (never
    // reserved-but-dropped).
    const asset = section.assets[0];
    const body = `<div><h2>${A(heading)}</h2>`
      + `<p class="dv2-spotlight__lead">${A(lead!.value)}</p>`
      + `<ul class="dv2-index">${rest.map((item, index) =>
        `<li><span class="dv2-index__num">${String(index + 2).padStart(2, '0')}</span>`
        + `<span class="dv2-index__name">${A(item.value)}</span></li>`).join('')}</ul></div>`;
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
      + ` data-motion="${asset ? 'IMAGE_REVEAL' : 'TEXT_REVEAL'}" data-dv2-component="TreatmentSpotlight">`
      + `<div class="dv2-wrap${asset ? ' dv2-wrap--wide dv2-story' : ''}">`
      + `${asset ? `<figure>${img(asset, '(min-width:768px) 45vw, 100vw', true, focal)}</figure>` : ''}${body}`
      + `</div></section>`;
  }
  const grouped = section.componentId === 'GroupedTreatmentDiscovery';
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
    + ` data-motion="STAGGERED_REVEAL" data-dv2-component="${A(section.componentId)}">`
    + `<div class="dv2-wrap"><h2>${A(heading)}</h2>`
    + `<ol class="dv2-index">${list.map((item, index) =>
      `<li><span class="dv2-index__num">${grouped ? '—' : String(index + 1).padStart(2, '0')}</span>`
      + `<span class="dv2-index__name">${A(item.value)}</span></li>`).join('')}</ol>`
    + `</div></section>`;
}

function people(model: RenderModel, section: RenderSection): string {
  const list = collect(model, 'team.');
  if (list.length === 0) return '';
  const heading = text(model, 'navigation.team') ?? model.labels.team ?? '';
  // DoctorFeature is a single editorial feature (portrait beside name/role), never a lone card
  // stranded in a multi-column grid. It is content-driven and fails closed to a polished text-only
  // feature when no approved, hash-verified portrait exists — it never renders a blank asset box.
  if (section.componentId === 'DoctorFeature') {
    const person = list[0]!;
    const asset = section.assets[0];
    // A TEAM group photograph reads as a wide editorial frame; a single DOCTOR portrait keeps the
    // taller portrait crop. Either way the verified name/role sit beside (desktop) or below (mobile).
    const isGroup = asset?.category === 'TEAM';
    const comma = person.value.indexOf(',');
    const name = comma === -1 ? person.value : person.value.slice(0, comma).trim();
    const role = comma === -1 ? '' : person.value.slice(comma + 1).trim();
    const body = `<div class="dv2-feature__body"><h2>${A(heading)}</h2>`
      + `<p class="dv2-person__name">${A(name)}</p>`
      + `${role ? `<p class="dv2-person__role">${A(role)}</p>` : ''}</div>`;
    const modifier = asset ? (isGroup ? ' dv2-feature--group' : '') : ' dv2-feature--text';
    const sizes = isGroup ? '(min-width:768px) 46vw, 100vw' : '(min-width:768px) 40vw, 100vw';
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
      + ` data-motion="${asset ? 'IMAGE_REVEAL' : 'TEXT_REVEAL'}" data-dv2-component="DoctorFeature">`
      + `<div class="dv2-wrap dv2-wrap--wide dv2-feature${modifier}">`
      + `${asset ? `<figure class="dv2-feature__portrait">${img(asset, sizes, true, focal)}</figure>` : ''}`
      + `${body}</div></section>`;
  }
  const assets = section.assets.slice(0, 2);
  const rail = section.componentId === 'SpecialistPortraitRail';
  const cards = list.slice(0, 4).map((item, index) => {
    const asset = assets[index];
    return `<article class="dv2-person">`
      + `${asset ? `<figure>${img(asset, '(min-width:768px) 33vw, 100vw', true, focal)}</figure>` : ''}`
      + `<p class="dv2-person__name">${A(item.value)}</p></article>`;
  }).join('');
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
    + ` data-motion="STAGGERED_REVEAL" data-dv2-component="${A(section.componentId)}">`
    + `<div class="dv2-wrap dv2-wrap--wide"><h2>${A(heading)}</h2>`
    + `<div class="dv2-people${rail ? ' dv2-people--rail' : ''}">${cards}</div></div></section>`;
}

function place(model: RenderModel, section: RenderSection): string {
  const atmosphere = collect(model, 'atmosphere.');
  const heading = text(model, 'navigation.clinic') ?? model.labels.clinic ?? '';
  if (section.componentId === 'InteriorGallery') {
    if (section.assets.length === 0) return '';
    // With only one or two approved clinic assets the asymmetric 2fr/1fr gallery grid leaves empty
    // cells that detach the heading from its image. Collapse to a content-driven feature layout
    // (single wide image, or a balanced pair) so the heading and imagery stay visually connected.
    const shots = section.assets.slice(0, 3);
    const feature = shots.length <= 2;
    const galleryClass = feature
      ? `dv2-gallery dv2-gallery--feature${shots.length === 2 ? ' dv2-gallery--pair' : ''}`
      : 'dv2-gallery';
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
      + ` data-motion="GALLERY_TRANSITION" data-dv2-component="InteriorGallery">`
      + `<div class="dv2-wrap dv2-wrap--wide"><h2>${A(heading)}</h2>`
      + `<div class="${galleryClass}">${shots.map((asset) =>
        `<figure>${img(asset, feature ? '(min-width:768px) 84rem, 100vw' : '(min-width:768px) 50vw, 100vw', true, focal)}</figure>`).join('')}</div>`
      + `</div></section>`;
  }
  if (section.componentId === 'LocationNarrative') {
    const location = text(model, 'location.value');
    if (!location) return '';
    const asset = section.assets[0];
    const copy = `<div><h2>${A(heading)}</h2><p class="dv2-lede">${A(location)}</p>`
      + `${text(model, 'hours.value') ? `<p class="dv2-lede">${A(text(model, 'hours.value')!)}</p>` : ''}`
      + `${atmosphere.map((item) => `<p class="dv2-lede">${A(item.value)}</p>`).join('')}</div>`;
    // Image-led when an approved location/exterior asset exists; otherwise a text narrative.
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
      + ` data-motion="IMAGE_REVEAL" data-dv2-component="LocationNarrative">`
      + `<div class="dv2-wrap dv2-wrap--wide${asset ? ' dv2-story dv2-story--reverse' : ''}">`
      + `${asset ? `<figure>${img(asset, '(min-width:768px) 45vw, 100vw', true, focal)}</figure>` : ''}${copy}`
      + `</div></section>`;
  }
  if (section.assets.length === 0 && atmosphere.length === 0) return '';
  const asset = section.assets[0];
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
    + ` data-motion="IMAGE_REVEAL" data-dv2-component="ArchitectureStory">`
    + `<div class="dv2-wrap dv2-wrap--wide dv2-story">`
    + `${asset ? `<figure>${img(asset, '(min-width:768px) 55vw, 100vw', true, focal)}</figure>` : ''}`
    + `<div><h2>${A(heading)}</h2>${atmosphere.map((item) =>
      `<p class="dv2-lede">${A(item.value)}</p>`).join('')}</div></div></section>`;
}

function experience(model: RenderModel, section: RenderSection): string {
  // Story and journey are distinct sections and must not share a heading.
  const heading = section.componentId === 'PatientJourneySteps'
    ? model.labels.journey ?? ''
    : model.labels.story ?? model.labels.clinic ?? '';
  if (section.componentId === 'PatientJourneySteps') {
    const method = text(model, 'appointment.verified_method');
    if (!method) return '';
    // A raw URL is never step copy; the verified destination is reachable via the CTA.
    const first = /^https?:\/\//i.test(method) ? (text(model, 'appointment.heading') ?? model.labels.appointment ?? '') : method;
    const steps = [first, text(model, 'hours.value'), text(model, 'contact.value')]
      .filter((value): value is string => value !== null && value !== '');
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
      + ` data-motion="STAGGERED_REVEAL" data-dv2-component="PatientJourneySteps">`
      + `<div class="dv2-wrap"><h2>${A(heading)}</h2>`
      + `<ol class="dv2-journey">${steps.map((step, index) =>
        `<li><span class="dv2-journey__num">${index + 1}</span><span>${A(step)}</span></li>`).join('')}</ol>`
      + `</div></section>`;
  }
  if (section.componentId === 'AnxiousPatientSection') {
    const answer = text(model, 'faq.anxious_patient.answer');
    if (!answer) return '';
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="tight"`
      + ` data-dv2-component="AnxiousPatientSection">`
      + `<div class="dv2-wrap dv2-wrap--narrow"><h2>${A(text(model, 'faq.anxious_patient.question') ?? heading)}</h2>`
      + `<p class="dv2-lede">${A(answer)}</p></div></section>`;
  }
  const atmosphere = collect(model, 'atmosphere.');
  const strengths = collect(model, 'trust.');
  const body = [...atmosphere, ...strengths];
  const asset = section.assets[0];
  if (body.length === 0 && !asset) return '';
  const copy = `<div><h2>${A(heading)}</h2>`
    + `${body.slice(0, 3).map((item) => `<p class="dv2-lede">${A(item.value)}</p>`).join('')}</div>`;
  // Image-led clinic story when approved interior/team imagery exists (offset editorial layout).
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
    + ` data-motion="IMAGE_REVEAL" data-dv2-component="CalmCareStory">`
    + `<div class="dv2-wrap${asset ? ' dv2-wrap--wide dv2-story' : ' dv2-wrap--narrow'}">`
    + `${asset ? `<figure>${img(asset, '(min-width:768px) 50vw, 100vw', true, focal)}</figure>` : ''}${copy}`
    + `</div></section>`;
}

function informationPanel(model: RenderModel, section: RenderSection): string {
  const rows: { label: string; value: string; href: string | null }[] = [];
  const push = (labelKey: string, valueKey: string, href: string | null) => {
    const value = text(model, valueKey);
    if (value) rows.push({ label: text(model, labelKey) ?? '', value, href });
  };
  push('location.heading', 'location.value', model.locationHref);
  push('hours.heading', 'hours.value', null);
  push('contact.heading', 'contact.value', model.contactHref);
  if (rows.length === 0) return '';
  return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="${A(section.rhythm)}"`
    + ` data-dv2-component="${A(section.componentId)}">`
    + `<div class="dv2-wrap"><dl class="dv2-panel">${rows.map((row) =>
      `<div><dt>${A(row.label)}</dt><dd>${row.href
        ? `<a href="${A(row.href)}">${A(row.value)}</a>` : A(row.value)}</dd></div>`).join('')}</dl></div></section>`;
}

function finalCta(model: RenderModel, section: RenderSection): string {
  if (section.componentId === 'ContactFallback') {
    const contact = text(model, 'contact.value');
    if (!contact || !model.contactHref) return '';
    return `<section id="${A(section.anchor)}" class="dv2-section dv2-cta" data-dv2-component="ContactFallback">`
      + `<div class="dv2-wrap"><h2>${A(text(model, 'contact.heading') ?? '')}</h2>`
      + `<a class="dv2-btn" href="${A(model.contactHref)}">${A(contact)}</a></div></section>`;
  }
  const heading = text(model, 'appointment.heading');
  if (!heading || !model.appointmentHref) return '';
  const method = text(model, 'appointment.verified_method');
  const label = method && !/^https?:\/\//i.test(method) ? method : heading;
  return `<section id="${A(section.anchor)}" class="dv2-section dv2-cta" data-dv2-component="FinalAppointmentCta">`
    + `<div class="dv2-wrap"><h2>${A(heading)}</h2>`
    + `<a class="dv2-btn" href="${A(model.appointmentHref)}">${A(label)}</a>`
    + `</div></section>`;
}

function footer(model: RenderModel, section: RenderSection): string {
  const label = text(model, 'footer.label');
  const disclosure = text(model, 'disclosure.text');
  if (!label || !disclosure) throw new Error('demo_v2_render_missing_required_content:footer');
  const columns = [
    { key: 'location.value', head: text(model, 'location.heading') },
    { key: 'hours.value', head: text(model, 'hours.heading') },
    { key: 'contact.value', head: text(model, 'contact.heading') },
  ].map((column) => {
    const value = text(model, column.key);
    return value ? `<div><p class="dv2-eyebrow">${A(column.head ?? '')}</p><p>${A(value)}</p></div>` : '';
  }).join('');
  return `<footer id="${A(section.anchor)}" class="dv2-footer" data-dv2-component="PremiumClinicFooter">`
    + `<div class="dv2-wrap dv2-wrap--wide"><p class="dv2-eyebrow">${A(label)}</p>`
    + `<div class="dv2-footer__grid">${columns}</div>`
    + `<p class="dv2-footer__note">${A(disclosure)}</p></div></footer>`;
}

function mobileAppointmentBar(model: RenderModel): string {
  if (!model.appointmentHref) return '';
  const label = text(model, 'appointment.heading') ?? model.labels.appointment ?? '';
  return `<div class="dv2-mobilebar" data-dv2-component="MobileAppointmentBar">`
    + `<a class="dv2-btn" href="${A(model.appointmentHref)}">${A(label)}</a></div>`;
}

function concierge(model: RenderModel): string {
  if (model.faq.length === 0) return '';
  const heading = text(model, 'faq.heading') ?? model.labels.faq ?? '';
  const escalations: string[] = [];
  const addEscalation = (href: string | null, label: string) => {
    const safe = href ? sanitizeUrl(href) : null;
    if (safe) escalations.push(`<a href="${A(safe)}">${A(label)}</a>`);
  };
  const targets = new Set(model.faq.map((entry) => entry.escalationTarget));
  if (targets.has('APPOINTMENT')) addEscalation(model.appointmentHref, model.labels.appointment ?? '');
  if (targets.has('PHONE') || targets.has('EMAIL')) addEscalation(model.contactHref, model.labels.contact ?? '');
  if (targets.has('WHATSAPP')) addEscalation(model.whatsappHref, model.labels.whatsapp ?? '');
  if (targets.has('LOCATION_PAGE')) addEscalation(model.locationHref, model.labels.location ?? '');

  const island = JSON.stringify({
    entries: model.faq.map((entry) => ({ topic: entry.topic, question: entry.question, answer: entry.answer })),
  }).replace(/</g, '\\u003c');

  return `<button class="dv2-concierge__launcher" type="button" aria-expanded="false"`
    + ` aria-controls="dv2-concierge" data-dv2-component="DeterministicFaqConcierge">${A(heading)}</button>`
    + `<div class="dv2-concierge__panel" id="dv2-concierge" data-open="false" role="dialog" aria-modal="true"`
    + ` aria-labelledby="dv2-concierge-title">`
    + `<div class="dv2-concierge__head"><h2 class="dv2-concierge__title" id="dv2-concierge-title">${A(heading)}</h2>`
    + `<button class="dv2-concierge__close" type="button">${A(model.labels.close ?? 'Close')}</button></div>`
    + `<div class="dv2-concierge__log" aria-live="polite"></div>`
    + `<div class="dv2-concierge__suggestions">${model.faq.map((entry) =>
      `<button class="dv2-concierge__suggestion" type="button" data-dv2-topic="${A(entry.topic)}">`
      + `${A(entry.question)}</button>`).join('')}</div>`
    + `${escalations.length > 0 ? `<div class="dv2-concierge__escalate">${escalations.join('')}</div>` : ''}`
    + `<p class="dv2-concierge__note">${A(model.labels.conciergeNote ?? '')}</p>`
    + `</div>`
    + `<script type="application/json" id="dv2-faq-data">${island}</script>`;
}

const RENDERERS: Record<string, (model: RenderModel, section: RenderSection, composition: FamilyComposition) => string> = {
  ConceptDisclosureBar: (model, section) => conceptDisclosureBar(model, section),
  // Navigation is rendered in a second pass once the real anchor set is known.
  PremiumEditorialNavigation: () => '',
  ArchitectureImageHero: hero, EditorialSplitHero: hero, CalmCareHero: hero, LocationLedHero: hero,
  AppointmentActionDock: (model, section) => appointmentDock(model, section),
  ContactChoicePanel: (model, section) => informationPanel(model, section),
  SpecialistTrustStrip: (model, section) => trustStrip(model, section),
  VerifiedHoursStrip: (model, section) => trustStrip(model, section),
  LocationProofStrip: (model, section) => trustStrip(model, section),
  EditorialTreatmentIndex: (model, section) => treatments(model, section),
  GroupedTreatmentDiscovery: (model, section) => treatments(model, section),
  TreatmentSpotlight: (model, section) => treatments(model, section),
  SpecialistPortraitRail: (model, section) => people(model, section),
  TeamEditorialGrid: (model, section) => people(model, section),
  DoctorFeature: (model, section) => people(model, section),
  ArchitectureStory: (model, section) => place(model, section),
  InteriorGallery: (model, section) => place(model, section),
  LocationNarrative: (model, section) => place(model, section),
  PatientJourneySteps: (model, section) => experience(model, section),
  CalmCareStory: (model, section) => experience(model, section),
  AnxiousPatientSection: (model, section) => experience(model, section),
  LocationHoursPanel: (model, section) => informationPanel(model, section),
  ContactPanel: (model, section) => informationPanel(model, section),
  // Condensed FAQ PREVIEW: only the 3-4 highest-value verified topics render inline; every other
  // verified question stays available inside the floating concierge (added globally). This avoids
  // the dense FAQ wall while preserving access to all verified content.
  DeterministicFaqConcierge: (model, section) => {
    if (model.faq.length === 0) return '';
    const heading = text(model, 'faq.heading') ?? model.labels.faq ?? '';
    const preview = pickFaqPreview(model.faq);
    const remaining = model.faq.length - preview.length;
    const more = remaining > 0
      ? `<p class="dv2-faq__more">${A((model.labels.faqMore ?? '{n} more in the assistant').replace('{n}', String(remaining)))}</p>`
      : '';
    return `<section id="${A(section.anchor)}" class="dv2-section" data-rhythm="tight"`
      + ` data-motion="TEXT_REVEAL" data-dv2-component="DeterministicFaqConcierge">`
      + `<div class="dv2-wrap"><h2>${A(heading)}</h2>`
      + `<dl class="dv2-faq">${preview.map((entry) =>
        `<div class="dv2-faq__item"><dt>${A(entry.question)}</dt><dd>${A(entry.answer)}</dd></div>`).join('')}</dl>`
      + `${more}</div></section>`;
  },
  FinalAppointmentCta: (model, section) => finalCta(model, section),
  ContactFallback: (model, section) => finalCta(model, section),
  PremiumClinicFooter: (model, section) => footer(model, section),
};

/**
 * A deliberately plain rendering of the SAME verified content, used only as the fictional
 * "current site" baseline in an operator review package. It is not a depiction of any real
 * website and is never published.
 */
export function renderFictionalBaseline(model: RenderModel): string {
  const rows = ['hero.heading', 'location.value', 'hours.value', 'contact.value', 'appointment.verified_method']
    .map((key) => {
      const value = text(model, key);
      return value ? `<p>${A(value)}</p>` : '';
    }).join('');
  const treatments = collect(model, 'treatments.')
    .map((item) => `<li>${A(item.value)}</li>`).join('');
  return `<!doctype html>
<html lang="${A(model.language)}" dir="${model.direction === 'RTL' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${A(model.businessName)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:16px;color:#222;line-height:1.5}
h1{font-size:22px;margin:0 0 12px}ul{padding-inline-start:20px}p{margin:0 0 8px}
.baseline-note{background:#eee;padding:6px;font-size:12px;margin-bottom:12px}</style></head>
<body><p class="baseline-note">${A(model.labels.baselineNote ?? 'Fictional baseline of the current site (concept demo).')}</p>
<h1>${A(model.businessName)}</h1>${rows}<ul>${treatments}</ul></body></html>`;
}

export function renderDocument(model: RenderModel): string {
  const composition = compositionFor(model.referenceFamily);
  focal = new Map<string, string>();
  renderLanguage = model.language;
  // Pass 1: render every section except navigation, so we learn which anchors actually exist.
  const parts = model.sections.map((section) => {
    requireComponent(section.componentId);
    const renderer = RENDERERS[section.componentId];
    if (!renderer) throw new Error(`demo_v2_render_unsupported_component:${section.componentId}`);
    return { section, html: renderer(model, section, composition) };
  });
  const renderedAnchors = new Set(
    parts.filter((part) => part.html.trim() !== '').map((part) => part.section.anchor),
  );
  // Pass 2: navigation links only to sections that genuinely rendered.
  const body = parts.map((part) => (part.section.componentId === 'PremiumEditorialNavigation'
    ? navigation(model, part.section, renderedAnchors)
    : part.html)).join('');

  // Per-image focal positioning lives in a second hashed <style> block (deterministic order) so
  // the strict CSP needs no 'unsafe-hashes' or inline style attributes.
  const focalCss = [...focal.keys()].sort().map((key) => focal.get(key)!).join('');
  const focalHash = createHash('sha256').update(focalCss, 'utf8').digest('base64');
  const typographyHash = createHash('sha256').update(model.typographyCss, 'utf8').digest('base64');

  // `frame-ancestors` is intentionally omitted: it is ignored when delivered via <meta> and only
  // emits a console warning. Framing protection belongs in an HTTP header at serve time.
  const csp = [
    "default-src 'none'",
    "img-src 'self'",
    `style-src 'sha256-${model.styleHash}' 'sha256-${typographyHash}' 'sha256-${focalHash}'`,
    `script-src 'sha256-${model.scriptHash}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const alternate = model.alternate
    ? `<link rel="alternate" hreflang="${A(model.alternate.language)}" href="${A(model.alternate.href)}"`
      + ` data-dv2-lang="${A(model.alternate.language)}">` : '';

  return `<!doctype html>
<html lang="${A(model.language)}" dir="${model.direction === 'RTL' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${A(csp)}">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${A(model.businessName)}</title>
${alternate}
<style>${model.css}</style>
<style>${model.typographyCss}</style>
<style>${focalCss}</style>
</head>
<body id="top"${model.appointmentHref ? ' data-mobilebar="true"' : ''}>
<a class="dv2-skip" href="#main">${A(model.labels.skip ?? 'Skip to content')}</a>
<main id="main">${body}</main>
${mobileAppointmentBar(model)}
${concierge(model)}
<script>${model.script}</script>
</body>
</html>`;
}
