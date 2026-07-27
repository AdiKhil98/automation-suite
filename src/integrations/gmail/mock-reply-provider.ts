import { type InboundMessage } from '../../domain/outreach/reply-classification.js';
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

  seedThread(threadId: string, messages: InboundMessage[]): void {
    this.threads.set(
      threadId,
      [...messages].sort((a, b) => a.receivedAtMs - b.receivedAtMs),
    );
  }

  async readThread(threadId: string): Promise<InboundMessage[]> {
    return [...(this.threads.get(threadId) ?? [])];
  }
}
