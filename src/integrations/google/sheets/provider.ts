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
  deleted: number;
}

export interface SheetsProvider {
  readonly name: string;
  /** Whether this provider performs real external writes (mock = false). */
  readonly writesExternally: boolean;
  /** Current rows of a tab, keyed by rowId (for idempotent diffing). */
  readTab(tab: string): Promise<SheetRow[]>;
  /** Apply the desired snapshot idempotently and return the change counts. */
  applyTab(snapshot: SheetTabSnapshot): Promise<SheetSyncCounts>;
}
