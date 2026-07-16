import { escapeHtml } from './sanitize.js';
import { type DemoContent } from './demo-types.js';

/**
 * The single MVP demo template: "dental-classic". A self-contained static page — inline
 * CSS only, NO scripts, NO forms, NO external requests (no fonts/images/trackers/cookies),
 * a restrictive CSP, noindex/nofollow/noarchive, a text-based business-name treatment
 * (no scraped logos/photos), and a visible concept-demo disclosure. Every interpolated
 * value is HTML-escaped; hrefs are pre-sanitized by the content resolver.
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const DISCLOSURE = (name: string): string =>
  `This is an independent concept redesign created for demonstration purposes only. It is not affiliated with, endorsed by, or the official website of ${name}.`;

const STYLE = `
  :root { --ink:#12303a; --teal:#0e7c86; --teal-dark:#0b5f67; --accent:#12a150; --muted:#5b6b70; --bg:#f6f9fa; }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body { margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); line-height:1.55; }
  .brand, .hero h1, .hero p.sub, .card, .card a { overflow-wrap:anywhere; word-break:break-word; }
  a { color: var(--teal-dark); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
  header.site { background:#fff; border-bottom:1px solid #e3ebed; }
  .bar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 0; flex-wrap:wrap; }
  .brand { font-size:22px; font-weight:700; color:var(--teal-dark); letter-spacing:-0.01em; }
  nav a { margin-left:18px; text-decoration:none; color:var(--muted); font-size:14px; }
  .hero { background:linear-gradient(135deg,#e8f4f5 0%,#dceef0 100%); padding:64px 0; }
  .hero h1 { font-size:38px; margin:0 0 8px; letter-spacing:-0.02em; }
  .hero p.sub { font-size:18px; color:var(--muted); margin:0 0 28px; }
  .cta { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:14px 26px; border-radius:8px; font-weight:600; font-size:17px; }
  .cta:focus, .cta:hover { background:#0f8a45; }
  section { padding:48px 0; }
  section h2 { font-size:24px; margin:0 0 16px; }
  .contact-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .card { background:#fff; border:1px solid #e3ebed; border-radius:10px; padding:18px; }
  .card .label { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:4px; }
  footer.site { background:var(--ink); color:#cfe0e3; padding:28px 0; font-size:13px; }
  .disclosure { background:#fff8e1; border:1px solid #f0e3b0; color:#5a4b1a; padding:12px 16px; border-radius:8px; margin:0 0 18px; font-size:13px; }
  @media (max-width:640px){ .hero h1{font-size:30px;} nav a{margin-left:12px;} }
`;

export function renderDemoHtml(content: DemoContent): string {
  const name = escapeHtml(content.businessName || 'Dental practice');
  const cityBit = content.city ? `${escapeHtml(content.city)} · ` : '';
  const ctaHref = escapeHtml(content.cta.href);
  const ctaLabel = escapeHtml(content.cta.label);

  const contactCards: string[] = [];
  if (content.phoneTel) contactCards.push(card('Phone', `<a href="${escapeHtml(content.phoneTel)}">${escapeHtml(content.phoneTel.replace(/^tel:/, ''))}</a>`));
  if (content.emailMailto) contactCards.push(card('Email', `<a href="${escapeHtml(content.emailMailto)}">${escapeHtml(content.emailMailto.replace(/^mailto:/, ''))}</a>`));
  if (content.address) contactCards.push(card('Address', escapeHtml(content.address)));
  if (content.officialWebsiteUrl) contactCards.push(card('Website', `<a href="${escapeHtml(content.officialWebsiteUrl)}" rel="nofollow noopener">${escapeHtml(content.officialWebsiteUrl)}</a>`));

  const contactSection =
    contactCards.length > 0
      ? `<section id="contact"><div class="wrap"><h2>Get in touch</h2><div class="contact-grid">${contactCards.join('')}</div></div></section>`
      : `<section id="contact"><div class="wrap"><h2>Get in touch</h2><p>Contact details would appear here.</p></div></section>`;

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
<header class="site"><div class="wrap bar">
  <div class="brand">${name}</div>
  <nav><a href="#contact">Contact</a></nav>
</div></header>

<div class="hero"><div class="wrap">
  <p class="disclosure">Concept demo — ${escapeHtml(DISCLOSURE(content.businessName || 'this business'))}</p>
  <h1>${name}</h1>
  <p class="sub">${cityBit}Dental practice</p>
  <a class="cta" href="${ctaHref}">${ctaLabel}</a>
</div></div>

${contactSection}

<footer class="site"><div class="wrap">
  ${escapeHtml(DISCLOSURE(content.businessName || 'this business'))}
</div></footer>
</body>
</html>
`;
}

function card(label: string, valueHtml: string): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div>${valueHtml}</div></div>`;
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
