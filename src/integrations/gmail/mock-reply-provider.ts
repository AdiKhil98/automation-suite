import { type InboundMessage } from '../../domain/outreach/reply-classification.js';
import { type GmailReadFailure, GmailReadFailureLog } from './read-failure.js';
import { type GmailThreadReader } from './reply-provider.js';

/**
 * In-memory Gmail thread reader — the default and the only reader used in tests. It
 * serves pre-seeded thread messages and performs no network access. It is physically
 * incapable of sending, drafting, labelling, or modifying anything: it only returns
 * seeded data.
 */
export class MockGmailThreadReader implements GmailThreadReader {
  readonly name = 'mock';
  readonly readsExternally = false;
  private readonly threads = new Map<string, InboundMessage[]>();
  /** Threads seeded to FAIL, so strict-mode behaviour is testable with zero network access. */
  private readonly failing = new Map<string, GmailReadFailure>();
  private readonly failures = new GmailReadFailureLog();

  seedThread(threadId: string, messages: InboundMessage[]): void {
    this.threads.set(
      threadId,
      [...messages].sort((a, b) => a.receivedAtMs - b.receivedAtMs),
    );
  }

  /**
   * Make one thread's read fail the way the live reader fails: [] is still returned (so nothing is
   * inferred), and the failure is recorded structurally.
   */
  seedThreadReadFailure(threadId: string, failure?: Partial<GmailReadFailure>): void {
    this.failing.set(threadId, {
      scope: 'thread', id: threadId, reason: 'transport', status: null,
      detail: 'seeded mock read failure', ...failure,
    });
  }

  async readThread(threadId: string): Promise<InboundMessage[]> {
    const failure = this.failing.get(threadId);
    if (failure) {
      this.failures.record(failure);
      return [];
    }
    return [...(this.threads.get(threadId) ?? [])];
  }

  readFailures(): readonly GmailReadFailure[] {
    return this.failures.list();
  }
}
