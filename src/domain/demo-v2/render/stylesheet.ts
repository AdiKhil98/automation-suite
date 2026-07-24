import { compositionFor, tokensFor, Z_INDEX, type DesignTokens } from './design-system.js';

/**
 * Deterministic stylesheet generation. All styling derives from tokens; no component contributes
 * CSS and no model can inject any. Layout uses logical properties so RTL mirrors without a second
 * stylesheet, and every motion preset degrades to "no movement, all content" under
 * prefers-reduced-motion.
 */

function tokenBlock(t: DesignTokens): string {
  return `:root{
--font-display:${t.fontDisplay};--font-body:${t.fontBody};
--fs-xs:${t.scale.xs};--fs-sm:${t.scale.sm};--fs-base:${t.scale.base};--fs-md:${t.scale.md};--fs-lg:${t.scale.lg};--fs-xl:${t.scale.xl};--fs-display:${t.scale.display};
--lh-tight:${t.lineHeightTight};--lh-body:${t.lineHeightBody};--ls-display:${t.letterSpacingDisplay};
--s1:${t.space.x1};--s2:${t.space.x2};--s3:${t.space.x3};--s4:${t.space.x4};--s6:${t.space.x6};--s8:${t.space.x8};--s12:${t.space.x12};--s16:${t.space.x16};--s24:${t.space.x24};
--section:${t.sectionSpacing};--section-tight:${t.sectionSpacingTight};
--w-content:${t.contentWidth};--w-wide:${t.wideWidth};--w-narrow:${t.narrowWidth};
--c-canvas:${t.colors.canvas};--c-surface:${t.colors.surface};--c-surface-alt:${t.colors.surfaceAlt};
--c-ink:${t.colors.ink};--c-ink-muted:${t.colors.inkMuted};--c-ink-on-accent:${t.colors.inkOnAccent};
--c-accent:${t.colors.accent};--c-accent-soft:${t.colors.accentSoft};--c-line:${t.colors.line};--c-focus:${t.colors.focus};--c-overlay:${t.colors.overlay};
--r-sm:${t.radiusSm};--r-md:${t.radiusMd};--r-lg:${t.radiusLg};
--sh-soft:${t.shadowSoft};--sh-lift:${t.shadowLift};--overlay-strength:${t.overlayStrength};
--m-fast:${t.motionFast};--m-base:${t.motionBase};--m-slow:${t.motionSlow};--ease:${t.easing};
--z-sticky:${Z_INDEX.sticky};--z-concierge:${Z_INDEX.concierge};--z-concierge-panel:${Z_INDEX.conciergePanel};--z-mobile-bar:${Z_INDEX.mobileBar};--z-skip:${Z_INDEX.skipLink};
}`;
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--c-canvas);color:var(--c-ink);font-family:var(--font-body);font-size:var(--fs-base);line-height:var(--lh-body);overflow-x:hidden}
img{max-width:100%;height:auto;display:block}
a{color:inherit}
h1,h2,h3{font-family:var(--font-display);line-height:var(--lh-tight);letter-spacing:var(--ls-display);margin:0;text-wrap:balance}
h1{font-size:var(--fs-display)}h2{font-size:var(--fs-xl)}h3{font-size:var(--fs-lg)}
p{margin:0;overflow-wrap:break-word;hyphens:manual}
ul,ol{margin:0;padding:0;list-style:none}
:focus-visible{outline:3px solid var(--c-focus);outline-offset:3px}
.dv2-wrap{width:min(100% - 2.5rem,var(--w-content));margin-inline:auto}
.dv2-wrap--wide{width:min(100% - 2rem,var(--w-wide))}
.dv2-wrap--narrow{width:min(100% - 2.5rem,var(--w-narrow))}
.dv2-section{padding-block:var(--section)}
.dv2-section[data-rhythm=tight]{padding-block:var(--section-tight)}
.dv2-section[data-rhythm=banded]{padding-block:var(--section);background:var(--c-surface-alt)}
.dv2-eyebrow{font-size:var(--fs-xs);letter-spacing:.14em;text-transform:uppercase;color:var(--c-ink-muted);margin:0 0 var(--s2)}
.dv2-lede{color:var(--c-ink-muted);font-size:var(--fs-md);max-width:60ch}
.dv2-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dv2-skip{position:absolute;inset-inline-start:var(--s3);inset-block-start:-4rem;z-index:var(--z-skip);background:var(--c-accent);color:var(--c-ink-on-accent);padding:var(--s2) var(--s3);border-radius:var(--r-sm);transition:inset-block-start var(--m-fast) var(--ease)}
.dv2-skip:focus{inset-block-start:var(--s3)}
.dv2-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:44px;padding:.75rem 1.35rem;background:var(--c-accent);color:var(--c-ink-on-accent);text-decoration:none;border-radius:var(--r-md);font-weight:600;font-size:var(--fs-sm);border:1px solid transparent;transition:transform var(--m-fast) var(--ease),background-color var(--m-fast) var(--ease)}
.dv2-btn:hover{transform:translateY(-1px)}
.dv2-btn--ghost{background:transparent;color:var(--c-accent);border-color:var(--c-accent)}
.dv2-disclosure{background:var(--c-accent-soft);color:var(--c-ink);font-size:var(--fs-xs);padding:var(--s2) var(--s3);text-align:center}
/* --- navigation --- */
.dv2-nav{position:sticky;top:0;z-index:var(--z-sticky);background:color-mix(in srgb,var(--c-surface) 92%,transparent);backdrop-filter:none;border-bottom:1px solid var(--c-line);transition:box-shadow var(--m-base) var(--ease)}
.dv2-nav__inner{display:flex;align-items:center;justify-content:space-between;gap:var(--s4);padding-block:var(--s3)}
.dv2-nav__brand{font-family:var(--font-display);font-size:var(--fs-md);text-decoration:none}
.dv2-nav__links{display:flex;gap:var(--s4);align-items:center}
.dv2-nav__links a{font-size:var(--fs-sm);text-decoration:none;color:var(--c-ink-muted)}
.dv2-nav__links a:hover{color:var(--c-ink)}
.dv2-lang{display:inline-flex;gap:.25rem;align-items:center;font-size:var(--fs-xs)}
.dv2-lang a{text-decoration:none;padding:.35rem .5rem;min-height:32px;display:inline-flex;align-items:center;border-radius:var(--r-sm);color:var(--c-ink-muted)}
.dv2-lang a[aria-current=true]{background:var(--c-accent);color:var(--c-ink-on-accent);font-weight:700}
.dv2-nav__toggle{display:none;min-height:44px;min-width:44px;align-items:center;justify-content:center;background:transparent;border:1px solid var(--c-line);border-radius:var(--r-sm);font-size:var(--fs-sm);cursor:pointer;color:var(--c-ink)}
.dv2-mobilenav{display:none;position:fixed;inset:0;z-index:var(--z-sticky);background:var(--c-surface);padding:var(--s6) var(--s4);flex-direction:column;gap:var(--s4);overflow-y:auto}
.dv2-mobilenav[data-open=true]{display:flex}
.dv2-mobilenav a{font-size:var(--fs-md);text-decoration:none;min-height:44px;display:flex;align-items:center;border-bottom:1px solid var(--c-line)}
/* --- hero --- */
.dv2-hero{position:relative;isolation:isolate}
.dv2-hero__media{position:relative;overflow:hidden}
.dv2-hero__media img{width:100%;height:100%;object-fit:cover}
.dv2-hero__overlay{position:absolute;inset:0;background:var(--c-overlay)}
.dv2-hero--full{min-height:min(78vh,680px);display:grid}
.dv2-hero--full .dv2-hero__media{position:absolute;inset:0}
.dv2-hero--full .dv2-hero__body{position:relative;align-self:end;padding-block:var(--s12);color:#fff}
.dv2-hero--full .dv2-hero__body .dv2-eyebrow{color:rgba(255,255,255,.82)}
.dv2-hero--split{padding-block:var(--s12)}
.dv2-hero__split{display:grid;gap:var(--s8);align-items:center}
.dv2-hero--split .dv2-hero__media{aspect-ratio:16/10;border-radius:var(--r-lg)}
.dv2-hero--split .dv2-hero__body{width:auto;margin-inline:0;padding:0}
.dv2-hero--framed{padding-block:var(--s12)}
.dv2-hero--framed .dv2-hero__media{aspect-ratio:16/9;border-radius:var(--r-lg);margin-block-start:var(--s8)}
.dv2-hero--stacked{padding-block:var(--s12);background:var(--c-surface-alt)}
.dv2-hero--stacked .dv2-hero__media{aspect-ratio:21/9;margin-block-start:var(--s6);border-radius:var(--r-md)}
.dv2-hero__facts{display:flex;flex-wrap:wrap;gap:var(--s4);margin-block-start:var(--s4);font-size:var(--fs-sm);color:var(--c-ink-muted)}
.dv2-hero__actions{display:flex;flex-wrap:wrap;gap:var(--s2);margin-block-start:var(--s6)}
/* --- generic bands --- */
.dv2-strip{display:grid;gap:var(--s4);padding-block:var(--s6)}
.dv2-strip__item{border-inline-start:2px solid var(--c-accent);padding-inline-start:var(--s3)}
.dv2-strip__item dt{font-size:var(--fs-xs);letter-spacing:.1em;text-transform:uppercase;color:var(--c-ink-muted)}
.dv2-strip__item dd{margin:.25rem 0 0;font-size:var(--fs-base)}
.dv2-index{display:grid;gap:0;margin-block-start:var(--s6)}
.dv2-index li{display:flex;gap:var(--s4);align-items:baseline;padding-block:var(--s3);border-block-end:1px solid var(--c-line)}
.dv2-index__num{font-family:var(--font-display);font-size:var(--fs-sm);color:var(--c-ink-muted);min-width:2.5ch}
.dv2-index__name{font-size:var(--fs-md)}
.dv2-spotlight__lead{font-size:var(--fs-lg);font-family:var(--font-display);padding-block:var(--s4);border-block-end:2px solid var(--c-accent)}
.dv2-people{display:grid;gap:var(--s6);margin-block-start:var(--s6)}
.dv2-person figure{margin:0}
.dv2-person img{aspect-ratio:4/5;object-fit:cover;border-radius:var(--r-md);width:100%}
.dv2-person__name{margin-block-start:var(--s2);font-size:var(--fs-base)}
.dv2-gallery{display:grid;gap:var(--s3);margin-block-start:var(--s6)}
.dv2-gallery img{width:100%;object-fit:cover;border-radius:var(--r-md)}
.dv2-gallery figure{margin:0}
.dv2-gallery figure:first-child img{aspect-ratio:16/10}
.dv2-gallery figure+figure img{aspect-ratio:4/3}
.dv2-story{display:grid;gap:var(--s6);align-items:center}
.dv2-story img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:var(--r-md)}
.dv2-journey{display:grid;gap:var(--s4);margin-block-start:var(--s6);counter-reset:step}
.dv2-journey li{display:flex;gap:var(--s3);align-items:flex-start;padding-inline-start:0}
.dv2-journey__num{font-family:var(--font-display);color:var(--c-accent);font-size:var(--fs-md);min-width:2ch}
.dv2-panel{display:grid;gap:var(--s4);background:var(--c-surface);padding:var(--s6);border:1px solid var(--c-line);border-radius:var(--r-md)}
.dv2-panel dt{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.1em;color:var(--c-ink-muted)}
.dv2-panel dd{margin:.25rem 0 0}
.dv2-cta{background:var(--c-accent);color:var(--c-ink-on-accent);text-align:center}
.dv2-cta h2{color:var(--c-ink-on-accent)}
.dv2-cta .dv2-btn{background:var(--c-ink-on-accent);color:var(--c-accent);margin-block-start:var(--s4)}
.dv2-footer{background:var(--c-ink);color:var(--c-canvas);padding-block:var(--s12)}
.dv2-footer a{color:var(--c-canvas)}
.dv2-footer__grid{display:grid;gap:var(--s6)}
.dv2-footer__note{margin-block-start:var(--s6);padding-block-start:var(--s4);border-block-start:1px solid rgba(255,255,255,.18);font-size:var(--fs-xs);color:rgba(255,255,255,.78)}
/* --- mobile appointment bar --- */
.dv2-mobilebar{display:none;position:fixed;inset-inline:0;inset-block-end:0;z-index:var(--z-mobile-bar);background:var(--c-surface);border-block-start:1px solid var(--c-line);padding:var(--s2) var(--s3);box-shadow:var(--sh-lift)}
.dv2-mobilebar .dv2-btn{width:100%}
/* --- FAQ concierge --- */
.dv2-concierge__launcher{position:fixed;inset-inline-end:var(--s3);inset-block-end:var(--s3);z-index:var(--z-concierge);min-height:52px;min-width:52px;padding:0 var(--s4);border-radius:999px;background:var(--c-accent);color:var(--c-ink-on-accent);border:none;font-size:var(--fs-sm);font-weight:600;cursor:pointer;box-shadow:var(--sh-lift);display:inline-flex;align-items:center;gap:.5rem;transition:transform var(--m-fast) var(--ease)}
.dv2-concierge__launcher:hover{transform:translateY(-2px)}
.dv2-concierge__panel{position:fixed;inset-inline-end:var(--s3);inset-block-end:calc(var(--s3) + 64px);z-index:var(--z-concierge-panel);width:min(380px,calc(100vw - 2rem));max-height:min(70vh,540px);background:var(--c-surface);border:1px solid var(--c-line);border-radius:var(--r-lg);box-shadow:var(--sh-lift);display:none;flex-direction:column;overflow:hidden}
.dv2-concierge__panel[data-open=true]{display:flex}
.dv2-concierge__head{display:flex;align-items:center;justify-content:space-between;gap:var(--s2);padding:var(--s3);border-block-end:1px solid var(--c-line)}
.dv2-concierge__title{font-size:var(--fs-sm);font-weight:700;margin:0}
.dv2-concierge__close{min-height:44px;min-width:44px;border:1px solid var(--c-line);background:transparent;border-radius:var(--r-sm);cursor:pointer;font-size:var(--fs-sm);color:var(--c-ink)}
.dv2-concierge__log{padding:var(--s3);overflow-y:auto;display:flex;flex-direction:column;gap:var(--s2);flex:1}
.dv2-concierge__msg{max-width:88%;padding:.6rem .8rem;border-radius:var(--r-md);font-size:var(--fs-sm)}
.dv2-concierge__msg--q{align-self:flex-end;background:var(--c-accent);color:var(--c-ink-on-accent)}
.dv2-concierge__msg--a{align-self:flex-start;background:var(--c-surface-alt);color:var(--c-ink)}
.dv2-concierge__suggestions{display:flex;flex-wrap:wrap;gap:.4rem;padding:var(--s3);border-block-start:1px solid var(--c-line)}
.dv2-concierge__suggestion{min-height:40px;padding:.4rem .7rem;border:1px solid var(--c-line);background:var(--c-surface);border-radius:999px;font-size:var(--fs-xs);cursor:pointer;color:var(--c-ink);text-align:start}
.dv2-concierge__escalate{display:flex;flex-wrap:wrap;gap:.4rem;padding:0 var(--s3) var(--s3)}
.dv2-concierge__escalate a{font-size:var(--fs-xs);text-decoration:underline;min-height:40px;display:inline-flex;align-items:center}
.dv2-concierge__note{padding:0 var(--s3) var(--s3);font-size:var(--fs-xs);color:var(--c-ink-muted)}
`;

const RESPONSIVE_CSS = `
@media (min-width:768px){
.dv2-strip{grid-template-columns:repeat(3,1fr)}
.dv2-people{grid-template-columns:repeat(2,1fr)}
.dv2-gallery{grid-template-columns:2fr 1fr}
.dv2-gallery figure:first-child{grid-row:span 2}
.dv2-story{grid-template-columns:1.1fr .9fr}
.dv2-footer__grid{grid-template-columns:repeat(3,1fr)}
.dv2-panel{grid-template-columns:repeat(2,1fr)}
.dv2-journey{grid-template-columns:repeat(3,1fr)}
}
@media (min-width:1024px){
.dv2-hero__split{grid-template-columns:1.05fr .95fr}
.dv2-hero--split .dv2-hero__media{aspect-ratio:4/5}
.dv2-index{grid-template-columns:repeat(2,3fr);column-gap:var(--s8)}
.dv2-people--rail{grid-template-columns:repeat(3,1fr)}
}
@media (max-width:1023.98px){
.dv2-nav__links{display:none}
.dv2-nav__toggle{display:inline-flex}
.dv2-mobilebar{display:block}
body[data-mobilebar=true]{padding-block-end:76px}
.dv2-concierge__launcher{inset-block-end:84px}
.dv2-concierge__panel{inset-block-end:148px;inset-inline:var(--s3);width:auto;max-height:min(60vh,460px)}
}
@media (max-width:520px){
.dv2-hero--full{min-height:auto}
.dv2-hero--full .dv2-hero__media{position:relative;aspect-ratio:4/5}
.dv2-hero--full .dv2-hero__body{color:var(--c-ink);padding-block:var(--s6)}
.dv2-hero--full .dv2-hero__body .dv2-eyebrow{color:var(--c-ink-muted)}
.dv2-hero--full .dv2-hero__overlay{display:none}
}
[dir=rtl] .dv2-index__num,[dir=rtl] .dv2-journey__num{text-align:end}
`;

const MOTION_CSS = `
@media (prefers-reduced-motion:no-preference){
[data-motion=HERO_ENTRANCE] .dv2-hero__body{animation:dv2-rise var(--m-slow) var(--ease) both}
[data-motion=TEXT_REVEAL] > *{animation:dv2-fade var(--m-base) var(--ease) both}
[data-motion=IMAGE_REVEAL] img{animation:dv2-fade var(--m-slow) var(--ease) both}
[data-motion=STAGGERED_REVEAL] li{animation:dv2-rise var(--m-base) var(--ease) both}
[data-motion=STAGGERED_REVEAL] li:nth-child(2){animation-delay:60ms}
[data-motion=STAGGERED_REVEAL] li:nth-child(3){animation-delay:120ms}
[data-motion=STAGGERED_REVEAL] li:nth-child(4){animation-delay:180ms}
[data-motion=STAGGERED_REVEAL] li:nth-child(n+5){animation-delay:240ms}
[data-motion=GALLERY_TRANSITION] figure{animation:dv2-fade var(--m-slow) var(--ease) both}
.dv2-nav[data-scrolled=true]{box-shadow:var(--sh-soft)}
.dv2-concierge__panel[data-open=true]{animation:dv2-rise var(--m-base) var(--ease) both}
.dv2-mobilenav[data-open=true]{animation:dv2-fade var(--m-fast) var(--ease) both}
}
@keyframes dv2-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes dv2-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:1ms !important;animation-iteration-count:1 !important;transition-duration:1ms !important;scroll-behavior:auto !important}
.dv2-btn:hover,.dv2-concierge__launcher:hover{transform:none}
}
`;

/** Deterministic full stylesheet for a reference family. */
export function buildStylesheet(referenceFamily: string): string {
  const tokens = tokensFor(referenceFamily);
  const composition = compositionFor(referenceFamily);
  const familyHint = `/* family:${referenceFamily} hero:${composition.heroLayout} */`;
  return [familyHint, tokenBlock(tokens), BASE_CSS, RESPONSIVE_CSS, MOTION_CSS]
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
