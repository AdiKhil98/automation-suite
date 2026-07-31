/**
 * Immutable outreach event log (Phase 17A). Every meaningful change — record
 * created, status transitioned, message recorded, follow-up scheduled/cancelled/
 * postponed, reply detected, sheet synced — appends exactly one event. Events are
 * insert-only and ordered by a monotonically increasing sequence per record, so a
 * record's complete timeline can always be replayed in order.
 *
 * Phase 17C adds three delivery-reconciliation event types: `BOUNCE_DETECTED` and
 * `FOLLOWUPS_CANCELLED` (a confirmed permanent bounce), and `DELIVERY_UNKNOWN` (a
 * temporary/non-terminal delivery failure that requires operator review). These are
 * appended, never overwriting the original `INITIAL_SENT` transition or sent timestamp.
 */

export const OUTREACH_EVENT_TYPES = [
  'RECORD_CREATED',
  'STATE_TRANSITION',
  'INVALID_TRANSITION',
  'MESSAGE_RECORDED',
  'FOLLOWUP_SCHEDULED',
  'FOLLOWUP_CANCELLED',
  'FOLLOWUP_POSTPONED',
  'REPLY_DETECTED',
  'DO_NOT_CONTACT_SET',
  'SHEET_SYNCED',
  'BOUNCE_DETECTED',
  'FOLLOWUPS_CANCELLED',
  'DELIVERY_UNKNOWN',
  'DELIVERY_RECONCILIATION_CORRECTED',
  'NOTE',
] as const;

export type OutreachEventType = (typeof OUTREACH_EVENT_TYPES)[number];

export interface NewOutreachEvent {
  outreachRecordId: string;
  type: OutreachEventType;
  fromStatus: string | null;
  toStatus: string | null;
  message: string;
  data: unknown;
}

export interface OutreachEvent extends NewOutreachEvent {
  id: string;
  /** 1-based position within the record's timeline; strictly increasing. */
  seq: number;
  createdAt: Date;
}
