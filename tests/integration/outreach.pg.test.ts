import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { buildAllTabs, syncSheet } from '../../src/domain/outreach/sheet-sync.js';
import { MockSheetsProvider } from '../../src/integrations/google/sheets/mock-sheets.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleOutreachUnitOfWork } from '../../src/persistence/outreach-unit-of-work.js';
import { OutreachReadRepository } from '../../src/persistence/repositories/outreach.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { outreachDeliveryEvents, outreachMessages, outreachRecords } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-07-20T12:00:00Z');
const policy: SequencePolicy = { step1DelayDays: 3, step2DelayDays: 5, dueHourLocal: 9 };

describe('outreach tracking (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  const svc = (): OutreachService => new OutreachService(new DrizzleOutreachUnitOfWork(handle.db), { now: () => NOW });

  async function seed(): Promise<{ leadId: string; campaignId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    const read = new OutreachReadRepository(handle.db);
    const campaign = await read.insertCampaign({ name: `camp-${randomUUID()}`, sequencePolicy: policy, timezone: TZ });
    return { leadId: lead.id, campaignId: campaign.id };
  }

  it('applies the migration and persists a tracked record + immutable message history', async () => {
    const { leadId, campaignId } = await seed();
    const created = await svc().track({ campaignId, leadId, contactEmail: 'a@clinic.example', timezone: TZ });
    const recId = created.record!.id;

    await svc().recordMessage({ outreachRecordId: recId, messageType: 'INITIAL', sequenceStep: 0, subject: 'Erste Nachricht', body: 'Body A', gmailThreadId: 'thr-1', sentAt: new Date(NOW) });
    await svc().recordMessage({ outreachRecordId: recId, messageType: 'FOLLOW_UP', sequenceStep: 1, subject: 'Nachfrage', body: 'Body B' });

    const rows = await handle.db.select().from(outreachMessages).where(eq(outreachMessages.outreachRecordId, recId));
    expect(rows).toHaveLength(2);
    // Exact subject/body preserved; nothing overwritten.
    expect(rows.map((r) => r.subject).sort()).toEqual(['Erste Nachricht', 'Nachfrage']);
  });

  it('enforces the duplicate-active unique index at the database level', async () => {
    const { leadId, campaignId } = await seed();
    await svc().track({ campaignId, leadId, contactEmail: 'dup@clinic.example', timezone: TZ });
    // A second ACTIVE row for the same (campaign, lead, contact) must be rejected by the DB.
    await expect(
      handle.db.insert(outreachRecords).values({
        id: randomUUID(), campaignId, leadId, contactEmail: 'dup@clinic.example',
        status: 'DRAFT_READY', sequenceStep: 0, timezone: TZ, doNotContact: false,
      }),
    ).rejects.toThrow();
  });

  it('a reply cancels pending follow-ups and records the reply (through the DB)', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'reply@clinic.example', timezone: TZ })).record!;
    await svc().recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-2', sentAt: new Date(NOW) });
    await svc().scheduleFollowup(rec.id, 1, policy);

    await svc().applyReply({
      outreachRecordId: rec.id, gmailThreadId: 'thr-2', gmailMessageId: 'in-1',
      fromEmail: 'reply@clinic.example', receivedAtMs: Date.parse('2026-07-21T09:00:00Z'),
      preview: 'unsubscribe me', classification: 'unsubscribe',
    });

    const read = new OutreachReadRepository(handle.db);
    const after = await read.getRecordById(rec.id);
    expect(after?.status).toBe('UNSUBSCRIBED');
    expect(after?.doNotContact).toBe(true);
    expect(after?.nextFollowupAt).toBeNull();
    // A follow-up scheduled before the reply is no longer pending.
    const projection = await read.projection();
    expect(projection.followupsDue.filter((f) => f.contactEmail === 'reply@clinic.example')).toHaveLength(0);
  });

  it('reconciles a permanent bounce: record -> BOUNCED, follow-ups cancelled, delivery event persisted, idempotent (through the DB)', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'bounce@clinic.example', timezone: TZ })).record!;
    await svc().recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailMessageId: 'gm-out-9', gmailThreadId: 'thr-9', sentAt: new Date(NOW) });
    await svc().transition(rec.id, 'AWAITING_APPROVAL');
    await svc().transition(rec.id, 'APPROVED_TO_SEND');
    await svc().transition(rec.id, 'INITIAL_SENT');
    await svc().scheduleFollowup(rec.id, 1, policy);

    const read = new OutreachReadRepository(handle.db);
    const msgId = (await read.messagesForRecord(rec.id))[0]!.id;

    const bounce = {
      outreachRecordId: rec.id, outreachMessageId: msgId,
      deliveryStatus: 'BOUNCED' as const, permanence: 'PERMANENT' as const,
      rejectionCode: '550 5.7.1', diagnosticText: 'smtp; 550 5.7.1 likely unsolicited mail',
      dsnStatus: '5.7.1', dsnAction: 'failed', finalRecipient: 'bounce@clinic.example', originalRecipient: null,
      bounceAtMs: Date.parse('2026-07-20T12:01:00Z'), originalGmailMessageId: 'gm-out-9', originalGmailThreadId: 'thr-9',
      dsnGmailMessageId: 'dsn-99', dsnGmailThreadId: 'thr-dsn-sep', preview: 'Address rejected',
    };
    const first = await svc().applyDeliveryFailure(bounce);
    expect(first.outcome).toBe('BOUNCED_APPLIED');

    const after = await read.getRecordById(rec.id);
    expect(after?.status).toBe('BOUNCED');
    expect(after?.doNotContact).toBe(false); // policy: bounce does not mark do-not-contact
    expect(after?.nextFollowupAt).toBeNull();

    const deliveryRows = await handle.db.select().from(outreachDeliveryEvents).where(eq(outreachDeliveryEvents.outreachRecordId, rec.id));
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]?.rejectionCode).toBe('550 5.7.1');

    // The immutable message row keeps its sent timestamp + gmail id (history not overwritten).
    const msgRow = (await read.messagesForRecord(rec.id))[0]!;
    expect(msgRow.sentAt).not.toBeNull();
    expect(msgRow.gmailMessageId).toBe('gm-out-9');

    // Idempotent: replaying the same DSN changes nothing and never duplicates the event.
    const second = await svc().applyDeliveryFailure(bounce);
    expect(second.outcome).toBe('ALREADY_RECONCILED');
    const stillOne = await handle.db.select().from(outreachDeliveryEvents).where(eq(outreachDeliveryEvents.dsnGmailMessageId, 'dsn-99'));
    expect(stillOne).toHaveLength(1);
  });

  it('does NOT reconcile an already-resolved (terminal) record: trackedOutbounds excludes it (17C1)', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'terminal@clinic.example', timezone: TZ })).record!;
    await svc().recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailMessageId: 'gm-t', gmailThreadId: 'thr-t', sentAt: new Date(NOW) });
    // Resolve it terminally (a genuine bounce reply), as the reply-sync path would.
    await svc().applyReply({ outreachRecordId: rec.id, gmailThreadId: 'thr-t', gmailMessageId: 'rb', fromEmail: 'mailer-daemon@googlemail.com', receivedAtMs: NOW, preview: 'Address not found', classification: 'bounce' });

    const read = new OutreachReadRepository(handle.db);
    expect((await read.getRecordById(rec.id))?.status).toBe('BOUNCED');
    // Eligibility excludes the BOUNCED record even when explicitly targeted by --record.
    expect(await read.trackedOutbounds({ recordId: rec.id })).toHaveLength(0);
    expect(await read.trackedOutbounds()).toHaveLength(0);
  });

  it('invalidates (supersedes) a mis-correlated delivery event without deleting it, and annotates the timeline (17C1)', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'correct@clinic.example', timezone: TZ })).record!;
    await svc().recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailMessageId: 'gm-c', gmailThreadId: 'thr-c', sentAt: new Date(NOW) });
    await svc().transition(rec.id, 'AWAITING_APPROVAL');
    await svc().transition(rec.id, 'APPROVED_TO_SEND');
    await svc().transition(rec.id, 'INITIAL_SENT');
    // A temporary DSN records a (say, later-found-incorrect) delivery event; state stays non-terminal.
    await svc().applyDeliveryFailure({
      outreachRecordId: rec.id, outreachMessageId: null, deliveryStatus: 'DELIVERY_UNKNOWN', permanence: 'TEMPORARY',
      rejectionCode: '452 4.2.2', diagnosticText: 'smtp; 452 4.2.2 mailbox full', dsnStatus: '4.2.2', dsnAction: 'delayed',
      finalRecipient: 'correct@clinic.example', originalRecipient: null, bounceAtMs: NOW,
      originalGmailMessageId: 'gm-c', originalGmailThreadId: 'thr-c', dsnGmailMessageId: 'dsn-wrong', dsnGmailThreadId: 'thr-x', preview: 'x',
    });

    const before = await handle.db.select().from(outreachDeliveryEvents).where(eq(outreachDeliveryEvents.dsnGmailMessageId, 'dsn-wrong'));
    expect(before).toHaveLength(1);

    const res = await svc().correctDeliveryEvents({ dsnGmailMessageIds: ['dsn-wrong'], reason: 'mis-correlated (predates outbound)', by: 'adi', dryRun: false });
    expect(res.applied).toBe(true);
    expect(res.toSupersedeCount).toBe(1);

    // Row still present (never deleted), now marked superseded with reason + operator.
    const after = await handle.db.select().from(outreachDeliveryEvents).where(eq(outreachDeliveryEvents.dsnGmailMessageId, 'dsn-wrong'));
    expect(after).toHaveLength(1);
    expect(after[0]?.supersededAt).not.toBeNull();
    expect(after[0]?.supersededBy).toBe('adi');

    const read = new OutreachReadRepository(handle.db);
    const corrected = (await read.timeline(rec.id)).filter((e) => e.type === 'DELIVERY_RECONCILIATION_CORRECTED');
    expect(corrected).toHaveLength(1);

    // Idempotent: a repeat supersedes nothing more.
    const second = await svc().correctDeliveryEvents({ dsnGmailMessageIds: ['dsn-wrong'], reason: 'r', by: 'adi', dryRun: false });
    expect(second.toSupersedeCount).toBe(0);
    expect(second.alreadySupersededCount).toBe(1);
  });

  it('records a strictly increasing, gap-checked event timeline', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'tl@clinic.example', timezone: TZ })).record!;
    await svc().transition(rec.id, 'AWAITING_APPROVAL');
    await svc().transition(rec.id, 'APPROVED_TO_SEND');
    const read = new OutreachReadRepository(handle.db);
    const timeline = await read.timeline(rec.id);
    const seqs = timeline.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('projects to a Google Sheet idempotently via the mock provider (no external write)', async () => {
    const { leadId, campaignId } = await seed();
    const rec = (await svc().track({ campaignId, leadId, contactEmail: 'sheet@clinic.example', timezone: TZ })).record!;
    await svc().recordMessage({ outreachRecordId: rec.id, messageType: 'INITIAL', sequenceStep: 0, subject: 's', body: 'b', gmailThreadId: 'thr-3', sentAt: new Date(NOW) });
    const read = new OutreachReadRepository(handle.db);
    const provider = new MockSheetsProvider();
    const first = await syncSheet(provider, buildAllTabs(await read.projection(), NOW));
    expect(first.wroteExternally).toBe(false);
    expect(first.totals.inserted).toBeGreaterThan(0);
    const second = await syncSheet(provider, buildAllTabs(await read.projection(), NOW));
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.updated).toBe(0);
  });
});
