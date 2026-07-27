import { type GmailThreadReader } from '../../integrations/gmail/reply-provider.js';
import { type OutreachService } from './outreach-service.js';
import {
  classifyReply,
  firstGenuineReply,
  type ReplyClassification,
} from './reply-classification.js';

/**
 * Phase 17A Gmail reply-sync. Read-only detection over ONLY the threads that belong
 * to tracked outreach records. Excludes the account's own messages, considers only
 * inbound messages strictly after the last outbound message, classifies
 * deterministically, and (via OutreachService) records the reply and cancels pending
 * follow-ups. Nothing here sends, drafts, labels, archives, or modifies Gmail.
 */

export interface TrackedThread {
  outreachRecordId: string;
  threadId: string;
  /** Epoch ms of the latest outbound message for this record. */
  lastOutboundAtMs: number;
  /** Gmail message ids already recorded as replies (skip to stay idempotent). */
  handledMessageIds: readonly string[];
}

export interface DetectedReply {
  outreachRecordId: string;
  threadId: string;
  messageId: string;
  fromEmail: string;
  receivedAtMs: number;
  preview: string;
  classification: ReplyClassification;
}

/**
 * Detect the first genuine, not-yet-handled inbound reply on one tracked thread.
 * Returns null when there is no new reply (fail-closed: silence is never a reply).
 */
export async function detectReply(
  reader: GmailThreadReader,
  thread: TrackedThread,
  ownEmails: readonly string[],
): Promise<DetectedReply | null> {
  const messages = await reader.readThread(thread.threadId);
  const handled = new Set(thread.handledMessageIds);
  const candidate = firstGenuineReply(
    messages.filter((m) => !handled.has(m.messageId)),
    { lastOutboundAtMs: thread.lastOutboundAtMs, ownEmails },
  );
  if (!candidate) return null;
  return {
    outreachRecordId: thread.outreachRecordId,
    threadId: thread.threadId,
    messageId: candidate.messageId,
    fromEmail: candidate.fromEmail,
    receivedAtMs: candidate.receivedAtMs,
    preview: candidate.preview,
    classification: classifyReply(candidate),
  };
}

export interface ReplySyncReport {
  reader: string;
  readExternally: boolean;
  threadsChecked: number;
  repliesApplied: DetectedReply[];
}

/**
 * Run reply detection across all tracked threads and apply each detected reply.
 * Deterministic order (threads as given). Application is delegated to
 * OutreachService, so the reply row, status transition, and follow-up cancellation
 * are one atomic unit per record.
 */
export async function runReplySync(args: {
  reader: GmailThreadReader;
  service: OutreachService;
  threads: readonly TrackedThread[];
  ownEmails: readonly string[];
}): Promise<ReplySyncReport> {
  const applied: DetectedReply[] = [];
  for (const thread of args.threads) {
    const detected = await detectReply(args.reader, thread, args.ownEmails);
    if (!detected) continue;
    await args.service.applyReply({
      outreachRecordId: detected.outreachRecordId,
      gmailThreadId: detected.threadId,
      gmailMessageId: detected.messageId,
      fromEmail: detected.fromEmail,
      receivedAtMs: detected.receivedAtMs,
      preview: detected.preview,
      classification: detected.classification,
    });
    applied.push(detected);
  }
  return {
    reader: args.reader.name,
    readExternally: args.reader.readsExternally,
    threadsChecked: args.threads.length,
    repliesApplied: applied,
  };
}
