import { describe, expect, it } from 'vitest';
import {
  buildAllTabs,
  OUTREACH_TABS,
  type OutreachProjection,
  syncSheet,
} from '../../src/domain/outreach/sheet-sync.js';
import { MockSheetsProvider } from '../../src/integrations/google/sheets/mock-sheets.js';

const NOW = Date.parse('2026-07-25T12:00:00Z');

function projection(): OutreachProjection {
  return {
    outreach: [
      {
        recordId: 'rec-1', business: 'Zahnärzte Beispiel', domain: 'beispiel.example',
        contactEmail: 'a@beispiel.example', campaign: 'q3-dental', qualificationScore: 72, demoUrl: null,
        status: 'INITIAL_SENT', sequenceStep: 0, lastSentAt: new Date(Date.parse('2026-07-20T07:00:00Z')),
        nextFollowupAt: new Date(Date.parse('2026-07-23T07:00:00Z')), lastReplyAt: null, replyCategory: null,
        doNotContact: false, owner: 'ops', outcome: null, notes: null,
      },
    ],
    messages: [
      {
        messageId: 'msg-1', business: 'Zahnärzte Beispiel', contactEmail: 'a@beispiel.example', campaign: 'q3-dental',
        messageType: 'INITIAL', sequenceStep: 0, subject: 'Vorschlag', contentHash: 'abc123def456',
        approvedAt: new Date(NOW), sentAt: new Date(Date.parse('2026-07-20T07:00:00Z')),
        gmailMessageId: 'g-1', gmailThreadId: 't-1',
      },
    ],
    followupsDue: [
      {
        followupId: 'fu-1', business: 'Zahnärzte Beispiel', contactEmail: 'a@beispiel.example', step: 1,
        dueAt: new Date(Date.parse('2026-07-23T07:00:00Z')), replyDetected: false, blockedReason: null,
        humanApprovalStatus: 'PENDING_HUMAN_APPROVAL',
      },
    ],
    replies: [],
  };
}

describe('Google Sheet sync', () => {
  it('builds the four operator tabs with stable row ids', () => {
    const tabs = buildAllTabs(projection(), NOW);
    expect(tabs.map((t) => t.tab)).toEqual([
      OUTREACH_TABS.outreach, OUTREACH_TABS.messages, OUTREACH_TABS.followupsDue, OUTREACH_TABS.replies,
    ]);
    expect(tabs[0]?.rows[0]?.rowId).toBe('outreach:rec-1');
    expect(tabs[1]?.rows[0]?.rowId).toBe('message:msg-1');
    // Body is never dumped; the Messages tab references the version by content hash.
    expect(tabs[1]?.rows[0]?.cells).toContain('abc123def456');
    // Overdue days computed in the follow-ups tab.
    expect(tabs[2]?.rows[0]?.cells).toContain('2'); // 2026-07-25 is 2 days past 07-23
  });

  it('is idempotent: a second identical sync reports everything unchanged', async () => {
    const provider = new MockSheetsProvider();
    const tabs = buildAllTabs(projection(), NOW);
    const first = await syncSheet(provider, tabs);
    expect(first.totals.inserted).toBe(3); // 1 outreach + 1 message + 1 followup
    expect(first.totals.updated).toBe(0);

    const second = await syncSheet(provider, buildAllTabs(projection(), NOW));
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.updated).toBe(0);
    expect(second.totals.unchanged).toBe(3);
  });

  it('updates a changed row in place (stable id) rather than duplicating', async () => {
    const provider = new MockSheetsProvider();
    await syncSheet(provider, buildAllTabs(projection(), NOW));
    const changed = projection();
    changed.outreach[0]!.status = 'FOLLOW_UP_1_DUE';
    const report = await syncSheet(provider, buildAllTabs(changed, NOW));
    expect(report.totals.updated).toBe(1);
    expect(report.totals.inserted).toBe(0);
    expect(Object.keys(provider.dump(OUTREACH_TABS.outreach))).toEqual(['outreach:rec-1']); // one row
  });

  it('removes rows no longer present in Postgres', async () => {
    const provider = new MockSheetsProvider();
    await syncSheet(provider, buildAllTabs(projection(), NOW));
    const empty: OutreachProjection = { outreach: [], messages: [], followupsDue: [], replies: [] };
    const report = await syncSheet(provider, buildAllTabs(empty, NOW));
    expect(report.totals.deleted).toBe(3);
  });

  it('mock provider never writes externally', () => {
    expect(new MockSheetsProvider().writesExternally).toBe(false);
  });

  it('scoped upsert-only sync (deleteStale=false) never removes rows absent from the snapshot', async () => {
    const provider = new MockSheetsProvider();
    await syncSheet(provider, buildAllTabs(projection(), NOW));
    // A scoped sync that no longer includes rec-1 must NOT delete it when deleteStale is false.
    const empty: OutreachProjection = { outreach: [], messages: [], followupsDue: [], replies: [] };
    const report = await syncSheet(provider, buildAllTabs(empty, NOW), { deleteStale: false });
    expect(report.totals.deleted).toBe(0);
    expect(Object.keys(provider.dump(OUTREACH_TABS.outreach))).toEqual(['outreach:rec-1']); // survives
  });
});
