import {
  type ApplyTabOptions,
  type SheetRow,
  type SheetSyncCounts,
  type SheetsProvider,
  type SheetTabSnapshot,
} from '../../integrations/google/sheets/provider.js';
import { overdueDays } from './followups.js';

/**
 * Phase 17A Google Sheet projection. Deterministically builds the four operator tabs
 * from a Postgres projection and applies them idempotently. Every row carries a
 * STABLE id so re-running the sync updates rows in place (never duplicates), and the
 * second identical run reports everything unchanged.
 *
 * Bodies are never dumped into the Sheet — the Messages tab references the exact
 * version by its content hash (the full body stays authoritative in Postgres). No
 * secret or internal metadata is projected.
 */

export const OUTREACH_TABS = {
  outreach: 'Outreach',
  messages: 'Messages',
  followupsDue: 'Follow-ups Due',
  replies: 'Replies and Outcomes',
} as const;

export interface OutreachRowView {
  recordId: string;
  business: string | null;
  domain: string | null;
  contactEmail: string;
  campaign: string;
  qualificationScore: number | null;
  demoUrl: string | null;
  status: string;
  sequenceStep: number;
  lastSentAt: Date | null;
  nextFollowupAt: Date | null;
  lastReplyAt: Date | null;
  replyCategory: string | null;
  doNotContact: boolean;
  owner: string | null;
  outcome: string | null;
  notes: string | null;
}

export interface MessageRowView {
  messageId: string;
  business: string | null;
  contactEmail: string;
  campaign: string;
  messageType: string;
  sequenceStep: number;
  subject: string;
  contentHash: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
}

export interface FollowupRowView {
  followupId: string;
  business: string | null;
  contactEmail: string;
  step: number;
  dueAt: Date;
  replyDetected: boolean;
  blockedReason: string | null;
  humanApprovalStatus: string;
}

export interface ReplyRowView {
  replyId: string;
  business: string | null;
  gmailThreadId: string;
  receivedAt: Date;
  classification: string;
  summary: string;
  meetingStatus: string;
  outcome: string | null;
  notes: string | null;
}

export interface OutreachProjection {
  outreach: OutreachRowView[];
  messages: MessageRowView[];
  followupsDue: FollowupRowView[];
  replies: ReplyRowView[];
}

function iso(d: Date | null): string {
  return d ? d.toISOString() : '';
}
function s(v: string | null | undefined): string {
  return v ?? '';
}
function n(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export function buildOutreachTab(rows: OutreachRowView[]): SheetTabSnapshot {
  const header = [
    'business', 'domain', 'contact email', 'campaign', 'qualification score', 'demo URL',
    'current status', 'sequence step', 'last sent date', 'next follow-up date', 'last reply date',
    'reply category', 'do-not-contact', 'owner', 'outcome', 'notes',
  ];
  const out: SheetRow[] = rows.map((r) => ({
    rowId: `outreach:${r.recordId}`,
    cells: [
      s(r.business), s(r.domain), r.contactEmail, r.campaign, n(r.qualificationScore), s(r.demoUrl),
      r.status, String(r.sequenceStep), iso(r.lastSentAt), iso(r.nextFollowupAt), iso(r.lastReplyAt),
      s(r.replyCategory), r.doNotContact ? 'YES' : 'no', s(r.owner), s(r.outcome), s(r.notes),
    ],
  }));
  return { tab: OUTREACH_TABS.outreach, header, rows: out };
}

export function buildMessagesTab(rows: MessageRowView[]): SheetTabSnapshot {
  const header = [
    'business', 'contact email', 'campaign', 'message type', 'sequence step', 'exact subject',
    'body version (sha256)', 'approved date', 'sent date', 'Gmail message ID', 'Gmail thread ID',
  ];
  const out: SheetRow[] = rows.map((r) => ({
    rowId: `message:${r.messageId}`,
    cells: [
      s(r.business), r.contactEmail, r.campaign, r.messageType, String(r.sequenceStep), r.subject,
      r.contentHash, iso(r.approvedAt), iso(r.sentAt), s(r.gmailMessageId), s(r.gmailThreadId),
    ],
  }));
  return { tab: OUTREACH_TABS.messages, header, rows: out };
}

export function buildFollowupsTab(rows: FollowupRowView[], nowMs: number): SheetTabSnapshot {
  const header = [
    'business', 'contact email', 'current step', 'due date', 'days overdue', 'reply detected',
    'blocked reason', 'human approval status',
  ];
  const out: SheetRow[] = rows.map((r) => ({
    rowId: `followup:${r.followupId}`,
    cells: [
      s(r.business), r.contactEmail, String(r.step), iso(r.dueAt),
      String(overdueDays(r.dueAt.getTime(), nowMs)), r.replyDetected ? 'YES' : 'no',
      s(r.blockedReason), r.humanApprovalStatus,
    ],
  }));
  return { tab: OUTREACH_TABS.followupsDue, header, rows: out };
}

export function buildRepliesTab(rows: ReplyRowView[]): SheetTabSnapshot {
  const header = [
    'business', 'thread ID', 'reply date', 'classification', 'summary', 'meeting status',
    'final outcome', 'notes',
  ];
  const out: SheetRow[] = rows.map((r) => ({
    rowId: `reply:${r.replyId}`,
    cells: [
      s(r.business), r.gmailThreadId, iso(r.receivedAt), r.classification, r.summary,
      r.meetingStatus, s(r.outcome), s(r.notes),
    ],
  }));
  return { tab: OUTREACH_TABS.replies, header, rows: out };
}

export function buildAllTabs(projection: OutreachProjection, nowMs: number): SheetTabSnapshot[] {
  return [
    buildOutreachTab(projection.outreach),
    buildMessagesTab(projection.messages),
    buildFollowupsTab(projection.followupsDue, nowMs),
    buildRepliesTab(projection.replies),
  ];
}

export interface SheetSyncReport {
  provider: string;
  wroteExternally: boolean;
  perTab: { tab: string; counts: SheetSyncCounts }[];
  totals: SheetSyncCounts;
}

/**
 * Apply every tab through the provider and aggregate the change counts. This is the
 * ONLY place a Sheet is written, and only the caller (holding the confirmation gate)
 * decides which provider — mock or a real one — is passed in.
 */
export async function syncSheet(
  provider: SheetsProvider,
  snapshots: SheetTabSnapshot[],
  options?: ApplyTabOptions,
): Promise<SheetSyncReport> {
  const perTab: { tab: string; counts: SheetSyncCounts }[] = [];
  const totals: SheetSyncCounts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
  for (const snap of snapshots) {
    const counts = await provider.applyTab(snap, options);
    perTab.push({ tab: snap.tab, counts });
    totals.inserted += counts.inserted;
    totals.updated += counts.updated;
    totals.unchanged += counts.unchanged;
    totals.deleted += counts.deleted;
  }
  return { provider: provider.name, wroteExternally: provider.writesExternally, perTab, totals };
}
