import { type MockResponder } from '../integrations/llm/mock-llm.js';
import { type EmailCtaKind, type EmailCtaLabelKey, type EmailFactKey } from '../domain/email/email-types.js';

const FACT_KEYS_LINE = /available fact keys: (.*)/;
const DEMO_ALLOWED_LINE = /demo link allowed: (YES|NO)/;
const FINDING_REF = /^- (F\d+) \[/gm;
const NAME_LINE = /contact name \(verified\): (.*)/;

function parseList(re: RegExp, user: string): string[] {
  const m = re.exec(user);
  if (!m || !m[1]) return [];
  return m[1].split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== '(none)');
}

/**
 * Default responder for mock email runs (LLM_PROVIDER=mock). Deterministic and honest: it
 * references only the available fact keys + finding refs from the brief, uses a reply CTA
 * unless a demo link is explicitly allowed, a neutral greeting unless a verified name exists,
 * and restrained language that passes the deterministic validators. The reviewer approves.
 */
export const defaultMockEmailResponder: MockResponder = (req) => {
  if (req.task === 'email_write') {
    const keys = parseList(FACT_KEYS_LINE, req.user) as EmailFactKey[];
    const demoAllowed = (DEMO_ALLOWED_LINE.exec(req.user)?.[1] ?? 'NO') === 'YES';
    const findingRefs = [...req.user.matchAll(FINDING_REF)].map((m) => m[1] as string).slice(0, 2);
    const nameRaw = NAME_LINE.exec(req.user)?.[1] ?? '';
    const hasName = nameRaw !== '' && !nameRaw.startsWith('(none');

    const ctaKind: EmailCtaKind = demoAllowed ? 'demo_link' : 'reply';
    const ctaLabelKey: EmailCtaLabelKey = demoAllowed ? 'SEE_THE_CONCEPT' : 'REPLY_TO_LEARN_MORE';

    const p1 = 'I came across your practice while looking at dental websites in your area, and a couple of things stood out that could make it easier for patients to get in touch.';
    const p2 = findingRefs.length > 0
      ? 'In particular, the main way to reach out could be made clearer and easier to find on the page.'
      : 'A few small, practical adjustments could make the site clearer and easier to use.';

    return {
      rawJson: {
        subject: 'A quick note on your practice website',
        bodyParagraphs: [p1, p2],
        greetingStyle: hasName ? 'NAMED' : 'NEUTRAL',
        ctaKind, ctaLabelKey, signoffKey: 'BEST_REGARDS',
        factRefs: keys.filter((k) => k === 'business_name' || k === 'city'),
        findingRefs,
      },
    };
  }

  // email_review
  return {
    rawJson: {
      decision: 'APPROVE', fabricationRisk: false, personalizationSupported: true, claimHonest: true,
      revisionRequiresNewFacts: false, revisionRequiresNewClaims: false, revisionRequiresCtaChange: false, problems: [],
    },
  };
};
