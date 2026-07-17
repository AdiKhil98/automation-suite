import { type MockResponder } from '../integrations/llm/mock-llm.js';
import {
  type BodyComponentId,
  type CtaIntent,
  type CtaLabelKey,
  type DemoDesignSpec,
  type FactKey,
  type MessagingEmphasis,
} from '../domain/demo/composer/design-spec.js';

const FACT_KEYS_LINE = /available fact keys \(only these may be referenced\): (.*)/;
const INTENTS_LINE = /achievable CTA intents \(primary CTA must be one of these\): (.*)/;
const FINDING_REF = /^- (F\d+) \[/gm;

const CTA_LABEL_FOR_INTENT: Record<CtaIntent, CtaLabelKey> = {
  booking: 'BOOK_APPOINTMENT',
  call: 'CALL_US',
  contact: 'CONTACT_US',
  scroll: 'GET_IN_TOUCH',
};

function parseList(re: RegExp, user: string): string[] {
  const m = re.exec(user);
  if (!m || !m[1]) return [];
  return m[1].split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== '(none)');
}

/**
 * Default responder for mock composer runs (LLM_PROVIDER=mock). Deterministic and
 * evidence-grounded: it reads the available fact keys, achievable CTA intents, and finding
 * refs from the serialized brief and produces a valid DemoDesignSpec that references only
 * those. The reviewer approves cleanly. Zero network, zero cost.
 */
export const defaultMockComposerResponder: MockResponder = (req) => {
  if (req.task === 'demo_design') {
    const keys = new Set(parseList(FACT_KEYS_LINE, req.user) as FactKey[]);
    const intents = new Set(parseList(INTENTS_LINE, req.user) as CtaIntent[]);
    const findingRefs = [...req.user.matchAll(FINDING_REF)].map((m) => m[1] as string);
    const has = (k: FactKey): boolean => keys.has(k);

    // Primary CTA: prefer the most action-oriented achievable intent.
    const intent: CtaIntent = intents.has('booking') ? 'booking' : intents.has('call') ? 'call' : intents.has('contact') ? 'contact' : 'scroll';

    const sections: DemoDesignSpec['sections'] = [];
    let order = 1;
    const push = (componentId: BodyComponentId, factKeys: FactKey[], emphasis: MessagingEmphasis, ref: string | null): void => {
      sections.push({ componentId, order, addressesFindingRef: ref, factKeys, messagingEmphasis: emphasis });
      order += 1;
    };

    push('hero-a', (['business_name', 'city'] as FactKey[]).filter(has), 'CLARITY', findingRefs[0] ?? null);
    if (has('services')) push('services-a', ['services'], 'PROFESSIONALISM', findingRefs[1] ?? null);
    push('trust-a', [], 'TRUST', null);
    push('contact-a', (['phone', 'email', 'address', 'opening_hours', 'website'] as FactKey[]).filter(has), 'CONVENIENCE', null);

    const spec: DemoDesignSpec = {
      visualDirection: 'CLEAN_CLINICAL',
      heroStrategy: 'CLARITY_FIRST',
      headerVariant: 'header-a',
      footerVariant: 'footer-a',
      primaryCtaIntent: intent,
      primaryCtaLabelKey: CTA_LABEL_FOR_INTENT[intent],
      secondaryCtaEnabled: has('phone') && intent !== 'call',
      sections,
      mobilePriority: sections.map((s) => s.componentId),
      rationale: 'Mock composer spec: clear hero, verified services, generic trust, and a contact section.',
    };
    return { rawJson: spec };
  }

  // demo_design_review
  return {
    rawJson: {
      decision: 'APPROVE', fabricationRisk: false, evidenceConsistent: true, ctaHonest: true,
      revisionRequiresNewFacts: false, revisionRequiresNewClaims: false, revisionRequiresCtaChange: false, problems: [],
    },
  };
};
