/**
 * Phase 17A Google Sheets boundary. Postgres is authoritative; a Sheet is a
 * read-friendly OPERATOR PROJECTION only. Google-specific HTTP never crosses this
 * interface. A provider exposes just enough to read the current rows of a tab (to
 * diff) and to upsert/delete rows by a stable row id. The mock provider is the
 * default and is the only provider used in tests. Any real write additionally
 * requires GOOGLE_SHEETS_SYNC_ENABLED=true AND an explicit --confirm flag.
 *
 * Manual edits in the Sheet are NEVER read back as authoritative database mutations:
 * the provider is write-mostly for projection, and sync always computes desired rows
 * from Postgres, never the reverse.
 */

/** A single projected row: a stable id plus ordered string cells. */
export interface SheetRow {
  /** Stable identifier (e.g. `outreach:<recordId>`); the diff key. Never secret. */
  rowId: string;
  cells: string[];
}

export interface SheetTabSnapshot {
  tab: string;
  /** Header row (column names), for first-time tab creation. */
  header: string[];
  rows: SheetRow[];
}

export interface SheetSyncCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows removed because they are no longer present in Postgres (stale). */
  deleted: number;
}

/**
 * Per-apply options. `deleteStale` controls whether rows present in the Sheet but absent from the
 * desired (Postgres) snapshot are removed. A FULL sync (all outreach) deletes stale rows so the
 * projection exactly mirrors Postgres. A SCOPED sync (one campaign) is upsert-only (deleteStale=false)
 * so rows belonging to other campaigns are never touched. Postgres is always authoritative; a Sheet
 * value is never read back as a database mutation.
 */
export interface ApplyTabOptions {
  deleteStale?: boolean;
}

/** Result of a non-mutating credential/spreadsheet access check (readiness/verification). */
export interface SheetsAccessCheck {
  ok: boolean;
  reason?: string;
  /** Spreadsheet title (when reachable). Never a secret. */
  title?: string;
  /** Tab titles that already exist in the spreadsheet. */
  existingTabs?: string[];
}

export interface SheetsProvider {
  readonly name: string;
  /** Whether this provider performs real external writes (mock = false). */
  readonly writesExternally: boolean;
  /** Current rows of a tab, keyed by rowId (for idempotent diffing). */
  readTab(tab: string): Promise<SheetRow[]>;
  /** Apply the desired snapshot idempotently and return the change counts. */
  applyTab(snapshot: SheetTabSnapshot, options?: ApplyTabOptions): Promise<SheetSyncCounts>;
}
