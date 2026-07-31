import { type NewOutreachEvent, type OutreachEvent } from '../../src/domain/outreach/events.js';
import {
  type DeliveryEventRef,
  type OutreachTxRepos,
  type OutreachUnitOfWork,
} from '../../src/domain/outreach/outreach-service.js';
import {
  type OutreachDeliveryEvent,
  type OutreachFollowup,
  type OutreachMessage,
  type OutreachRecord,
  type OutreachReply,
} from '../../src/domain/outreach/records.js';

/**
 * In-memory outreach store for fast, DB-free service tests. Implements the unit of
 * work with snapshot/restore so a thrown callback behaves like a rolled-back
 * transaction — the same guarantee the Drizzle unit of work gives.
 */
export class InMemoryOutreachStore implements OutreachUnitOfWork, OutreachTxRepos {
  records = new Map<string, OutreachRecord>();
  messages: OutreachMessage[] = [];
  followups = new Map<string, OutreachFollowup>();
  replies: OutreachReply[] = [];
  events: OutreachEvent[] = [];
  deliveryEvents: OutreachDeliveryEvent[] = [];
  private eventCounter = 0;

  async getRecord(id: string): Promise<OutreachRecord | null> {
    return this.records.get(id) ?? null;
  }

  async findActiveRecord(
    campaignId: string,
    leadId: string,
    contactEmail: string,
  ): Promise<OutreachRecord | null> {
    for (const r of this.records.values()) {
      if (
        r.campaignId === campaignId &&
        r.leadId === leadId &&
        r.contactEmail === contactEmail &&
        !['UNSUBSCRIBED', 'DO_NOT_CONTACT', 'CLOSED_WON', 'CLOSED_LOST'].includes(r.status)
      ) {
        return r;
      }
    }
    return null;
  }

  async hasDoNotContact(contactEmail: string): Promise<boolean> {
    for (const r of this.records.values()) {
      if (
        r.contactEmail === contactEmail &&
        (r.doNotContact || r.status === 'DO_NOT_CONTACT' || r.status === 'UNSUBSCRIBED')
      ) {
        return true;
      }
    }
    return false;
  }

  async insertRecord(rec: OutreachRecord): Promise<void> {
    this.records.set(rec.id, { ...rec });
  }

  async updateRecord(id: string, patch: Partial<OutreachRecord>, now: Date): Promise<void> {
    const cur = this.records.get(id);
    if (cur) this.records.set(id, { ...cur, ...patch, updatedAt: now });
  }

  async insertMessage(msg: OutreachMessage): Promise<void> {
    this.messages.push({ ...msg });
  }

  async insertReply(reply: {
    id: string;
    outreachRecordId: string;
    gmailThreadId: string;
    gmailMessageId: string;
    fromEmail: string;
    receivedAt: Date;
    classification: string;
    preview: string;
  }): Promise<void> {
    this.replies.push({ ...reply, createdAt: new Date() });
  }

  async insertFollowup(f: OutreachFollowup): Promise<void> {
    this.followups.set(f.id, { ...f });
  }

  async updateFollowupStatus(
    id: string,
    status: OutreachFollowup['status'],
    reason: string | null,
    now: Date,
  ): Promise<void> {
    const cur = this.followups.get(id);
    if (cur) this.followups.set(id, { ...cur, status, cancelledReason: reason, updatedAt: now });
  }

  async pendingFollowups(recordId: string): Promise<OutreachFollowup[]> {
    return [...this.followups.values()].filter(
      (f) => f.outreachRecordId === recordId && (f.status === 'DUE' || f.status === 'POSTPONED'),
    );
  }

  async appendEvent(evt: NewOutreachEvent): Promise<number> {
    const seq =
      this.events.filter((e) => e.outreachRecordId === evt.outreachRecordId).length + 1;
    this.eventCounter += 1;
    this.events.push({
      ...evt,
      id: `evt-${String(this.eventCounter)}`,
      seq,
      createdAt: new Date(),
    });
    return seq;
  }

  async deliveryEventExists(dsnGmailMessageId: string): Promise<boolean> {
    return this.deliveryEvents.some((e) => e.dsnGmailMessageId === dsnGmailMessageId);
  }

  async insertDeliveryEvent(evt: OutreachDeliveryEvent): Promise<void> {
    this.deliveryEvents.push({ ...evt });
  }

  async deliveryEventsByDsnIds(dsnGmailMessageIds: string[]): Promise<DeliveryEventRef[]> {
    const set = new Set(dsnGmailMessageIds);
    return this.deliveryEvents
      .filter((e) => set.has(e.dsnGmailMessageId))
      .map((e) => ({
        id: e.id,
        dsnGmailMessageId: e.dsnGmailMessageId,
        outreachRecordId: e.outreachRecordId,
        deliveryStatus: e.deliveryStatus,
        supersededAt: e.supersededAt,
      }));
  }

  async supersedeDeliveryEvent(id: string, supersededAt: Date, reason: string, by: string): Promise<void> {
    const e = this.deliveryEvents.find((x) => x.id === id);
    if (e && e.supersededAt === null) {
      e.supersededAt = supersededAt;
      e.supersededReason = reason;
      e.supersededBy = by;
    }
  }

  async transaction<T>(fn: (repos: OutreachTxRepos) => Promise<T>): Promise<T> {
    const snapshot = {
      records: new Map([...this.records].map(([k, v]) => [k, { ...v }])),
      messages: [...this.messages],
      followups: new Map([...this.followups].map(([k, v]) => [k, { ...v }])),
      replies: [...this.replies],
      events: [...this.events],
      deliveryEvents: [...this.deliveryEvents],
      counter: this.eventCounter,
    };
    try {
      return await fn(this);
    } catch (err) {
      this.records = snapshot.records;
      this.messages = snapshot.messages;
      this.followups = snapshot.followups;
      this.replies = snapshot.replies;
      this.events = snapshot.events;
      this.deliveryEvents = snapshot.deliveryEvents;
      this.eventCounter = snapshot.counter;
      throw err;
    }
  }

  // --- test helpers ---
  eventsFor(recordId: string): OutreachEvent[] {
    return this.events
      .filter((e) => e.outreachRecordId === recordId)
      .sort((a, b) => a.seq - b.seq);
  }
  pendingFor(recordId: string): OutreachFollowup[] {
    return [...this.followups.values()].filter(
      (f) => f.outreachRecordId === recordId && f.status === 'DUE',
    );
  }
}
