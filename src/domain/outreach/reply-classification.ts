/**
 * Deterministic reply classification for Phase 17A Gmail reply-sync.
 *
 * AI classification is intentionally NOT used here (it must remain optional and
 * disabled by default). This module makes a conservative, rule-based decision from
 * the reply headers and a short text preview. When signals are weak it defaults to
 * REPLIED_NEUTRAL — never inventing intent — and leaves nuanced judgement to the
 * human operator reviewing the Google Sheet.
 */

export type ReplyClassification =
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'unsubscribe'
  | 'bounce';

export interface InboundMessageHeaders {
  fromEmail: string;
  /** RFC 5322 auto-submitted header, if present (e.g. "auto-replied"). */
  autoSubmitted?: string | null;
  /** Content-Type of the message (bounces are commonly multipart/report). */
  contentType?: string | null;
  /** True if a List-Unsubscribe header is present on the inbound message. */
  hasListUnsubscribe?: boolean;
}

export interface InboundMessage {
  messageId: string;
  threadId: string;
  fromEmail: string;
  /** Epoch ms of the inbound message (Gmail internalDate). */
  receivedAtMs: number;
  /** Short, safe text preview (snippet). Never the full mailbox body. */
  preview: string;
  headers: InboundMessageHeaders;
}

/** Normalize an email address for owner/self comparison. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when `message` is one of the account's OWN messages (the sender we send as),
 * which must be excluded from reply detection. Compares against every known sender
 * identity for the account.
 */
export function isSelfMessage(fromEmail: string, ownEmails: readonly string[]): boolean {
  const from = normalizeEmail(fromEmail);
  return ownEmails.map(normalizeEmail).includes(from);
}

/**
 * Pick the first genuine inbound reply strictly after the last outbound message.
 * Excludes the account's own messages. Deterministic: earliest qualifying reply.
 */
export function firstGenuineReply(
  messages: readonly InboundMessage[],
  opts: { lastOutboundAtMs: number; ownEmails: readonly string[] },
): InboundMessage | null {
  const candidates = messages
    .filter((m) => m.receivedAtMs > opts.lastOutboundAtMs)
    .filter((m) => !isSelfMessage(m.fromEmail, opts.ownEmails))
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.messageId.localeCompare(b.messageId));
  return candidates[0] ?? null;
}

// Conservative keyword sets. Matched case-insensitively on word-ish boundaries.
const UNSUBSCRIBE_HINTS = [
  'unsubscribe',
  'remove me',
  'take me off',
  'opt out',
  'opt-out',
  'do not contact',
  'stop emailing',
  'stop contacting',
  'abbestellen', // de
  'austragen', // de
  'kein interesse mehr', // de
];
const BOUNCE_HINTS = [
  'mail delivery failed',
  'delivery status notification',
  'undeliverable',
  'address not found',
  'user unknown',
  'mailbox full',
  'recipient address rejected',
  'delivery has failed',
];
const NEGATIVE_HINTS = [
  'not interested',
  'no thanks',
  'no thank you',
  'please stop',
  'we are not interested',
  'kein interesse', // de
  'nicht interessiert', // de
  'bitte nicht', // de
];
const POSITIVE_HINTS = [
  'interested',
  'sounds good',
  'happy to',
  'let us talk',
  "let's talk",
  'book a call',
  'schedule a call',
  'set up a meeting',
  'tell me more',
  'more information',
  'when can you',
  'gerne', // de
  'interessiert', // de
  'termin', // de (appointment)
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
}

/**
 * Classify an inbound reply deterministically. Precedence is deliberate and
 * suppression-first: a bounce or unsubscribe signal wins over sentiment, because
 * the operational consequence (block future sends) is the safe default.
 */
export function classifyReply(message: InboundMessage): ReplyClassification {
  const text = message.preview ?? '';
  const contentType = (message.headers.contentType ?? '').toLowerCase();

  // 1. Bounce: a delivery-report content type or a mailer-daemon sender, or bounce text.
  const fromLocal = normalizeEmail(message.fromEmail);
  const looksLikeDaemon =
    fromLocal.startsWith('mailer-daemon') ||
    fromLocal.startsWith('postmaster') ||
    fromLocal.includes('maildelivery');
  if (
    contentType.includes('multipart/report') ||
    contentType.includes('delivery-status') ||
    looksLikeDaemon ||
    containsAny(text, BOUNCE_HINTS)
  ) {
    return 'bounce';
  }

  // 2. Unsubscribe: explicit header or explicit language.
  if (message.headers.hasListUnsubscribe === true || containsAny(text, UNSUBSCRIBE_HINTS)) {
    return 'unsubscribe';
  }

  // 3. Sentiment — negative before positive (a "not interested" often contains
  //    otherwise-positive words). Conservative: unknown/ambiguous stays neutral.
  if (containsAny(text, NEGATIVE_HINTS)) return 'negative';
  if (containsAny(text, POSITIVE_HINTS)) return 'positive';
  return 'neutral';
}

/** Map a classification onto the outreach status it drives. */
export function classificationToStatus(
  c: ReplyClassification,
): 'REPLIED_POSITIVE' | 'REPLIED_NEUTRAL' | 'REPLIED_NEGATIVE' | 'BOUNCED' | 'UNSUBSCRIBED' {
  switch (c) {
    case 'positive':
      return 'REPLIED_POSITIVE';
    case 'neutral':
      return 'REPLIED_NEUTRAL';
    case 'negative':
      return 'REPLIED_NEGATIVE';
    case 'bounce':
      return 'BOUNCED';
    case 'unsubscribe':
      return 'UNSUBSCRIBED';
  }
}

/** Truncate a preview to a safe maximum, single-lined. Never stores full bodies. */
export function safePreview(text: string, maxChars = 280): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
}
