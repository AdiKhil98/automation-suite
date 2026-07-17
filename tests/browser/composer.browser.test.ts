import { describe, expect, it } from 'vitest';
import { composeDemo } from '../../src/domain/demo/composer/compose.js';
import { type DemoDesignSpec } from '../../src/domain/demo/composer/design-spec.js';
import { validateComposedDemo } from '../../src/integrations/demo/playwright-validate.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';

let idc = 0;
const fact = (factType: string, value: string): LeadFact => ({
  id: `f-${idc++}`, leadId: 'l', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
  sourceType: 'website', sourceUrl: null, capturedAt: new Date(), confidence: 1, supersededBy: null, supersededAt: null, isCurrent: true,
});

const spec = (): DemoDesignSpec => ({
  visualDirection: 'MODERN_BOLD', heroStrategy: 'ACTION_FIRST', headerVariant: 'header-b', footerVariant: 'footer-b',
  primaryCtaIntent: 'call', primaryCtaLabelKey: 'CALL_US', secondaryCtaEnabled: false,
  sections: [
    { componentId: 'hero-b', order: 1, addressesFindingRef: null, factKeys: ['business_name', 'city'], messagingEmphasis: 'CONVENIENCE' },
    { componentId: 'services-b', order: 2, addressesFindingRef: null, factKeys: ['services'], messagingEmphasis: 'PROFESSIONALISM' },
    { componentId: 'trust-a', order: 3, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'TRUST' },
    { componentId: 'cta-a', order: 4, addressesFindingRef: null, factKeys: [], messagingEmphasis: 'CONVENIENCE' },
    { componentId: 'contact-b', order: 5, addressesFindingRef: null, factKeys: ['phone', 'address'], messagingEmphasis: 'LOCAL' },
  ],
  mobilePriority: ['hero-b', 'contact-b'], rationale: 'browser test',
});

const goodFacts = (): LeadFact[] => [
  fact('business_name', 'Zahnärzte am Ufer'), fact('city', 'Berlin'), fact('phone', '+49 30 1234567'),
  fact('formatted_address', 'Uferstr. 1, Berlin'), fact('services', 'Implantology|Whitening|Checkups'),
];

const evilFacts = (): LeadFact[] => [
  fact('business_name', '<script>window.__xss=1;alert(1)</script>"><img src=x onerror="window.__xss=1">'),
  fact('city', 'Berlin'), fact('phone', '+49 30 1234567'), fact('formatted_address', 'Uferstr. 1'),
];

const skip = process.env.SKIP_BROWSER === '1';

describe.skipIf(skip)('composed demo (real Chromium, local only)', () => {
  it('renders on desktop + mobile with no overflow, visible tel CTA, no external requests', async () => {
    const r = composeDemo(spec(), { facts: goodFacts(), findings: [] });
    expect(r.outcome).toBe('DEMO_COMPOSED');
    const checks = await validateComposedDemo(r.built!.html, { expectedCtaHref: 'tel:+49301234567' });
    for (const c of checks) expect(c.violations, `${c.profile}: ${c.violations.join(', ')}`).toHaveLength(0);
  }, 60_000);

  it('escaped malicious fact values cannot inject markup or run scripts', async () => {
    const s = spec();
    // Drop the services section (evil facts have no services) to keep the spec valid.
    s.sections = [
      { componentId: 'hero-b', order: 1, addressesFindingRef: null, factKeys: ['business_name', 'city'], messagingEmphasis: 'CLARITY' },
      { componentId: 'contact-b', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
    ];
    s.mobilePriority = [];
    const r = composeDemo(s, { facts: evilFacts(), findings: [] });
    expect(r.outcome).toBe('DEMO_COMPOSED');
    const checks = await validateComposedDemo(r.built!.html);
    for (const c of checks) expect(c.violations, `${c.profile}: ${c.violations.join(', ')}`).toHaveLength(0);
    expect(r.built!.html).toContain('&lt;script&gt;');
  }, 60_000);
});
