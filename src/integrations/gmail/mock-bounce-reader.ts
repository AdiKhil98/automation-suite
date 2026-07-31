import { type RawDeliveryNotification, type TrackedOutbound } from '../../domain/outreach/delivery.js';
import { type GmailBounceReader } from './bounce-reader.js';

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

  seedNotification(n: RawDeliveryNotification): void {
    this.notifications.push(n);
  }

  async findDeliveryNotifications(_input: {
    outbounds: readonly TrackedOutbound[];
  }): Promise<RawDeliveryNotification[]> {
    return [...this.notifications];
  }
}
