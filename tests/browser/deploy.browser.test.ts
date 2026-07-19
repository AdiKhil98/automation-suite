import { describe, expect, it } from 'vitest';
import { composeDemo } from '../../src/domain/demo/composer/compose.js';
import { type DemoDesignSpec } from '../../src/domain/demo/composer/design-spec.js';
import { validateComposedDemo } from '../../src/integrations/demo/playwright-validate.js';
import { finalizeEmailBody } from '../../src/domain/deploy/finalize.js';
import { type LeadFact } from '../../src/domain/lead-facts/lead-fact.js';

let idc = 0;
const fact = (factType: string, value: string): LeadFact => ({
  id: `f-${idc++}`, leadId: 'l', factType: factType as LeadFact['factType'], value, normalizedValue: value.toLowerCase(),
  sourceType: 'website', sourceUrl: null, capturedAt: new Date(), confidence: 1, supersededBy: null, supersededAt: null, isCurrent: true,
});
const spec = (): DemoDesignSpec => ({
  visualDirection: 'CLEAN_CLINICAL', heroStrategy: 'CLARITY_FIRST', headerVariant: 'header-a', footerVariant: 'footer-a',
  primaryCtaIntent: 'call', primaryCtaLabelKey: 'CALL_US', secondaryCtaEnabled: false,
  sections: [
    { componentId: 'hero-a', order: 1, addressesFindingRef: null, factKeys: ['business_name', 'city'], messagingEmphasis: 'CLARITY' },
    { componentId: 'contact-a', order: 2, addressesFindingRef: null, factKeys: ['phone'], messagingEmphasis: 'CONVENIENCE' },
  ],
  mobilePriority: [], rationale: 'deploy fixture',
});
const facts = (): LeadFact[] => [fact('business_name', 'Zahnärzte am Ufer'), fact('city', 'Berlin'), fact('phone', '+49 30 1234567')];

const skip = process.env.SKIP_BROWSER === '1';

describe.skipIf(skip)('deployed demo content (real Chromium, local fixture)', () => {
  it('deployed-equivalent page renders on desktop+mobile with CSP, noindex, no external requests', async () => {
    const r = composeDemo(spec(), { facts: facts(), findings: [] });
    expect(r.outcome).toBe('DEMO_COMPOSED');
    const checks = await validateComposedDemo(r.built!.html, { expectedCtaHref: 'tel:+49301234567' });
    for (const c of checks) expect(c.violations, `${c.profile}: ${c.violations.join(', ')}`).toHaveLength(0);
  }, 60_000);

  it('finalized email carries the verified URL and no remaining placeholder', () => {
    const fin = finalizeEmailBody('Hallo, {{DEMO_URL}} Text', 'https://abc123--deploy-preview.netlify.app');
    expect(fin.ok).toBe(true);
    expect(fin.resolvedBody).toContain('https://abc123--deploy-preview.netlify.app');
    expect(fin.resolvedBody).not.toContain('{{DEMO_URL}}');
  });
});
