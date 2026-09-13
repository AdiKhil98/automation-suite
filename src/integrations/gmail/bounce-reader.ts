import { type RawDeliveryNotification, type TrackedOutbound } from '../../domain/outreach/delivery.js';
import { type GmailReadFailure } from './read-failure.js';

/**
 * Phase 17C Gmail bounce-reconciliation boundary — STRICTLY READ-ONLY. The only
 * operation is finding Delivery Status Notifications (DSNs) that are connected to a
 * KNOWN set of tracked outbound messages. There is no send, draft, label, archive, or
 * modify operation on this interface, by construction. A DSN may arrive in a separate
 * Gmail thread from the outbound, so — unlike the reply reader — this boundary is
 * permitted to run a scoped search, but ONLY for delivery notifications tied to the
 * tracked outbounds it is given. The mock is the default and the only reader used in tests.
 */
export interface GmailBounceReader {
  readonly name: string;
  /** Whether this reader performs real external reads (mock = false). */
  readonly readsExternally: boolean;
  /**
   * Return candidate delivery notifications connected to the given tracked outbounds.
   * Returns raw fields only (headers + delivery-status block + referenced Message-IDs);
   * correlation and classification happen in the domain. A read failure returns an empty
   * array (fail-closed: no bounce is ever inferred from an error). Never mutates anything.
   */
  findDeliveryNotifications(input: {
    outbounds: readonly TrackedOutbound[];
  }): Promise<RawDeliveryNotification[]>;
  /**
   * Reads (the scoped search and each notification fetch) that did NOT complete during this run,
   * as structured data rather than log text. Empty means every read actually completed. A search
   * that succeeded and matched nothing, or a message that was read but is not a usable DSN, is
   * NOT a failure and is never recorded.
   */
  readFailures(): readonly GmailReadFailure[];
}
