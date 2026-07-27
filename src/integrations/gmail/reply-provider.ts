import { type InboundMessage } from '../../domain/outreach/reply-classification.js';

/**
 * Phase 17A Gmail reply boundary — STRICTLY READ-ONLY. The only operation is reading
 * the messages of a KNOWN thread that already belongs to a tracked outreach record.
 * There is no send, draft, label, archive, or modify operation on this interface, by
 * construction. Google-specific HTTP never crosses this line, and a real reader
 * requires the read-only Gmail scope plus GMAIL_REPLY_SYNC_ENABLED=true. The mock is
 * the default and the only reader used in tests.
 */
export interface GmailThreadReader {
  readonly name: string;
  /** Whether this reader performs real external reads (mock = false). */
  readonly readsExternally: boolean;
  /**
   * Read the messages of one thread by id. Returns them oldest-first. Never mutates
   * anything. A missing/inaccessible thread returns an empty array (fail-closed: no
   * reply is inferred).
   */
  readThread(threadId: string): Promise<InboundMessage[]>;
}
