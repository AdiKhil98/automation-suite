import { type RawDeliveryNotification, type TrackedOutbound } from '../../domain/outreach/delivery.js';
import { type GmailBounceReader } from './bounce-reader.js';
import { type GmailReadFailure, GmailReadFailureLog } from './read-failure.js';

/**
 * In-memory Gmail bounce reader — the default and the only reader used in tests. It
 * serves pre-seeded delivery notifications and performs no network access. It is
 * physically incapable of sending, drafting, labelling, or modifying anything: it only
 * returns seeded data. By default it returns every seeded notification (the domain does
 * the connected-to-tracked-outbound correlation and fail-closed filtering).
 */
export class MockGmailBounceReader implements GmailBounceReader {
  readonly name = 'mock';
  readonly readsExternally = false;
  private readonly notifications: RawDeliveryNotification[] = [];
  private readonly failures = new GmailReadFailureLog();
  private seededFailure: GmailReadFailure | null = null;

  seedNotification(n: RawDeliveryNotification): void {
    this.notifications.push(n);
  }

  /**
   * Make the scoped search fail the way the live reader fails: [] is still returned (so no bounce
   * is inferred), and the failure is recorded structurally.
   */
  seedReadFailure(failure?: Partial<GmailReadFailure>): void {
    this.seededFailure = {
      scope: 'search', id: null, reason: 'transport', status: null,
      detail: 'seeded mock read failure', ...failure,
    };
  }

  async findDeliveryNotifications(_input: {
    outbounds: readonly TrackedOutbound[];
  }): Promise<RawDeliveryNotification[]> {
    if (this.seededFailure) {
      this.failures.record(this.seededFailure);
      return [];
    }
    return [...this.notifications];
  }

  readFailures(): readonly GmailReadFailure[] {
    return this.failures.list();
  }
}
