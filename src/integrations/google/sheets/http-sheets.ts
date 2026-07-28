import { request as httpsRequest } from 'node:https';
import { type Logger } from 'pino';
import { AppError } from '../../../utils/errors.js';
import { type AccessTokenProvider } from '../../gmail/oauth.js';
import { type GmailTokenStore } from '../../gmail/token-store.js';
import {
  type ApplyTabOptions,
  type SheetsAccessCheck,
  type SheetRow,
  type SheetSyncCounts,
  type SheetsProvider,
  type SheetTabSnapshot,
} from './provider.js';

/**
 * Minimum Google Sheets scope needed to write values into an already-shared operator spreadsheet.
 * There is no narrower scope that can write arbitrary pre-existing spreadsheets (`spreadsheets.readonly`
 * cannot write; `drive.file` only reaches files the app itself created/opened). The provider refuses
 * to operate unless the stored credential's scope is EXACTLY this — a mixed/broader scope fails closed.
 */
export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Fixed Sheets API origin — never configurable. */
const SHEETS_API_ORIGIN = 'https://sheets.googleapis.com';

/** Header of column A on every tab; holds the stable row id used for idempotent diffing. */
const ROW_ID_HEADER = 'row id (stable — do not edit)';

interface SheetsHttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

export interface SheetsHttpRequestArgs {
  method: 'GET' | 'POST';
  /** Always begins with `/v4/spreadsheets/`. */
  path: string;
  token: string;
  body?: unknown;
  timeoutMs: number;
}

/**
 * Injectable HTTP function so the provider is unit-testable without a network. Implementations MUST
 * perform only the requested GET (reads) or `:batchUpdate` POST (the single atomic write) — no other
 * operation exists. The Sheets API has no delete/rename endpoint reachable from these two calls.
 */
export type SheetsHttp = (args: SheetsHttpRequestArgs) => Promise<SheetsHttpResult>;

interface SheetMeta {
  title: string;
  sheetIdByTitle: Map<string, number>;
}

/**
 * Real, guarded Google Sheets provider (Phase 17A3). Postgres stays authoritative; the Sheet is a
 * ONE-WAY operator projection. This provider only ever:
 *   - GETs spreadsheet metadata (titles + sheetIds),
 *   - GETs the values of a tab (to diff),
 *   - POSTs `:batchUpdate` to (a) create a missing tab and (b) write a tab's rows in ONE atomic call.
 *
 * It never reads a Sheet value back into Postgres, never dumps a secret or internal database
 * metadata (it writes exactly the projected cells it is handed — message bodies are already reduced
 * to a content hash upstream), and it refuses to operate unless the stored credential's scope is
 * EXACTLY {@link GOOGLE_SHEETS_SCOPE}. A write is a single atomic `updateCells` request per tab, so a
 * transport failure leaves the tab in its previous committed state (never a partial row write).
 */
export class HttpSheetsProvider implements SheetsProvider {
  readonly name = 'http';
  readonly writesExternally = true;
  private readonly http: SheetsHttp;
  private meta: SheetMeta | null = null;

  constructor(
    private readonly deps: {
      spreadsheetId: string | undefined;
      tokens: AccessTokenProvider;
      store: GmailTokenStore;
      logger: Logger;
      timeoutMs: number;
      http?: SheetsHttp;
    },
  ) {
    this.http = deps.http ?? defaultSheetsHttp;
  }

  private spreadsheetId(): string {
    const id = this.deps.spreadsheetId;
    if (!id) throw new AppError('SHEETS_NO_SPREADSHEET_ID', 'GOOGLE_SHEETS_SPREADSHEET_ID is not configured.');
    return id;
  }

  /**
   * Non-mutating precondition check for readiness/verification. Confirms a credential exists, its
   * scope is EXACTLY the Sheets scope, the spreadsheet id is set, and the spreadsheet is reachable;
   * returns its title and existing tab titles. Performs zero writes.
   */
  async verifyAccess(): Promise<SheetsAccessCheck> {
    const cred = await this.deps.store.load();
    if (!cred) {
      return { ok: false, reason: 'no Google Sheets credential — run `pnpm cli sheets-auth` first' };
    }
    const scopes = cred.scope.split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GOOGLE_SHEETS_SCOPE) {
      return { ok: false, reason: `stored scope is not strictly the Sheets scope (${cred.scope}); expected exactly ${GOOGLE_SHEETS_SCOPE}` };
    }
    if (!this.deps.spreadsheetId) {
      return { ok: false, reason: 'GOOGLE_SHEETS_SPREADSHEET_ID is not configured' };
    }
    try {
      const meta = await this.fetchMeta();
      return { ok: true, title: meta.title, existingTabs: [...meta.sheetIdByTitle.keys()] };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read the current rows of a tab (skipping the header). Missing tab → []. */
  async readTab(tab: string): Promise<SheetRow[]> {
    const token = await this.deps.tokens.getAccessToken();
    const meta = await this.fetchMeta();
    if (!meta.sheetIdByTitle.has(tab)) return [];
    const range = encodeURIComponent(quoteTitle(tab));
    const res = await this.http({
      method: 'GET',
      path: `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId())}/values/${range}?majorDimension=ROWS`,
      token,
      timeoutMs: this.deps.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300 || !res.json) {
      throw new AppError('SHEETS_READ_FAILED', `reading tab "${tab}" failed (status ${String(res.status)})`);
    }
    const values = Array.isArray(res.json.values) ? (res.json.values as unknown[]) : [];
    const rows: SheetRow[] = [];
    // values[0] is the header row; every data row is [rowId, ...cells].
    for (let i = 1; i < values.length; i += 1) {
      const raw = values[i];
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const [rowId, ...cells] = raw.map((c) => (c === null || c === undefined ? '' : String(c)));
      if (!rowId) continue;
      rows.push({ rowId, cells });
    }
    return rows;
  }

  /**
   * Apply one tab idempotently. Reads current rows, diffs against the desired snapshot (counting
   * inserted/updated/unchanged/deleted), then writes the resulting rows in a SINGLE atomic
   * `updateCells` request. A SCOPED sync (deleteStale=false) merges the desired rows over the current
   * rows and never removes rows it did not compute, so another campaign's rows survive untouched.
   */
  async applyTab(snapshot: SheetTabSnapshot, options?: ApplyTabOptions): Promise<SheetSyncCounts> {
    const deleteStale = options?.deleteStale ?? true;
    const token = await this.deps.tokens.getAccessToken();
    const sheetId = await this.ensureTab(snapshot.tab, token);

    const current = await this.readTab(snapshot.tab);
    const currentById = new Map(current.map((r) => [r.rowId, r.cells]));
    const desiredById = new Map(snapshot.rows.map((r) => [r.rowId, r.cells]));

    const counts: SheetSyncCounts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
    for (const [rowId, cells] of desiredById) {
      const existing = currentById.get(rowId);
      if (!existing) counts.inserted += 1;
      else if (!cellsEqual(existing, cells)) counts.updated += 1;
      else counts.unchanged += 1;
    }

    // Build the final rowId → cells map that the tab should hold after this apply.
    const finalById = new Map<string, string[]>();
    if (!deleteStale) {
      for (const [rowId, cells] of currentById) finalById.set(rowId, cells);
    } else {
      for (const rowId of currentById.keys()) {
        if (!desiredById.has(rowId)) counts.deleted += 1;
      }
    }
    for (const [rowId, cells] of desiredById) finalById.set(rowId, cells);

    // Deterministic, stable row order (by rowId) so re-runs never reshuffle the sheet.
    const orderedIds = [...finalById.keys()].sort();
    const header = [ROW_ID_HEADER, ...snapshot.header];
    const dataRows = orderedIds.map((rowId) => [rowId, ...(finalById.get(rowId) ?? [])]);
    const grid = [header, ...dataRows];

    // Blank any rows that previously existed beyond the new content so no stale cells linger.
    const prevRowCount = 1 + current.length;
    const width = header.length;
    const totalRows = Math.max(grid.length, prevRowCount);
    const rows: { values: { userEnteredValue: { stringValue: string } }[] }[] = [];
    for (let i = 0; i < totalRows; i += 1) {
      const source = grid[i] ?? [];
      const cellValues: { userEnteredValue: { stringValue: string } }[] = [];
      for (let c = 0; c < width; c += 1) {
        cellValues.push({ userEnteredValue: { stringValue: source[c] ?? '' } });
      }
      rows.push({ values: cellValues });
    }

    const res = await this.http({
      method: 'POST',
      path: `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId())}:batchUpdate`,
      token,
      timeoutMs: this.deps.timeoutMs,
      body: {
        requests: [
          {
            updateCells: {
              start: { sheetId, rowIndex: 0, columnIndex: 0 },
              rows,
              fields: 'userEnteredValue',
            },
          },
        ],
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new AppError('SHEETS_WRITE_FAILED', `writing tab "${snapshot.tab}" failed (status ${String(res.status)}); no partial rows were written (single atomic request).`);
    }
    return counts;
  }

  /** Resolve (and cache) spreadsheet metadata: title + title→sheetId. */
  private async fetchMeta(): Promise<SheetMeta> {
    if (this.meta) return this.meta;
    const token = await this.deps.tokens.getAccessToken();
    const res = await this.http({
      method: 'GET',
      path: `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId())}?fields=properties.title,sheets.properties(sheetId,title)`,
      token,
      timeoutMs: this.deps.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300 || !res.json) {
      throw new AppError('SHEETS_METADATA_FAILED', `spreadsheet not reachable (status ${String(res.status)}); check the id, credentials, and that the sheet is shared with the authorized account.`);
    }
    const props = (res.json.properties ?? {}) as { title?: unknown };
    const sheets = Array.isArray(res.json.sheets) ? (res.json.sheets as { properties?: { sheetId?: unknown; title?: unknown } }[]) : [];
    const sheetIdByTitle = new Map<string, number>();
    for (const s of sheets) {
      const t = s.properties?.title;
      const id = s.properties?.sheetId;
      if (typeof t === 'string' && typeof id === 'number') sheetIdByTitle.set(t, id);
    }
    this.meta = { title: typeof props.title === 'string' ? props.title : '(untitled)', sheetIdByTitle };
    return this.meta;
  }

  /** Ensure a tab exists (creating it via addSheet when missing) and return its sheetId. */
  private async ensureTab(tab: string, token: string): Promise<number> {
    const meta = await this.fetchMeta();
    const existing = meta.sheetIdByTitle.get(tab);
    if (existing !== undefined) return existing;
    const res = await this.http({
      method: 'POST',
      path: `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId())}:batchUpdate`,
      token,
      timeoutMs: this.deps.timeoutMs,
      body: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    if (res.status < 200 || res.status >= 300 || !res.json) {
      throw new AppError('SHEETS_ADD_TAB_FAILED', `creating tab "${tab}" failed (status ${String(res.status)}).`);
    }
    const replies = Array.isArray(res.json.replies) ? (res.json.replies as { addSheet?: { properties?: { sheetId?: unknown } } }[]) : [];
    const newId = replies[0]?.addSheet?.properties?.sheetId;
    if (typeof newId !== 'number') {
      // Fall back to a metadata refresh if the reply shape was unexpected.
      this.meta = null;
      const refreshed = await this.fetchMeta();
      const found = refreshed.sheetIdByTitle.get(tab);
      if (found === undefined) throw new AppError('SHEETS_ADD_TAB_FAILED', `tab "${tab}" not found after creation.`);
      return found;
    }
    meta.sheetIdByTitle.set(tab, newId);
    return newId;
  }
}

function cellsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Quote a sheet title for an A1 range (single quotes, doubled inside). */
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Real HTTPS request against the Sheets API. NOT exercised by the standard test suite. */
const defaultSheetsHttp: SheetsHttp = ({ method, path, token, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const url = new URL(SHEETS_API_ORIGIN + path);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.byteLength);
    }
    const req = httpsRequest(url, { method, timeout: timeoutMs, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null;
        try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('sheets request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
