import { AppError } from '../utils/errors.js';

/**
 * Global DRY_RUN kill switch for paid/network providers. Invariant: when DRY_RUN=true, NO real paid
 * or network provider may be constructed or called, even if its individual ALLOW_PAID_* flag is true.
 * Mock/local/read-only paths never call this, so they keep working under dry-run.
 *
 * Call this at each paid/network provider construction site, AFTER the provider's own
 * ALLOW_PAID flag and credential checks (so "missing flag/key" errors still surface first) and
 * immediately BEFORE the real client is constructed — so no network object is created under dry-run.
 */
export class DryRunLiveCallError extends AppError {
  constructor(label: string) {
    super('DRY_RUN_LIVE_BLOCKED', `DRY_RUN=true blocks the live paid/network provider "${label}". Set DRY_RUN=false for a real run.`);
  }
}

/** Throw if a live paid/network provider is being constructed while DRY_RUN is on. */
export function assertLiveCallsAllowed(dryRun: boolean, label: string): void {
  if (dryRun) throw new DryRunLiveCallError(label);
}
