import { escapeHtml } from './sanitize.js';
import { type DemoContent } from './demo-types.js';

/**
 * The single MVP demo template: "dental-classic". A self-contained static page — inline
 * CSS + one inline SVG motif (our own artwork), NO scripts, NO forms, NO external requests
 * (no fonts/images/trackers/cookies), a restrictive CSP, noindex/nofollow/noarchive, a
 * text-based business-name treatment (no scraped logos/photos), and a visible — but not
 * dominant — concept disclosure. Every interpolated value is HTML-escaped; hrefs are
 * pre-sanitized by the content resolver. Unknown sections are omitted (never fabricated).
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const DISCLOSURE = (name: string): string =>
  `Concept redesign for demonstration only — not affiliated with, endorsed by, or the official website of ${name}.`;

const STYLE = `
  :root{--ink:#12303a;--ink-soft:#3a5560;--teal:#0e7c86;--teal-d:#0b5f67;--mint:#e8f6f5;--accent:#12a150;--accent-d:#0f8a45;--line:#e3ebed;--bg:#ffffff;--panel:#f6fafa;}
  *{box-sizing:border-box;}
  html,body{overflow-x:hidden;}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased;}
  .brand,.hero h1,.hero p.lead,.card,.card a,.svc h3{overflow-wrap:anywhere;word-break:break-word;}
  a{color:var(--teal-d);}
  .wrap{max-width:1040px;margin:0 auto;padding:0 22px;}
  .disclaimer{background:#f2f6f7;color:var(--ink-soft);font-size:12px;text-align:center;padding:6px 12px;border-bottom:1px solid var(--line);}
  header.site{position:sticky;top:0;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.2) blur(6px);border-bottom:1px solid var(--line);z-index:5;}
  .bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;flex-wrap:wrap;}
  .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:750;color:var(--teal-d);letter-spacing:-.01em;}
  .brand svg{flex:none;}
  nav a{margin-left:20px;text-decoration:none;color:var(--ink-soft);font-size:14.5px;font-weight:600;}
  nav a:hover{color:var(--teal-d);}
  .hero{position:relative;background:radial-gradient(1200px 500px at 80% -10%,var(--mint),transparent),linear-gradient(180deg,#f4fbfa 0%,#ffffff 100%);padding:76px 0 68px;overflow:hidden;}
  .hero .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12.5px;font-weight:700;color:var(--teal);margin:0 0 12px;}
  .hero h1{font-size:46px;line-height:1.08;letter-spacing:-.025em;margin:0 0 14px;max-width:14ch;}
  .hero p.lead{font-size:19px;color:var(--ink-soft);margin:0 0 30px;max-width:46ch;}
  .actions{display:flex;gap:12px;flex-wrap:wrap;}
  .cta{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:15px 30px;border-radius:10px;font-weight:700;font-size:16.5px;box-shadow:0 8px 20px rgba(18,161,80,.24);}
  .cta:hover,.cta:focus{background:var(--accent-d);}
  .cta.secondary{background:#fff;color:var(--teal-d);border:1.5px solid var(--line);box-shadow:none;}
  .motif{position:absolute;right:-40px;bottom:-40px;opacity:.9;pointer-events:none;}
  @media(max-width:820px){.motif{display:none;}}
  section{padding:60px 0;}
  section.alt{background:var(--panel);border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
  .sec-head{max-width:52ch;margin:0 0 30px;}
  .sec-head .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;color:var(--teal);margin:0 0 8px;}
  .sec-head h2{font-size:30px;letter-spacing:-.02em;margin:0;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;}
  .svc{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 2px 10px rgba(18,48,58,.04);}
  .svc .dot{width:38px;height:38px;border-radius:10px;background:var(--mint);display:flex;align-items:center;justify-content:center;margin-bottom:14px;}
  .svc h3{font-size:17px;margin:0;}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;}
  .card .label{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft);margin-bottom:6px;font-weight:700;}
  .card .val{font-size:16px;}
  .hours{list-style:none;margin:0;padding:0;}
  .hours li{display:flex;justify-content:space-between;gap:14px;padding:4px 0;border-bottom:1px dashed var(--line);font-size:15px;}
  footer.site{background:var(--ink);color:#bcd3d7;padding:30px 0;font-size:13px;}
  footer .fbrand{color:#fff;font-weight:700;font-size:16px;margin-bottom:6px;}
  @media(max-width:640px){.hero{padding:56px 0 48px;}.hero h1{font-size:34px;}.hero p.lead{font-size:17px;}nav a{margin-left:14px;}}
`;

const TOOTH = (size: number, fill: string): string =>
  `<svg width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.6c-2.1 0-3 .9-4.6.9C5.2 3.5 3.3 5 3.3 8c0 2.2.7 3.6 1.3 6 .5 2 .8 5.4 2.2 6.6.9.8 1.7.2 2-1 .3-1.3.5-3.2 1.2-3.2s.9 1.9 1.2 3.2c.3 1.2 1.1 1.8 2 1 1.4-1.2 1.7-4.6 2.2-6.6.6-2.4 1.3-3.8 1.3-6 0-3-1.9-4.5-4.1-4.5-1.6 0-2.5-.9-4.6-.9Z" fill="${fill}"/></svg>`;

export function renderDemoHtml(content: DemoContent): string {
  const name = escapeHtml(content.businessName || 'Dental practice');
  const displayName = content.businessName || 'this business';
  const eyebrow = escapeHtml([content.city, 'Dental practice'].filter(Boolean).join(' · '));
  const ctaHref = escapeHtml(content.cta.href);
  const ctaLabel = escapeHtml(content.cta.label);
  const hasServices = content.services.length > 0;

  const navLinks: string[] = [];
  if (hasServices) navLinks.push('<a href="#services">Services</a>');
  navLinks.push('<a href="#contact">Contact</a>');

  // Secondary CTA: a direct call, only if a verified phone exists and the primary isn't already tel.
  const secondary = content.phoneTel && content.cta.kind !== 'tel'
    ? `<a class="cta secondary" href="${escapeHtml(content.phoneTel)}">Call us</a>`
    : '';

  const servicesSection = hasServices
    ? `<section id="services" class="alt"><div class="wrap">
        <div class="sec-head"><p class="eyebrow">What we offer</p><h2>Our services</h2></div>
        <div class="grid">${content.services.map((s) => `<div class="svc"><div class="dot">${TOOTH(20, '#0e7c86')}</div><h3>${escapeHtml(s)}</h3></div>`).join('')}</div>
      </div></section>`
    : '';

  const contactCards: string[] = [];
  if (content.phoneTel) contactCards.push(card('Phone', `<a href="${escapeHtml(content.phoneTel)}">${escapeHtml(content.phoneTel.replace(/^tel:/, ''))}</a>`));
  if (content.emailMailto) contactCards.push(card('Email', `<a href="${escapeHtml(content.emailMailto)}">${escapeHtml(content.emailMailto.replace(/^mailto:/, ''))}</a>`));
  if (content.address) contactCards.push(card('Address', escapeHtml(content.address)));
  if (content.officialWebsiteUrl) contactCards.push(card('Website', `<a href="${escapeHtml(content.officialWebsiteUrl)}" rel="nofollow noopener">${escapeHtml(content.officialWebsiteUrl)}</a>`));
  if (content.openingHours.length > 0) {
    const items = content.openingHours.map((h) => `<li><span>${escapeHtml(h)}</span></li>`).join('');
    contactCards.push(`<div class="card"><div class="label">Opening hours</div><ul class="hours">${items}</ul></div>`);
  }
  const contactBody = contactCards.length > 0
    ? `<div class="grid">${contactCards.join('')}</div>`
    : '<p>Contact details would appear here.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${name} — concept redesign (demo)</title>
<style>${STYLE}</style>
</head>
<body>
<div class="disclaimer">Concept demo — not the official website of ${escapeHtml(displayName)}.</div>

<header class="site"><div class="wrap bar">
  <div class="brand">${TOOTH(24, '#0e7c86')}<span>${name}</span></div>
  <nav>${navLinks.join('')}</nav>
</div></header>

<div class="hero"><div class="wrap">
  <p class="eyebrow">${eyebrow}</p>
  <h1>${name}</h1>
  <p class="lead">A clean, modern website concept — designed to make it easy for patients to find you and get in touch.</p>
  <div class="actions"><a class="cta" href="${ctaHref}">${ctaLabel}</a>${secondary}</div>
  <div class="motif">${TOOTH(240, '#dcefef')}</div>
</div></div>

${servicesSection}

<section id="contact"><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Get in touch</p><h2>Contact &amp; location</h2></div>
  ${contactBody}
</div></section>

<footer class="site"><div class="wrap">
  <div class="fbrand">${name}</div>
  ${escapeHtml(DISCLOSURE(displayName))}
</div></footer>
</body>
</html>
`;
}

function card(label: string, valueHtml: string): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="val">${valueHtml}</div></div>`;
}

/** netlify.toml with a noindex X-Robots-Tag header, prepared for the later deploy phase. */
export function renderNetlifyToml(): string {
  return `# Prepared for the later Netlify deployment phase (Phase 11). NOT deployed in Phase 8.
[[headers]]
  for = "/*"
  [headers.values]
    X-Robots-Tag = "noindex, nofollow, noarchive"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "no-referrer"
`;
}
