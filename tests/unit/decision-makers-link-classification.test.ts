import { describe, expect, it } from 'vitest';
import {
  classifyLink,
  isMenuControl,
  normalizeUrl,
  pathParts,
  rankLinks,
  type RawLink,
} from '../../src/domain/decision-makers/link-classification.js';

const SITE = 'https://example-dental.co.uk/';
const sameSite = (url: string): boolean => new URL(url).hostname.endsWith('example-dental.co.uk');

function link(anchorText: string, href: string, attrs: Record<string, string> = {}): RawLink {
  return { anchorText, href, attrs: { href, ...attrs } };
}

function classify(anchorText: string, href: string, attrs?: Record<string, string>, current = SITE) {
  return classifyLink(link(anchorText, href, attrs), current, sameSite);
}

describe('normalizeUrl', () => {
  it('strips the fragment, tracking params and trailing slash so one page has one identity', () => {
    const a = normalizeUrl('/about-us/', SITE);
    const b = normalizeUrl('/about-us#team', SITE);
    const c = normalizeUrl('/about-us?utm_source=google&utm_campaign=gmb', SITE);
    expect(a?.url).toBe('https://example-dental.co.uk/about-us');
    expect(b?.url).toBe(a?.url);
    expect(c?.url).toBe(a?.url);
    expect(b?.fragment).toBe('team');
  });

  it('keeps meaningful query params and rejects non-http schemes', () => {
    expect(normalizeUrl('/search?q=team', SITE)?.url).toBe('https://example-dental.co.uk/search?q=team');
    expect(normalizeUrl('mailto:hi@example-dental.co.uk', SITE)).toBeNull();
  });
});

describe('pathParts', () => {
  it('tokenizes on / - _ so keywords cannot straddle a word boundary', () => {
    // The regression that made a corporate M&A page win the team slot: /sell-your-practice contains
    // the literal substring "our-practice" inside "y|our-practice".
    const parts = pathParts('https://example-dental.co.uk/sell-your-practice');
    expect(parts.tokens).toEqual(['sell', 'your', 'practice']);
    expect(parts.tokens).not.toContain('our-practice');
    expect(parts.phrase).toBe('sell your practice');
  });
});

describe('isMenuControl', () => {
  it('rejects dropdown toggles and placeholder hrefs', () => {
    // Real markup from a surveyed site: a labelled Bootstrap dropdown parent that previously won the
    // team slot and caused the homepage to be fetched a second time as ".../#".
    expect(isMenuControl(link('About Us', '#', { class: 'nav-link dropdown-toggle', role: 'button', 'data-bs-toggle': 'dropdown', 'aria-expanded': 'false' }))).toBe(true);
    expect(isMenuControl(link('About Us', '#'))).toBe(true);
    expect(isMenuControl(link('Menu', ''))).toBe(true);
    expect(isMenuControl(link('Call', 'tel:+441234567890'))).toBe(true);
    expect(isMenuControl(link('About Us', '/about-us'))).toBe(false);
  });

  it('does not reject a real in-page section link', () => {
    expect(isMenuControl(link('Our team', '#practice-team'))).toBe(false);
  });
});

describe('classifyLink — categories and scoring', () => {
  it('classifies strong TEAM signals', () => {
    for (const [text, href] of [
      ['Meet the Team', '/meet-the-team'],
      ['Our Team', '/our-team'],
      ['Team', '/pages/our-team'],
      ['Meet the Team', '/dental-team'],
      ['Our Dentists', '/our-dentists'],
      ['Our clinicians', '/clinicians'],
      ['Staff', '/staff'],
    ] as const) {
      const c = classify(text, href);
      expect(c?.category, `${text} ${href}`).toBe('TEAM');
      expect(c?.score).toBeGreaterThanOrEqual(8);
    }
  });

  it('classifies strong ABOUT_OWNERSHIP signals', () => {
    for (const [text, href] of [
      ['About Us', '/about-us'],
      ['About', '/about'],
      ['Our Story', '/our-story'],
      ['Our History', '/our-history'],
      ['Who we are', '/who-we-are'],
      ['Our practice', '/our-practice'],
    ] as const) {
      const c = classify(text, href);
      expect(c?.category, `${text} ${href}`).toBe('ABOUT_OWNERSHIP');
      expect(c?.score).toBeGreaterThanOrEqual(8);
    }
  });

  it('"why choose us" is a WEAK about fallback, never a strong signal', () => {
    const weak = classify('Why choose us?', '/pages/why-choose-us');
    expect(weak?.category).toBe('ABOUT_OWNERSHIP');
    expect(weak?.score).toBeLessThan(8);
    expect(weak!.score).toBeLessThan(classify('About Us', '/about-us')!.score);
  });

  it('vetoes transactional / reader-directed pages without vetoing the bare word "your"', () => {
    expect(classify('Sell your practice', '/sell-your-practice')).toBeNull();
    expect(classify('Buy a practice', '/buy-a-practice')).toBeNull();
    expect(classify('Join our team', '/join-our-team')).toBeNull();
    expect(classify('Work for us', '/work-for-us')).toBeNull();
    expect(classify('Refer a patient', '/refer-a-patient')).toBeNull();
    expect(classify('For Dentists', '/treatments/referrals-fi')).toBeNull();
    // "your" alone must stay usable — this is a legitimate team label.
    const ok = classify('Meet your dentist', '/meet-your-dentist');
    expect(ok?.category).toBe('TEAM');
    expect(ok?.score).toBeGreaterThanOrEqual(8);
  });

  it('vetoes careers, blog, treatment, fee, testimonial and location pages', () => {
    expect(classify('Careers', '/careers')).toBeNull();
    expect(classify('Vacancies', '/jobs/vacancies')).toBeNull();
    expect(classify('Blog', '/blog')).toBeNull();
    expect(classify('Fees', '/about-us/fee-guide')).toBeNull();
    expect(classify('Membership', '/about-us/membership-plans')).toBeNull();
    expect(classify('Testimonials', '/testimonials')).toBeNull();
    expect(classify('How to Find Us', '/find-dentists-croydon')).toBeNull();
    expect(classify('NHS Dentists In Bromley', '/dentist-in-bromley')).toBeNull();
  });

  it('does not treat "our practices" (a chain clinic list) as an About page', () => {
    expect(classify('Our practices', '/practices')).toBeNull();
  });

  it('reports a fragment link to the CURRENT page as a same-document section', () => {
    const current = 'https://example-dental.co.uk/practices/norwood-dental-clinic';
    const c = classifyLink(link('Our team', '#practice-team'), current, sameSite);
    expect(c?.category).toBe('TEAM');
    expect(c?.sameDocumentFragment).toBe('practice-team');
    expect(c?.url).toBe(current);
  });

  it('never classifies an off-site link', () => {
    expect(classifyLink(link('Team on LinkedIn', 'https://linkedin.com/company/x'), SITE, sameSite)).toBeNull();
  });
});

describe('rankLinks — highest score wins, not first DOM match', () => {
  it('prefers the nested Team child over its About parent (the real dental-site nav shape)', () => {
    // Observed on 4 of 7 surveyed sites: About appears first in the DOM with Team nested under it, so
    // first-match selection structurally picked the parent category page.
    const links = [
      link('About', '/about-us/'),
      link('Meet the team', '/about-us/our-team/'),
      link('Contact', '/contact/'),
    ];
    const ranked = rankLinks(links, SITE, sameSite);
    expect(ranked.TEAM[0]?.url).toBe('https://example-dental.co.uk/about-us/our-team');
    expect(ranked.ABOUT_OWNERSHIP[0]?.url).toBe('https://example-dental.co.uk/about-us');
    expect(ranked.CONTACT[0]?.url).toBe('https://example-dental.co.uk/contact');
  });

  it('de-duplicates a page linked from both nav and footer', () => {
    const ranked = rankLinks(
      [link('Team', '/team/'), link('Team', '/team'), link('Our Team', '/team/')],
      SITE,
      sameSite,
    );
    expect(ranked.TEAM).toHaveLength(1);
  });

  it('a dropdown toggle never outranks the real page behind it', () => {
    const ranked = rankLinks(
      [
        link('About Us', '#', { class: 'dropdown-toggle', role: 'button', 'data-bs-toggle': 'dropdown' }),
        link('About Us', '/about-us'),
        link('Meet The Team', '/about-us/meet-the-team'),
      ],
      SITE,
      sameSite,
    );
    expect(ranked.TEAM[0]?.url).toBe('https://example-dental.co.uk/about-us/meet-the-team');
    expect(ranked.ABOUT_OWNERSHIP[0]?.url).toBe('https://example-dental.co.uk/about-us');
    expect([...ranked.TEAM, ...ranked.ABOUT_OWNERSHIP].some((c) => c.url.endsWith('/#'))).toBe(false);
  });
});
