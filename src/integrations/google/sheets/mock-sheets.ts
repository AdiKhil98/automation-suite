import {
  type SheetRow,
  type SheetSyncCounts,
  type SheetsProvider,
  type SheetTabSnapshot,
} from './provider.js';

/**
 * In-memory Sheets provider — the default and the only provider tests use. It never
 * touches the network. It faithfully implements idempotent upsert semantics keyed by
 * stable rowId so sync logic and counts can be verified deterministically. State
 * persists for the lifetime of the instance, letting a test run two syncs and assert
 * the second reports everything unchanged.
 */
export class MockSheetsProvider implements SheetsProvider {
  readonly name = 'mock';
  readonly writesExternally = false;
  private readonly tabs = new Map<string, Map<string, string[]>>();

  async readTab(tab: string): Promise<SheetRow[]> {
    const t = this.tabs.get(tab);
    if (!t) return [];
    return [...t.entries()].map(([rowId, cells]) => ({ rowId, cells: [...cells] }));
  }

  async applyTab(snapshot: SheetTabSnapshot): Promise<SheetSyncCounts> {
    const current = this.tabs.get(snapshot.tab) ?? new Map<string, string[]>();
    const desiredIds = new Set(snapshot.rows.map((r) => r.rowId));
    const counts: SheetSyncCounts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };

    for (const row of snapshot.rows) {
      const existing = current.get(row.rowId);
      if (!existing) {
        current.set(row.rowId, [...row.cells]);
        counts.inserted += 1;
      } else if (!cellsEqual(existing, row.cells)) {
        current.set(row.rowId, [...row.cells]);
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }
    }
    // Rows that no longer exist in Postgres are removed from the projection.
    for (const id of [...current.keys()]) {
      if (!desiredIds.has(id)) {
        current.delete(id);
        counts.deleted += 1;
      }
    }
    this.tabs.set(snapshot.tab, current);
    return counts;
  }

  /** Test helper: current cell content of a tab. */
  dump(tab: string): Record<string, string[]> {
    const t = this.tabs.get(tab);
    return t ? Object.fromEntries(t) : {};
  }
}

function cellsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
