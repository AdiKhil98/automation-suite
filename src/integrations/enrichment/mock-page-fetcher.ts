import { type FetchOutcome } from '../../utils/safe-fetch.js';
import { type PageFetcher } from './provider.js';

/**
 * Deterministic PageFetcher for tests and mock runs. Maps a URL to either canned
 * HTML (→ an `ok` outcome) or an explicit FetchOutcome (to simulate errors). Unknown
 * URLs return `invalid`. Never touches the network.
 */
export class MockPageFetcher implements PageFetcher {
  constructor(private readonly pages: Map<string, string | FetchOutcome>) {}

  async fetch(url: string): Promise<FetchOutcome> {
    const entry = this.pages.get(url);
    if (entry === undefined) return { kind: 'invalid', reason: 'not found (mock)' };
    if (typeof entry !== 'string') return entry;
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      return { kind: 'invalid', reason: 'unparseable url (mock)' };
    }
    return { kind: 'ok', finalUrl: url, host, status: 200, html: entry };
  }
}
