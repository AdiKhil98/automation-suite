import { describe, expect, it } from 'vitest';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';
import { buildDemo } from '../../src/domain/demo/demo-builder.js';
import { buildDemoBrief } from '../../src/domain/demo/demo-brief.js';
import { resolveDemoContent } from '../../src/domain/demo/demo-content.js';
import { decideDemo } from '../../src/domain/demo/demo-decision.js';
import { validateDemoContent, validateRenderedHtml } from '../../src/domain/demo/demo-validation.js';
import { renderDemoHtml } from '../../src/domain/demo/template.js';
import { escapeHtml, safePathSegment, sanitizeUrl, telHref } from '../../src/domain/demo/sanitize.js';

let n = 0;
function fact(factType: string, value: string, extra: Partial<LeadFact> = {}): LeadFact {
  n += 1;
  return {
    id: `f-${n}`, leadId: 'lead-1', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
    sourceType: 'manual', sourceUrl: null, capturedAt: new Date(), confidence: 1,
    supersededBy: null, supersededAt: null, isCurrent: true, ...extra,
  };
}
const baseFacts = (): LeadFact[] => [
  fact('business_name', 'Zahnärzte am Ufer'),
  fact('city', 'Berlin'),
  fact('official_website_url', 'https://zahnaerzte-am-ufer.de/'),
];
const finding = (id: string, category: string, safe = true) => ({ id, findingRef: id, category: category as never, safeForOutreach: safe });

describe('sanitize', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;');
  });
  it('allows only http(s)/tel/mailto and rejects dangerous schemes', () => {
    expect(sanitizeUrl('https://x.example/')).toBe('https://x.example/');
    expect(sanitizeUrl('tel:+49 30 123-456')).toBe('tel:+4930123456');
    expect(sanitizeUrl('mailto:a@b.de')).toBe('mailto:a@b.de');
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html,x')).toBeNull();
    expect(sanitizeUrl('//evil.example')).toBeNull();
    expect(sanitizeUrl('  javascript:alert(1)')).toBeNull();
  });
  it('builds tel hrefs only from usable numbers', () => {
    expect(telHref('+49 30 123456')).toBe('tel:+4930123456');
    expect(telHref('not-a-number')).toBeNull();
  });
  it('rejects path traversal in path segments', () => {
    expect(safePathSegment('abc-123')).toBe('abc-123');
    expect(() => safePathSegment('../etc')).not.toThrow(); // becomes 'etc' after stripping
    expect(safePathSegment('../etc')).toBe('etc');
    expect(() => safePathSegment('..')).toThrow();
    expect(() => safePathSegment('/')).toThrow();
  });
});

describe('decideDemo (amendment 1)', () => {
  const cfg = { minOpportunityForDemo: 35 };
  it('builds on a low score when a demonstrable outreach-safe finding exists (Gate A: score 10)', () => {
    const d = decideDemo({ opportunityScore: 10, findings: [finding('F1', 'CTA_CLARITY')], facts: baseFacts() }, cfg);
    expect(d.kind).toBe('BUILD_DEMO');
    expect(d.justifiedByFinding).toBe(true);
    expect(d.justifiedByScore).toBe(false);
  });
  it('builds on a high score even without demonstrable findings', () => {
    const d = decideDemo({ opportunityScore: 60, findings: [], facts: baseFacts() }, cfg);
    expect(d.kind).toBe('BUILD_DEMO');
    expect(d.justifiedByScore).toBe(true);
  });
  it('NO_DEMO when not justified (low score, no demonstrable finding)', () => {
    const d = decideDemo({ opportunityScore: 5, findings: [], facts: baseFacts() }, cfg);
    expect(d.outcome).toBe('NO_DEMO_NOT_JUSTIFIED');
  });
  it('NO_DEMO when facts are insufficient', () => {
    const d = decideDemo({ opportunityScore: 90, findings: [finding('F1', 'CTA_CLARITY')], facts: [fact('business_name', 'X')] }, cfg);
    expect(d.outcome).toBe('NO_DEMO_INSUFFICIENT_FACTS');
  });
  it('ignores non-outreach-safe findings for justification', () => {
    const d = decideDemo({ opportunityScore: 5, findings: [finding('F1', 'CTA_CLARITY', false)], facts: baseFacts() }, cfg);
    expect(d.kind).toBe('NO_DEMO');
  });
});

describe('buildDemoBrief', () => {
  it('maps findings to directives with relational provenance', () => {
    const brief = buildDemoBrief([finding('F1', 'BOOKING_FRICTION'), finding('F2', 'SERVICE_CLARITY')]);
    expect(brief.directives).toContain('PROMINENT_CTA');
    expect(brief.directives).toContain('SERVICES_SECTION');
    expect(brief.findingInputs.map((f) => f.findingId).sort()).toEqual(['F1', 'F2']);
  });
  it('excludes non-safe findings from provenance', () => {
    const brief = buildDemoBrief([finding('F1', 'CTA_CLARITY', false)]);
    expect(brief.findingInputs).toHaveLength(0);
  });
});

describe('CTA resolution (amendment 2 — no fake functionality)', () => {
  it('uses a verified booking URL → "Book an appointment"', () => {
    const c = resolveDemoContent([...baseFacts(), fact('booking_url', 'https://book.example/x')]);
    expect(c.cta).toMatchObject({ kind: 'booking', label: 'Book an appointment', href: 'https://book.example/x' });
  });
  it('falls back to contact page → "Contact us"', () => {
    const c = resolveDemoContent([...baseFacts(), fact('contact_form_url', 'https://x.example/contact')]);
    expect(c.cta.kind).toBe('contact');
    expect(c.cta.label).toBe('Contact us');
  });
  it('falls back to phone → tel: CTA (never implies online booking)', () => {
    const c = resolveDemoContent([...baseFacts(), fact('phone', '+49 30 1234567')]);
    expect(c.cta.kind).toBe('tel');
    expect(c.cta.href).toBe('tel:+49301234567');
    expect(c.cta.label).not.toMatch(/book/i);
  });
  it('with no verified destination → scrolls to #contact (no fake booking button)', () => {
    const c = resolveDemoContent(baseFacts());
    expect(c.cta).toMatchObject({ kind: 'scroll', href: '#contact' });
    expect(c.cta.label).not.toMatch(/book/i);
  });
});

describe('content provenance (amendment 4)', () => {
  it('every business-specific value traces to a current fact', () => {
    const facts = baseFacts();
    const c = resolveDemoContent(facts);
    expect(validateDemoContent(c, facts).ok).toBe(true);
    expect(c.factInputs.some((fi) => fi.field === 'business_name')).toBe(true);
  });
  it('flags a fact input that is not current', () => {
    const facts = baseFacts();
    const c = resolveDemoContent(facts);
    // Remove a fact so its input no longer resolves to a current fact.
    const r = validateDemoContent(c, facts.filter((f) => f.factType !== 'city'));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.startsWith('fact_input_not_current'))).toBe(true);
  });
});

describe('template rendering + HTML security (amendment 3)', () => {
  it('includes noindex, CSP, disclosure and a CTA; no scripts/forms', () => {
    const html = renderDemoHtml(resolveDemoContent(baseFacts()));
    expect(html).toMatch(/name="robots" content="noindex,nofollow,noarchive"/);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toMatch(/concept redesign/i);
    expect(html).toContain('class="cta"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<form/i);
    expect(validateRenderedHtml(html).ok).toBe(true);
  });

  it('escapes a malicious business-name fact — no injected script or handler', () => {
    const facts = [
      fact('business_name', `<script>alert(1)</script>"><img src=x onerror=alert(2)>`),
      fact('city', 'Berlin'),
    ];
    const html = renderDemoHtml(resolveDemoContent(facts));
    // The payload appears only in escaped form.
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toMatch(/<img[^>]+onerror=/i);
    expect(html).toContain('&lt;script&gt;');
    // The security validator passes (escaped content is inert) — the demo is safe to render.
    expect(validateRenderedHtml(html).ok).toBe(true);
  });

  it('a malicious URL fact never becomes an href', () => {
    const facts = [fact('business_name', 'X'), fact('city', 'Berlin'), fact('official_website_url', 'javascript:alert(1)')];
    const c = resolveDemoContent(facts);
    expect(c.officialWebsiteUrl).toBeNull(); // rejected by sanitizeUrl
    const html = renderDemoHtml(c);
    expect(validateRenderedHtml(html).ok).toBe(true);
  });

  it('the validator catches a genuinely un-escaped script (regression guard)', () => {
    expect(validateRenderedHtml('<html><body><script>x</script></body></html>').ok).toBe(false);
    expect(validateRenderedHtml('<a onclick="x()">y</a>').violations).toContain('contains_inline_event_handler');
  });
});

describe('buildDemo (end-to-end, deterministic)', () => {
  it('builds a valid demo for the Gate A scenario and is deterministic', () => {
    const input = { opportunityScore: 10, findings: [finding('F1', 'CTA_CLARITY'), finding('F2', 'SERVICE_CLARITY')], facts: baseFacts() };
    const a = buildDemo(input, { minOpportunityForDemo: 35 });
    const b = buildDemo(input, { minOpportunityForDemo: 35 });
    expect(a.outcome).toBe('DEMO_BUILT');
    expect(a.built?.contentHash).toBe(b.built?.contentHash);
    expect(a.brief?.findingInputs).toHaveLength(2);
  });
  it('returns NO_DEMO without building for unjustified leads', () => {
    const r = buildDemo({ opportunityScore: 1, findings: [], facts: baseFacts() }, { minOpportunityForDemo: 35 });
    expect(r.outcome).toBe('NO_DEMO_NOT_JUSTIFIED');
    expect(r.built).toBeUndefined();
  });
});
