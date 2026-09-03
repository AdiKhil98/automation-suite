import { describe, expect, it } from 'vitest';
import { gatherWebsiteEvidence, type PageFetchFn } from '../../src/domain/decision-makers/website-evidence.js';
import { type FetchOutcome } from '../../src/utils/safe-fetch.js';

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

const HOME = 'https://diamond-smile.com/';

describe('gatherWebsiteEvidence', () => {
  it('discovers a "Meet the Team" link even though it lacks the word "about" (the shared CONTACT_PATH_RE gap this module avoids)', async () => {
    const home = `<html><body><h1>Diamond Smile</h1><nav><a href="/meet-the-team">Meet the Team</a><a href="/contact-us">Contact</a></nav></body></html>`;
    const team = `<html><body><p>Shyam Shastri, Principal Dentist.</p></body></html>`;
    const contact = `<html><body><p>Call us: 01234 567890</p></body></html>`;
    const calls: string[] = [];
    const fetch = fakeFetch({
      [HOME]: home,
      'https://diamond-smile.com/meet-the-team': team,
      'https://diamond-smile.com/contact-us': contact,
    }, calls);
    const { pages, fetchErrors } = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(fetchErrors).toHaveLength(0);
    expect(pages.map((p) => p.role)).toEqual(['home', 'team', 'contact']);
    expect(pages[1]?.text).toContain('Shyam Shastri');
  });

  it('never fetches or accepts an external/off-domain link', async () => {
    const home = `<html><body><a href="https://linkedin.com/company/diamond-smile">Team on LinkedIn</a><a href="/about">About Us</a></body></html>`;
    const about = `<html><body><p>About our practice.</p></body></html>`;
    const calls: string[] = [];
    const fetch = fakeFetch({ [HOME]: home, 'https://diamond-smile.com/about': about }, calls);
    const { pages } = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(calls).not.toContain('https://linkedin.com/company/diamond-smile');
    expect(pages.some((p) => p.url.includes('linkedin.com'))).toBe(false);
  });

  it('is bounded by maxPages (home + at most maxPages-1 secondary pages)', async () => {
    const home = `<html><body><a href="/team">Team</a><a href="/contact">Contact</a></body></html>`;
    const fetch = fakeFetch({ [HOME]: home, 'https://diamond-smile.com/team': '<html><body>Team</body></html>', 'https://diamond-smile.com/contact': '<html><body>Contact</body></html>' });
    const { pages } = await gatherWebsiteEvidence(fetch, HOME, 1); // homepage only
    expect(pages).toHaveLength(1);
    expect(pages[0]?.role).toBe('home');
  });

  it('a failed secondary-page fetch degrades gracefully; homepage evidence still returned', async () => {
    const home = `<html><body><a href="/team">Team</a></body></html>`;
    const fetch = fakeFetch({ [HOME]: home }); // /team is never registered -> 'invalid'
    const { pages, fetchErrors } = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.role).toBe('home');
    expect(fetchErrors.length).toBeGreaterThan(0);
  });

  it('a failed homepage fetch yields zero pages and a recorded error', async () => {
    const fetch: PageFetchFn = () => Promise.resolve({ kind: 'transient', reason: 'timeout' } as FetchOutcome);
    const { pages, fetchErrors } = await gatherWebsiteEvidence(fetch, HOME, 3);
    expect(pages).toHaveLength(0);
    expect(fetchErrors).toHaveLength(1);
  });
});
