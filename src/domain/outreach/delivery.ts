/**
 * Phase 17C — delivery failure reconciliation (domain core).
 *
 * When Gmail cannot deliver an outbound message it emits a separate Delivery Status
 * Notification (DSN). The outbound message stays historically *sent* (its immutable
 * message row is never mutated), but the outreach RECORD state must become BOUNCED so
 * no follow-up is ever sent to an address that rejected the mail.
 *
 * This module is deterministic and side-effect-free. It parses the standardized DSN
 * fields, decides whether a failure is permanent or temporary, and — critically —
 * correlates a DSN to EXACTLY ONE tracked outbound message, failing closed on any
 * ambiguity. No AI is involved: correlation and classification are pure rules.
 */

import { normalizeEmail, safePreview } from './reply-classification.js';

/** Terminal disposition recorded for a tracked outbound after reconciliation. */
export type DeliveryStatus = 'DELIVERED' | 'BOUNCED' | 'DELIVERY_UNKNOWN';

/** Whether a failure is permanent (5.x.x), transient (4.x.x), or undetermined. */
export type DeliveryPermanence = 'PERMANENT' | 'TEMPORARY' | 'UNKNOWN';

/**
 * The standardized fields extracted from a Gmail DSN. The integration layer walks the
 * Gmail `multipart/report` + `message/delivery-status` structure and produces this
 * shape; the domain never touches Gmail payloads directly. Only the fields needed for
 * correlation, classification, and an auditable diagnostic are represented — never the
 * full mailbox body.
 */
export interface ParsedDsn {
  /** The DSN's OWN Gmail message id — the idempotency key (recorded at most once). */
  dsnGmailMessageId: string;
  /** The DSN's OWN Gmail thread id (may differ from the outbound thread). */
  dsnGmailThreadId: string;
  /** Epoch ms the DSN was received. */
  receivedAtMs: number;
  /** DSN sender (typically mailer-daemon@ / postmaster@). */
  fromEmail: string;
  subject: string;
  contentType: string | null;
  /** RFC 3464 `Final-Recipient` address (after the `rfc822;` prefix is stripped). */
  finalRecipient: string | null;
  /** RFC 3464 `Original-Recipient` address, if present. */
  originalRecipient: string | null;
  /** RFC 3464 `Action` (e.g. `failed`, `delayed`, `delivered`). */
  action: string | null;
  /** RFC 3463 enhanced `Status` (e.g. `5.7.1`). */
  status: string | null;
  /** RFC 3464 `Diagnostic-Code` value (e.g. `smtp; 550 5.7.1 ...`). */
  diagnosticCode: string | null;
  /** `X-Failed-Recipients` header, if present. */
  xFailedRecipients: string | null;
  /**
   * RFC 5322 `Message-ID`s the DSN references (from `References` / `In-Reply-To`, plus
   * the `Message-ID` of the embedded original message). Used for exact correlation.
   */
  referencedMessageIds: readonly string[];
  /** Short, safe preview only (never the full body). */
  preview: string;
}

/**
 * A tracked outbound message that a DSN might correspond to. The correlation input is
 * drawn ONLY from tracked outreach records — never from the wider mailbox.
 */
export interface TrackedOutbound {
  outreachRecordId: string;
  outreachMessageId: string;
  /** Gmail message id of the outbound (recorded when the message was sent). */
  gmailMessageId: string;
  /** Gmail thread id of the outbound. */
  gmailThreadId: string;
  /** The exact contact the outbound was addressed to (lowercased). */
  contactEmail: string;
  /** The outbound's RFC 5322 Message-ID, if it was captured (optional). */
  rfcMessageId?: string | null;
}

/**
 * The raw fields a Gmail reader extracts from a delivery-notification message before
 * domain parsing. The reader walks the Gmail `multipart/report` structure and pulls out
 * the headers, the `message/delivery-status` text block, and any referenced Message-IDs;
 * it never returns the full mailbox body. This shape lives in the domain (like
 * `InboundMessage`) so the reader boundary depends on the domain, not the reverse.
 */
export interface RawDeliveryNotification {
  gmailMessageId: string;
  gmailThreadId: string;
  receivedAtMs: number;
  fromEmail: string;
  subject: string;
  contentType: string | null;
  xFailedRecipients: string | null;
  /** RFC Message-IDs referenced (References / In-Reply-To + embedded original Message-ID). */
  referencedMessageIds: string[];
  /** The raw `message/delivery-status` body block, if present. */
  deliveryStatusText: string | null;
  /** Gmail's own short snippet (stored truncated as a safe preview). */
  snippet: string;
}

/** Assemble a {@link ParsedDsn} from the raw reader fields (pure; runs the RFC parse). */
export function parseDsn(raw: RawDeliveryNotification): ParsedDsn {
  const ds = parseDeliveryStatus(raw.deliveryStatusText);
  return {
    dsnGmailMessageId: raw.gmailMessageId,
    dsnGmailThreadId: raw.gmailThreadId,
    receivedAtMs: raw.receivedAtMs,
    fromEmail: normalizeEmail(raw.fromEmail),
    subject: raw.subject,
    contentType: raw.contentType,
    finalRecipient: ds.finalRecipient ?? normalizeDsnAddress(raw.xFailedRecipients),
    originalRecipient: ds.originalRecipient,
    action: ds.action,
    status: ds.status,
    diagnosticCode: ds.diagnosticCode,
    xFailedRecipients: raw.xFailedRecipients,
    referencedMessageIds: [...new Set(raw.referencedMessageIds.map((s) => s.trim()).filter(Boolean))],
    preview: safePreview(raw.snippet),
  };
}

/** How a DSN was matched to its outbound — recorded for auditability. */
export type CorrelationSignal = 'THREAD_ID' | 'RFC_MESSAGE_ID' | 'RECIPIENT';

export type CorrelationResult =
  | { kind: 'matched'; outbound: TrackedOutbound; signal: CorrelationSignal }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matchedRecordIds: string[] };

/**
 * Subject / sender patterns that mark a Gmail message as a delivery notification. Used
 * by the integration layer to scope its search; also used to double-check a candidate
 * before it is treated as a DSN.
 */
const DSN_SUBJECT_PATTERNS = [
  'delivery status notification',
  'mail delivery subsystem',
  'delivery incomplete',
  'undeliverable',
  'returned mail',
  'mail delivery failed',
  'failure notice',
];

/** True when the daemon-style sender indicates an automated delivery report. */
function looksLikeDaemon(fromEmail: string): boolean {
  const from = normalizeEmail(fromEmail);
  return (
    from.startsWith('mailer-daemon') ||
    from.startsWith('postmaster') ||
    from.includes('maildelivery') ||
    from.includes('mail-daemon')
  );
}

/**
 * Whether a message's envelope looks like a delivery notification at all. A DSN is
 * identified by a `multipart/report` / `message/delivery-status` content type, a
 * daemon sender, an `X-Failed-Recipients` header, or a delivery-notification subject.
 * This gate keeps the reconciliation from ever classifying an ordinary mailbox message.
 */
export function isDeliveryNotification(input: {
  fromEmail: string;
  subject: string;
  contentType?: string | null;
  hasXFailedRecipients?: boolean;
}): boolean {
  const contentType = (input.contentType ?? '').toLowerCase();
  if (contentType.includes('multipart/report') || contentType.includes('delivery-status')) return true;
  if (looksLikeDaemon(input.fromEmail)) return true;
  if (input.hasXFailedRecipients === true) return true;
  const subject = input.subject.toLowerCase();
  return DSN_SUBJECT_PATTERNS.some((p) => subject.includes(p));
}

/** Strip an RFC 3464 address prefix (`rfc822;`, `smtp;`, angle brackets) and lowercase. */
export function normalizeDsnAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  const semi = value.lastIndexOf(';');
  if (semi >= 0) value = value.slice(semi + 1).trim();
  const angle = /<([^>]+)>/.exec(value);
  if (angle?.[1]) value = angle[1];
  const normalized = normalizeEmail(value);
  return normalized || null;
}

/**
 * Parse a raw `message/delivery-status` body block into its RFC 3464 fields. The block
 * is a set of `Field: value` lines (per-recipient group). Returns only the fields we
 * record. Missing fields are null; malformed input yields all-null (fail-soft parse).
 */
export function parseDeliveryStatus(block: string | null | undefined): {
  action: string | null;
  status: string | null;
  diagnosticCode: string | null;
  finalRecipient: string | null;
  originalRecipient: string | null;
} {
  const out = {
    action: null as string | null,
    status: null as string | null,
    diagnosticCode: null as string | null,
    finalRecipient: null as string | null,
    originalRecipient: null as string | null,
  };
  if (!block) return out;
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = (m[1] ?? '').toLowerCase();
    const value = (m[2] ?? '').trim();
    if (!value) continue;
    switch (key) {
      case 'action':
        out.action ??= value.toLowerCase();
        break;
      case 'status':
        out.status ??= value;
        break;
      case 'diagnostic-code':
        out.diagnosticCode ??= value;
        break;
      case 'final-recipient':
        out.finalRecipient ??= normalizeDsnAddress(value);
        break;
      case 'original-recipient':
        out.originalRecipient ??= normalizeDsnAddress(value);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Extract the first SMTP status code (e.g. `550`) mentioned in a diagnostic string. */
export function extractSmtpCode(diagnostic: string | null | undefined): string | null {
  if (!diagnostic) return null;
  const m = /\b([245]\d\d)\b/.exec(diagnostic);
  return m?.[1] ?? null;
}

/**
 * Classify a failure as permanent or temporary. Precedence: the RFC 3463 enhanced
 * `Status` class (`5` = permanent, `4` = transient), then the SMTP reply code in the
 * diagnostic, then the `Action` field. Anything unrecognized is UNKNOWN (fail closed —
 * never assume a hard bounce we cannot prove, and never a soft one we cannot prove).
 */
export function classifyDeliveryPermanence(dsn: {
  status?: string | null;
  diagnosticCode?: string | null;
  action?: string | null;
}): DeliveryPermanence {
  const status = (dsn.status ?? '').trim();
  const statusClass = /^([245])\./.exec(status)?.[1];
  if (statusClass === '5') return 'PERMANENT';
  if (statusClass === '4') return 'TEMPORARY';
  if (statusClass === '2') return 'UNKNOWN'; // 2.x.x = success/notice, not a failure here

  const smtp = extractSmtpCode(dsn.diagnosticCode);
  if (smtp?.startsWith('5')) return 'PERMANENT';
  if (smtp?.startsWith('4')) return 'TEMPORARY';

  const action = (dsn.action ?? '').toLowerCase();
  if (action === 'delayed') return 'TEMPORARY';
  // `failed` with no status/code is not enough to prove permanence.
  return 'UNKNOWN';
}

/**
 * The rejection code recorded for the operator: the SMTP reply code and/or the enhanced
 * status, e.g. `550 5.7.1`. Returns null when neither is present.
 */
export function rejectionCode(dsn: { status?: string | null; diagnosticCode?: string | null }): string | null {
  const smtp = extractSmtpCode(dsn.diagnosticCode);
  const status = (dsn.status ?? '').trim() || null;
  const parts = [smtp, status].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The delivery status a permanence maps onto for the outreach record. */
export function permanenceToDeliveryStatus(p: DeliveryPermanence): DeliveryStatus {
  return p === 'PERMANENT' ? 'BOUNCED' : 'DELIVERY_UNKNOWN';
}

/**
 * Correlate a DSN to EXACTLY ONE tracked outbound. Fail-closed by construction:
 *
 *  1. Strong signals first — the DSN's own thread id equals an outbound thread id, OR a
 *     referenced RFC Message-ID equals an outbound's captured Message-ID. If the strong
 *     signals point at exactly one outbound message → matched. If they point at more
 *     than one distinct outbound message → AMBIGUOUS (never guessed).
 *  2. Only when there is no strong signal do we fall back to the failed-recipient
 *     address (Final-/Original-Recipient / X-Failed-Recipients) matching a tracked
 *     contact. Exactly one tracked outbound with that recipient → matched; more than
 *     one → AMBIGUOUS; none → NONE (unrelated DSN, ignored).
 *
 * A DSN that matches nothing tracked is NONE — it is never applied to an unrelated record.
 */
export function correlateDsn(dsn: ParsedDsn, outbounds: readonly TrackedOutbound[]): CorrelationResult {
  const referenced = new Set(dsn.referencedMessageIds.map((id) => id.trim()).filter(Boolean));
  const dsnThread = dsn.dsnGmailThreadId.trim();

  // Strong signals: an exact RFC Message-ID reference (preferred, most specific) or the
  // DSN sharing the outbound's Gmail thread. Each candidate carries the signal that hit.
  const strong: { outbound: TrackedOutbound; signal: CorrelationSignal }[] = [];
  for (const o of outbounds) {
    const rfcHit = !!o.rfcMessageId && referenced.has(o.rfcMessageId.trim());
    const threadHit = dsnThread.length > 0 && o.gmailThreadId.trim() === dsnThread;
    if (rfcHit) strong.push({ outbound: o, signal: 'RFC_MESSAGE_ID' });
    else if (threadHit) strong.push({ outbound: o, signal: 'THREAD_ID' });
  }
  const strongMatch = uniqueByMessage(strong);
  if (strongMatch.kind !== 'none') return strongMatch;

  // Weak fallback: the failed-recipient address must match a tracked contact exactly.
  const failed = new Set<string>();
  for (const addr of [dsn.finalRecipient, dsn.originalRecipient, normalizeDsnAddress(dsn.xFailedRecipients)]) {
    if (addr) failed.add(addr);
  }
  if (failed.size === 0) return { kind: 'none' };
  const recipientMatches = outbounds
    .filter((o) => failed.has(normalizeEmail(o.contactEmail)))
    .map((o) => ({ outbound: o, signal: 'RECIPIENT' as CorrelationSignal }));
  return uniqueByMessage(recipientMatches);
}

/**
 * Reduce a candidate set to a single match, or report ambiguity. Distinctness is by
 * outbound MESSAGE id: multiple DSN signals pointing at the same message is still one
 * match, but two different tracked messages is ambiguous and rejected.
 */
function uniqueByMessage(
  candidates: readonly { outbound: TrackedOutbound; signal: CorrelationSignal }[],
): CorrelationResult {
  if (candidates.length === 0) return { kind: 'none' };
  const byMessage = new Map<string, { outbound: TrackedOutbound; signal: CorrelationSignal }>();
  for (const c of candidates) if (!byMessage.has(c.outbound.outreachMessageId)) byMessage.set(c.outbound.outreachMessageId, c);
  if (byMessage.size > 1) {
    return { kind: 'ambiguous', matchedRecordIds: [...new Set(candidates.map((c) => c.outbound.outreachRecordId))] };
  }
  const only = [...byMessage.values()][0];
  if (!only) return { kind: 'none' };
  return { kind: 'matched', outbound: only.outbound, signal: only.signal };
}
