import { describe, expect, it } from 'vitest';
import { gatherWebsiteEvidence, type PageFetchFn } from '../../src/domain/decision-makers/website-evidence.js';
import { type FetchOutcome } from '../../src/utils/safe-fetch.js';

/**
 * Ground-truth regression suite. Every fixture reproduces the page/link structure actually observed on
 * the seven real leads of the VPS preview that motivated this design; the assertions encode what the
 * selector must do on each of them.
 */

function ok(url: string, html: string): FetchOutcome {
  return { kind: 'ok', finalUrl: url, host: new URL(url).host, status: 200, html };
}

function fakeFetch(pages: Record<string, string>, calls: string[] = []): PageFetchFn {
  return (url: string) => {
    calls.push(url);
    const html = pages[url];
    if (html === undefined) return Promise.resolve({ kind: 'invalid', reason: 'not found' } as FetchOutcome);
    return Promise.resolve(ok(url, html));
  };
}

const FILLER = 'We are a well-established practice serving our local community with high-quality care. '.repeat(4);

/** A realistic team roster: names adjacent to roles, with GDC numbers, well past the first 1500 chars. */
function rosterPage(rows: string, lead = FILLER.repeat(5)): string {
  return `<html><body><nav><a href="/">Home</a><a href="/team">Team</a></nav><main><h1>Meet the Team</h1>
    <p>${lead}</p>${rows}</main></body></html>`;
}

describe('gatherWebsiteEvidence — page budget', () => {
  const HOME = 'https://budget.example/';

  it('never issues more fetches than maxPages, and never more evidence pages than maxPages', async () => {
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/team">Team</a><a href="/about-us">About Us</a><a href="/contact">Contact</a></body></html>`,
      'https://budget.example/team': rosterPage('<p>Dr Masih Sage Director / Principal Dentist GDC Number: 229677</p>'),
      'https://budget.example/about-us': `<html><body><main><p>${FILLER}The practice was opened by Dr Masih Sage in 2004.</p></main></body></html>`,
      'https://budget.example/contact': `<html><body><main><p>${FILLER}Call us on 020 1234 5678.</p></main></body></html>`,
    }, calls);

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.fetchCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((p) => p.role)).toEqual(['home', 'team', 'about']);
  });

  it('homepage only when maxPages is 1', async () => {
    const calls: string[] = [];
    const fetch = fakeFetch({ [HOME]: `<html><body>${FILLER}<a href="/team">Team</a></body></html>` }, calls);
    const result = await gatherWebsiteEvidence(fetch, HOME, 1);
    expect(result.pages.map((p) => p.role)).toEqual(['home']);
    expect(calls).toHaveLength(1);
  });

  it('a failed homepage fetch yields zero pages and a recorded error', async () => {
    const fetch: PageFetchFn = () => Promise.resolve({ kind: 'transient', reason: 'timeout' } as FetchOutcome);
    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages).toHaveLength(0);
    expect(result.fetchErrors).toHaveLength(1);
  });

  it('a failed secondary-page fetch degrades gracefully; homepage evidence still returned', async () => {
    const fetch = fakeFetch({ [HOME]: `<html><body>${FILLER}<a href="/team">Team</a></body></html>` });
    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages.map((p) => p.role)).toEqual(['home']);
    expect(result.fetchErrors.length).toBeGreaterThan(0);
  });

  it('never fetches or accepts an off-domain link', async () => {
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="https://linkedin.com/company/x">Meet the Team</a><a href="/team">Team</a></body></html>`,
      'https://budget.example/team': rosterPage('<p>Dr A Person Practice Manager GDC: 12345</p>'),
    }, calls);
    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(calls).not.toContain('https://linkedin.com/company/x');
    expect(result.pages.some((p) => p.url.includes('linkedin'))).toBe(false);
  });

  it('contact is used only as a fallback when neither team nor about is available', async () => {
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/contact">Contact Us</a></body></html>`,
      'https://budget.example/contact': `<html><body><main><p>${FILLER}Find us at 1 High Street.</p></main></body></html>`,
    }, calls);
    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages.map((p) => p.role)).toEqual(['home', 'contact']);
  });
});

describe('gatherWebsiteEvidence — ground truth: the seven surveyed leads', () => {
  it('Gipsy Hill: the nested /about-us/our-team/ beats its parent /about-us/', async () => {
    const HOME = 'https://gipsy.example/';
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<nav><a href="/contact/">Start Your Smile Journey</a>
        <a href="/about-us/">About</a><a href="/about-us/our-team/">Meet the team</a>
        <a href="/about-us/fee-guide/">Fees</a></nav></body></html>`,
      'https://gipsy.example/about-us/our-team': rosterPage(
        `<p>Founder Dr Lalit Bandlish Founder.</p>
         <p>Dr Bobby Bandlish Principal Dentist / Owner GDC: 71012</p>
         <p>Dr Gita Auplish Co-Founder GDC 71011</p>`,
      ),
      'https://gipsy.example/about-us': `<html><body><main><p>${FILLER}We are a family-run practice.</p></main></body></html>`,
    }, calls);

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    const team = result.pages.find((p) => p.role === 'team');
    expect(team?.url).toBe('https://gipsy.example/about-us/our-team');
    expect(team?.text).toContain('Dr Bobby Bandlish Principal Dentist / Owner');
    // The fee page under /about-us/ must never be mistaken for an About page.
    expect(calls).not.toContain('https://gipsy.example/about-us/fee-guide');
  });

  it('Colosseum: /sell-your-practice rejected; #practice-team read from the page already fetched', async () => {
    const HOME = 'https://colosseum.example/practices/norwood-dental-clinic';
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body><nav><a href="/sell-your-practice">Sell your practice</a>
          <a href="/treatments/referrals-fi">For Dentists</a><a href="/about-us">About us</a></nav>
        <main><p>${FILLER}</p><a href="#practice-contact">Contact</a><a href="#practice-team">Our team</a>
          <section id="practice-team"><h2>Our team at Norwood Dental Clinic</h2>
            <p>Laura Carranza Dentist. Laura Carranza joined in 2019. Lic Odont Catalan 2010 - GDC No. 204516.
               Laura qualified from the International University of Catalonia in Barcelona.</p>
          </section></main></body></html>`,
      'https://colosseum.example/about-us': `<html><body><main><p>${FILLER}
        Our majority owner is Jacobs Holding AG, part of Jacobs Capital, a global investment firm.</p></main></body></html>`,
    }, calls);

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(calls).not.toContain('https://colosseum.example/sell-your-practice');
    // The team section costs no HTTP request: only the homepage and the (rejected) about page are fetched.
    expect(calls).toEqual([HOME, 'https://colosseum.example/about-us']);
    const team = result.pages.find((p) => p.role === 'team');
    expect(team?.url).toBe(`${HOME}#practice-team`);
    expect(team?.text).toContain('Our team at Norwood Dental Clinic');
    // Corporate ownership by a holding company is not decision-maker evidence.
    expect(result.pages.some((p) => p.role === 'about')).toBe(false);
    expect(result.pages.some((p) => p.text.includes('Jacobs Holding'))).toBe(false);
  });

  it('Complete Dentistry: the dropdown href="#" is ignored and never refetches the homepage', async () => {
    const HOME = 'https://complete.example/';
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: `<html><body><main><p>${FILLER}"For me dentistry is a complete joy" Richard Clarke-Irons, Principal Dentist.</p></main>
        <ul><li><a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">About Us</a>
          <a href="/about-us">About Us</a><a href="/about-us/meet-the-team">Meet The Team</a>
          <a href="/about-us/case-studies">Case Studies</a></li>
          <li><a href="/contact">Contact Us</a></li></ul></body></html>`,
      'https://complete.example/about-us/meet-the-team': rosterPage(
        '<p>Dr Richard Clarke-Irons Principal Dentist. Dr Jessica Morris Dentist. Dr Katie Huane Dentist.</p>',
        FILLER,
      ),
      'https://complete.example/about-us': `<html><body><main><p>${FILLER}
        The practice was opened by Dr Richard Clarke-Irons in 2004, originally as Warlingham Green Dental Clinic.</p></main></body></html>`,
    }, calls);

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(calls.filter((c) => c === HOME || c === 'https://complete.example/#')).toHaveLength(1);
    expect(result.pages.find((p) => p.role === 'team')?.url).toBe('https://complete.example/about-us/meet-the-team');
    expect(result.pages.find((p) => p.role === 'about')?.text).toContain('opened by Dr Richard Clarke-Irons');
    // The homepage alone already carries the qualifying title.
    expect(result.pages[0]?.text).toContain('Richard Clarke-Irons, Principal Dentist');
  });

  it('London Dental Arts: keeps BOTH /team/ and the About page whose prose names the owner', async () => {
    const HOME = 'https://lda.example/';
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/about-us/">About</a><a href="/team/">Team</a>
        <a href="/careers/practice-manager">Practice Manager</a><a href="/contact/">Contact</a></body></html>`,
      'https://lda.example/team': rosterPage(
        `<p>Dr Arman Barfeie Specialist Prosthodontist, Implant Surgeon GDC Number: 260234</p>
         <p>Monika Strazayova Practice Manager</p>`,
      ),
      'https://lda.example/about-us': `<html><body><main><p>${FILLER}
        London Dental Arts, Cosmetic and Implant Clinic in Forest Hill owned and operated by Dr. Arman Barfeie,
        offers modern dental care using the most cutting-edge techniques.</p></main></body></html>`,
    });

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages.map((p) => p.role)).toEqual(['home', 'team', 'about']);
    expect(result.pages.find((p) => p.role === 'about')?.text).toContain('owned and operated by Dr. Arman Barfeie');
    expect(result.pages.find((p) => p.role === 'team')?.text).toContain('Monika Strazayova Practice Manager');
  });

  it('Green Lane: /team/ beats /about-us/, and the complaints-procedure About page is rejected', async () => {
    const HOME = 'https://greenlane.example/';
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/about-us/">About Us</a><a href="/team/">Team</a>
        <a href="/dentist-in-bromley/">NHS Dentists In Bromley</a></body></html>`,
      'https://greenlane.example/team': rosterPage(
        `<p>Dr Masih Sage Director / Principal Dentist GDC Number: 229677</p>
         <p>Dr Max Pura Director / Principal Dentist GDC Number: 179927</p>`,
      ),
      'https://greenlane.example/about-us': `<html><body><main><p>${FILLER}
        If you are unhappy about any aspect of the treatment you received, please write to the Practice Manager
        or the Clinical Director, who will contact you within five working days.</p></main></body></html>`,
    });

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages.find((p) => p.role === 'team')?.url).toBe('https://greenlane.example/team');
    expect(result.pages.find((p) => p.role === 'team')?.text).toContain('Dr Masih Sage Director / Principal Dentist');
    expect(result.pages.some((p) => p.role === 'about')).toBe(false);
  });

  it('Dulwich: /pages/our-team is selected on a site with no About page at all', async () => {
    const HOME = 'https://dulwich.example/';
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/pages/why-choose-us">Why choose us?</a>
        <a href="/pages/our-team">Team</a><a href="/pages/contact">Contact</a></body></html>`,
      'https://dulwich.example/pages/our-team': rosterPage(
        `<p>Dr Patrick Williams Specialist Orthodontist. Dr Ritu Connor Specialist Orthodontist (GDC number 69489).
            Mena Williams Managing Director. Michelle Ketchen Practice Manager. Frank Adu Head Nurse (GDC No: 126629).</p>`,
      ),
      'https://dulwich.example/pages/why-choose-us': `<html><body><main><p>${FILLER}Choose us for great care.</p></main></body></html>`,
    });

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    const team = result.pages.find((p) => p.role === 'team');
    expect(team?.url).toBe('https://dulwich.example/pages/our-team');
    expect(team?.text).toContain('Mena Williams Managing Director');
    expect(result.pages.some((p) => p.role === 'about')).toBe(false); // weak page fails confirmation
  });

  it('Whitgift: keeps BOTH the roster and the About page carrying the ownership narrative', async () => {
    const HOME = 'https://whitgift.example/';
    const fetch = fakeFetch({
      [HOME]: `<html><body>${FILLER}<a href="/about-us/">About Us</a><a href="/dental-team/">Meet the Team</a>
        <a href="/email-us/">Contact Us</a><a href="/find-dentists-croydon/">How to Find Us</a></body></html>`,
      'https://whitgift.example/dental-team': rosterPage(
        `<p>Shahin Lalani Dentist BDS (BRIST) GDC No. 61775</p>
         <p>Abhijeet Godbole Dentist GDC No. 100836</p>
         <p>Julie Letts Practice Manager &amp; Receptionist GDC No. 133973</p>`,
      ),
      'https://whitgift.example/about-us': `<html><body><main><p>${FILLER}
        Our practice began its journey in 1970, founded by Mr. Norman Goldberg. In 1994, Shahin Lalani joined the
        team, and her passion for patient care inspired her to take ownership in 1997. In 2012, Abhijeet Godbole
        joined our team, and in 2018 he entered into a partnership with Shahin.</p></main></body></html>`,
    });

    const result = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(result.pages.map((p) => p.role)).toEqual(['home', 'team', 'about']);
    expect(result.pages.find((p) => p.role === 'about')?.text).toContain('take ownership in 1997');
    expect(result.pages.find((p) => p.role === 'team')?.text).toContain('Julie Letts Practice Manager');
  });
});
