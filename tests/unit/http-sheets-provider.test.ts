import { describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import {
  GOOGLE_SHEETS_SCOPE,
  HttpSheetsProvider,
  type SheetsHttp,
} from '../../src/integrations/google/sheets/http-sheets.js';
import { GMAIL_COMPOSE_SCOPE, type AccessTokenProvider } from '../../src/integrations/gmail/oauth.js';
import { type GmailCredentials, type GmailTokenStore } from '../../src/integrations/gmail/token-store.js';
import { type SheetTabSnapshot } from '../../src/integrations/google/sheets/provider.js';

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const tokens: AccessTokenProvider = { getAccessToken: async () => 'sheets-access-token-never-logged' };

function store(cred: GmailCredentials | null): GmailTokenStore {
  return { load: async () => cred, save: async () => {}, exists: () => cred !== null };
}
function sheetsCred(scope = GOOGLE_SHEETS_SCOPE): GmailCredentials {
  return { refreshToken: 'r', accountEmail: 'ops@agency.example', scope, obtainedAt: '2026-07-01T00:00:00Z' };
}

/**
 * In-memory simulation of the Sheets REST API surface the provider uses: GET spreadsheet metadata,
 * GET a tab's values, and POST `:batchUpdate` (addSheet + updateCells). Records write attempts so a
 * failure can be shown to leave no partial state.
 */
class FakeSheets {
  title = 'Ops Projection';
  private nextId = 100;
  sheets = new Map<string, { id: number; grid: string[][] }>();
  updateCellCalls = 0;
  failUpdate = false;

  http: SheetsHttp = async ({ method, path, body }) => {
    if (method === 'GET' && path.includes('/values/')) {
      const encoded = /\/values\/([^?]+)/.exec(path)?.[1] ?? '';
      const title = decodeURIComponent(encoded).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
      const sheet = this.sheets.get(title);
      return { status: 200, json: { values: sheet ? sheet.grid : [] } };
    }
    if (method === 'GET') {
      // metadata
      return {
        status: 200,
        json: {
          properties: { title: this.title },
          sheets: [...this.sheets.entries()].map(([title, s]) => ({ properties: { sheetId: s.id, title } })),
        },
      };
    }
    // POST :batchUpdate
    const requests = (body as { requests?: unknown[] } | undefined)?.requests ?? [];
    const first = requests[0] as { addSheet?: { properties?: { title?: string } }; updateCells?: { start?: { sheetId?: number }; rows?: { values?: { userEnteredValue?: { stringValue?: string } }[] }[] } };
    if (first.addSheet) {
      const title = first.addSheet.properties?.title ?? '';
      const id = this.nextId++;
      this.sheets.set(title, { id, grid: [] });
      return { status: 200, json: { replies: [{ addSheet: { properties: { sheetId: id, title } } }] } };
    }
    if (first.updateCells) {
      this.updateCellCalls += 1;
      if (this.failUpdate) return { status: 500, json: { error: { message: 'boom' } } };
      const sheetId = first.updateCells.start?.sheetId;
      const entry = [...this.sheets.values()].find((s) => s.id === sheetId);
      if (!entry) return { status: 400, json: null };
      entry.grid = (first.updateCells.rows ?? []).map((r) => (r.values ?? []).map((c) => c.userEnteredValue?.stringValue ?? ''));
      return { status: 200, json: { replies: [{}] } };
    }
    return { status: 400, json: null };
  };
}

function provider(fake: FakeSheets, cred: GmailCredentials | null = sheetsCred()): HttpSheetsProvider {
  return new HttpSheetsProvider({ spreadsheetId: 'SHEET_ID', tokens, store: store(cred), logger, timeoutMs: 1000, http: fake.http });
}

function outreachTab(rows: { rowId: string; cells: string[] }[]): SheetTabSnapshot {
  return { tab: 'Outreach', header: ['business', 'status'], rows };
}

describe('HttpSheetsProvider (guarded real Sheets writer)', () => {
  it('verifyAccess accepts EXACTLY the Sheets scope and reports title + tabs', async () => {
    const fake = new FakeSheets();
    fake.sheets.set('Outreach', { id: 1, grid: [] });
    const check = await provider(fake).verifyAccess();
    expect(check.ok).toBe(true);
    expect(check.title).toBe('Ops Projection');
    expect(check.existingTabs).toContain('Outreach');
  });

  it('verifyAccess rejects a wrong scope, a missing credential, and a missing spreadsheet id', async () => {
    const fake = new FakeSheets();
    expect((await provider(fake, sheetsCred(GMAIL_COMPOSE_SCOPE)).verifyAccess()).ok).toBe(false);
    expect((await provider(fake, sheetsCred(`${GOOGLE_SHEETS_SCOPE} ${GMAIL_COMPOSE_SCOPE}`)).verifyAccess()).ok).toBe(false);
    expect((await provider(fake, null).verifyAccess()).ok).toBe(false);
    const noId = new HttpSheetsProvider({ spreadsheetId: undefined, tokens, store: store(sheetsCred()), logger, timeoutMs: 1000, http: fake.http });
    expect((await noId.verifyAccess()).ok).toBe(false);
  });

  it('inserts rows on first sync, creating the tab, with the stable row id in column A', async () => {
    const fake = new FakeSheets();
    const counts = await provider(fake).applyTab(outreachTab([
      { rowId: 'outreach:rec-1', cells: ['Clinic A', 'INITIAL_SENT'] },
      { rowId: 'outreach:rec-2', cells: ['Clinic B', 'DRAFT_READY'] },
    ]));
    expect(counts).toEqual({ inserted: 2, updated: 0, unchanged: 0, deleted: 0 });
    const grid = fake.sheets.get('Outreach')!.grid;
    expect(grid[0]![0]).toBe('row id (stable — do not edit)'); // header col A
    // Rows are ordered by stable id; the id lives in column A.
    expect(grid[1]![0]).toBe('outreach:rec-1');
    expect(grid[2]![0]).toBe('outreach:rec-2');
    expect(grid[1]!.slice(1)).toEqual(['Clinic A', 'INITIAL_SENT']);
  });

  it('is idempotent: an identical second sync reports everything unchanged', async () => {
    const fake = new FakeSheets();
    const snap = outreachTab([{ rowId: 'outreach:rec-1', cells: ['Clinic A', 'INITIAL_SENT'] }]);
    await provider(fake).applyTab(snap);
    const second = await provider(fake).applyTab(snap);
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1, deleted: 0 });
  });

  it('updates a changed row in place by stable id (never duplicates)', async () => {
    const fake = new FakeSheets();
    await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['Clinic A', 'DRAFT_READY'] }]));
    const counts = await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['Clinic A', 'INITIAL_SENT'] }]));
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0, deleted: 0 });
    const dataRows = fake.sheets.get('Outreach')!.grid.slice(1).filter((r) => r[0]);
    expect(dataRows).toHaveLength(1); // still exactly one row
    expect(dataRows[0]!.slice(1)).toEqual(['Clinic A', 'INITIAL_SENT']);
  });

  it('FULL sync removes rows no longer present in Postgres (stale)', async () => {
    const fake = new FakeSheets();
    await provider(fake).applyTab(outreachTab([
      { rowId: 'outreach:rec-1', cells: ['A', 'x'] },
      { rowId: 'outreach:rec-2', cells: ['B', 'y'] },
    ]));
    const counts = await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['A', 'x'] }]));
    expect(counts.deleted).toBe(1);
    const ids = fake.sheets.get('Outreach')!.grid.slice(1).filter((r) => r[0]).map((r) => r[0]);
    expect(ids).toEqual(['outreach:rec-1']);
  });

  it('SCOPED (upsert-only) sync never removes another campaign\'s rows', async () => {
    const fake = new FakeSheets();
    // Two campaigns' rows already present.
    await provider(fake).applyTab(outreachTab([
      { rowId: 'outreach:a-1', cells: ['A', 'x'] },
      { rowId: 'outreach:b-1', cells: ['B', 'y'] },
    ]));
    // Scoped sync of just campaign A's rows must leave b-1 untouched (deleteStale=false).
    const counts = await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:a-1', cells: ['A', 'x2'] }]), { deleteStale: false });
    expect(counts.deleted).toBe(0);
    const ids = fake.sheets.get('Outreach')!.grid.slice(1).filter((r) => r[0]).map((r) => r[0]).sort();
    expect(ids).toEqual(['outreach:a-1', 'outreach:b-1']);
  });

  it('is one-way: a manual Sheet edit is overwritten by the Postgres value, never imported back', async () => {
    const fake = new FakeSheets();
    await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['Clinic A', 'INITIAL_SENT'] }]));
    // Simulate a human editing a cell directly in the Sheet.
    fake.sheets.get('Outreach')!.grid[1]![2] = 'HAND_EDITED';
    // Re-sync the SAME Postgres value → the manual edit is treated as drift and overwritten.
    const counts = await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['Clinic A', 'INITIAL_SENT'] }]));
    expect(counts.updated).toBe(1);
    expect(fake.sheets.get('Outreach')!.grid[1]!.slice(1)).toEqual(['Clinic A', 'INITIAL_SENT']);
  });

  it('never leaves a partial write after a provider failure (single atomic request; throws)', async () => {
    const fake = new FakeSheets();
    await provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['A', 'x'] }]));
    const before = JSON.stringify(fake.sheets.get('Outreach')!.grid);
    fake.failUpdate = true;
    await expect(
      provider(fake).applyTab(outreachTab([{ rowId: 'outreach:rec-1', cells: ['A', 'CHANGED'] }])),
    ).rejects.toThrow(/writing tab/i);
    // The grid is exactly as before — no partial row was written.
    expect(JSON.stringify(fake.sheets.get('Outreach')!.grid)).toBe(before);
  });

  it('exposes no full-body or secret channel: it writes only the projected cells it is handed', async () => {
    const fake = new FakeSheets();
    // The Messages projection references bodies by content hash — there is no body field to leak.
    const snap: SheetTabSnapshot = {
      tab: 'Messages',
      header: ['subject', 'body version (sha256)'],
      rows: [{ rowId: 'message:m-1', cells: ['Vorschlag', 'abc123def456'] }],
    };
    await provider(fake).applyTab(snap);
    const written = JSON.stringify(fake.sheets.get('Messages')!.grid);
    expect(written).toContain('abc123def456');
    expect(written).not.toMatch(/refreshToken|access-token|Bearer/i);
  });
});
