import { AppError } from '../../../utils/errors.js';
import {
  type SheetRow,
  type SheetSyncCounts,
  type SheetsProvider,
  type SheetTabSnapshot,
} from './provider.js';

/**
 * Real Google Sheets provider — the Phase 17B wiring point. Phase 17A intentionally
 * ships the ABSTRACTION and the mock only; no live Sheet write occurs during Phase
 * 17A. This provider therefore fails CLOSED: it validates configuration but refuses
 * to perform any external write until Phase 17B is approved and the credentials
 * below are provisioned.
 *
 * Credential requirements (documented in docs/OPERATIONS.md), to be provisioned in
 * Phase 17B:
 *  - A Google Cloud service account (or OAuth client) with the
 *    `https://www.googleapis.com/auth/spreadsheets` scope.
 *  - The target spreadsheet shared with that principal (editor).
 *  - GOOGLE_SHEETS_SPREADSHEET_ID set to the target spreadsheet id.
 *  - A git-ignored 0600 credentials file (never in .env, DB, logs, or git).
 *
 * The idempotent contract is: column A of each tab holds the stable rowId; upserts
 * match on that column so re-running the sync updates rows in place.
 */
export class HttpSheetsProvider implements SheetsProvider {
  readonly name = 'http';
  readonly writesExternally = true;
  constructor(private readonly spreadsheetId: string | undefined) {}

  private refuse(): never {
    throw new AppError(
      'SHEETS_HTTP_NOT_ENABLED',
      'Live Google Sheets writes are not enabled in Phase 17A. Real Sheet sync is a Phase 17B setup step; ' +
        'use the mock provider (GOOGLE_SHEETS_PROVIDER=mock) for tracking. See docs/OPERATIONS.md.',
    );
  }

  async readTab(_tab: string): Promise<SheetRow[]> {
    void this.spreadsheetId;
    this.refuse();
  }

  async applyTab(_snapshot: SheetTabSnapshot): Promise<SheetSyncCounts> {
    this.refuse();
  }
}
