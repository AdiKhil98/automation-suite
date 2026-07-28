import { describe, expect, it } from 'vitest';
import { selectReplyReader } from '../../src/integrations/gmail/http-reply-provider.js';

/**
 * Phase 17A3 regression: a REQUESTED live Gmail read must never silently fall back to the mock
 * reader. `selectReplyReader` is the pure decision the CLI enforces. Live is requested the moment
 * GMAIL_REPLY_SYNC_ENABLED=true OR --confirm-gmail-read is present; the mock reader runs ONLY when it
 * is explicitly selected with --mock.
 */
describe('selectReplyReader (fail-closed reader selection)', () => {
  it('selects live when both gates are present', () => {
    expect(selectReplyReader({ syncEnabled: true, confirmed: true, mock: false })).toEqual({ kind: 'live' });
  });

  it('selects live (never mock) when only the env flag is set — the CLI then enforces the remaining guards', () => {
    // Intent is present, so this is a LIVE selection. The command builds the live reader and, if the
    // --confirm-gmail-read gate (or creds/scope) fails, exits nonzero rather than downgrading.
    expect(selectReplyReader({ syncEnabled: true, confirmed: false, mock: false })).toEqual({ kind: 'live' });
  });

  it('selects live (never mock) when only --confirm-gmail-read is passed', () => {
    expect(selectReplyReader({ syncEnabled: false, confirmed: true, mock: false })).toEqual({ kind: 'live' });
  });

  it('runs mock ONLY when explicitly selected with --mock', () => {
    expect(selectReplyReader({ syncEnabled: false, confirmed: false, mock: true })).toEqual({ kind: 'mock' });
  });

  it('refuses (no silent default) when neither a live intent nor --mock is given', () => {
    const d = selectReplyReader({ syncEnabled: false, confirmed: false, mock: false });
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toContain('no reader selected');
  });

  it('refuses a conflicting selection (--mock combined with a live intent)', () => {
    const d = selectReplyReader({ syncEnabled: true, confirmed: true, mock: true });
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toContain('conflicting');
  });

  it('never returns mock for any live-intent input (the core anti-fallback guarantee)', () => {
    for (const syncEnabled of [true, false]) {
      for (const confirmed of [true, false]) {
        const wantsLive = syncEnabled || confirmed;
        if (!wantsLive) continue;
        const d = selectReplyReader({ syncEnabled, confirmed, mock: false });
        expect(d.kind).toBe('live'); // never 'mock'
      }
    }
  });
});
