import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { decideFollowupPreparation } from '../../src/domain/outreach/followup-preparation-runner.js';
import { decideFollowupPromotion } from '../../src/domain/outreach/followup-due-promotion.js';
import { type SequencePolicy } from '../../src/domain/outreach/followups.js';
import { OutreachService } from '../../src/domain/outreach/outreach-service.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleOutreachUnitOfWork } from '../../src/persistence/outreach-unit-of-work.js';
import { FollowupPreparationRepository } from '../../src/persistence/repositories/followup-preparation.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { OutreachReadRepository } from '../../src/persistence/repositories/outreach.repo.js';
import { outreachEvents, outreachFollowups, outreachRecords } from '../../src/persistence/schema.js';

/**
 * Due-state promotion against REAL PostgreSQL. The in-memory unit tests pin the decision rules;
 * what can only be proven here is the durable behaviour the unattended timer depends on:
 *
 *  - the promotion worklist really selects an active, actually-due row and nothing else;
 *  - the compare-and-set really serializes two concurrent runs into ONE promotion and ONE event;
 *  - preparation really picks the promoted record up afterwards, which is the whole point of the
 *    phase — the handoff that was previously broken and required a manual transition.
 */

const testDatabase = requireIntegrationTestDatabase();
const TZ = 'Europe/London';
/** The initial send happened three days ago, so follow-up 1 (+2 days) is now overdue. */
const SENT_AT = Date.parse('2026-09-11T13:01:00Z');
const NOW = Date.parse('2026-09-14T10:00:00Z');
const policy: SequencePolicy = { step1DelayDays: 2, step2DelayDays: 2, step3DelayDays: 3, dueHourLocal: 9 };

describe('follow-up due-state promotion (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  const svc = (): OutreachService =>
    new OutreachService(new DrizzleOutreachUnitOfWork(handle.db), { now: () => NOW });
  const prepRepo = (): FollowupPreparationRepository => new FollowupPreparationRepository(handle.db);

  /** A tracked record whose initial email is confirmed sent and whose follow-up 1 is now due. */
  async function seedDueFollowup(): Promise<{ recordId: string; followupId: string; leadId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    // The sequence re-entry point preparation requires.
    await leads.updateStatus(lead.id, 'SENT', new Date(SENT_AT));

    const read = new OutreachReadRepository(handle.db);
    const campaign = await read.insertCampaign({ name: `camp-${randomUUID()}`, sequencePolicy: policy, timezone: TZ });
    const created = await svc().track({
      campaignId: campaign.id, leadId: lead.id, contactEmail: `r-${randomUUID()}@clinic.example`, timezone: TZ,
    });
    const recordId = created.record!.id;

    const enrolled = await svc().enrollConfirmedSend({
      outreachRecordId: recordId,
      subject: 'Something I noticed on your site',
      body: 'Initial body',
      gmailMessageId: `g-${randomUUID()}`,
      gmailThreadId: `thr-${randomUUID()}`,
      sentAt: new Date(SENT_AT),
      sendAttemptId: `att-${randomUUID()}`,
      policy,
    });
    expect(enrolled.record.status).toBe('INITIAL_SENT');
    return { recordId, followupId: enrolled.followup!.id, leadId: lead.id };
  }

  it('selects the due row, promotes it, and hands a composable candidate to preparation', async () => {
    const { recordId, followupId } = await seedDueFollowup();

    // 1. The worklist sees the due row while the record is still INITIAL_SENT.
    const [candidate] = await prepRepo().promotionCandidates(NOW, 5);
    expect(candidate).toMatchObject({
      followupId, outreachRecordId: recordId, step: 1, followupStatus: 'DUE', recordStatus: 'INITIAL_SENT',
    });
    expect(decideFollowupPromotion(candidate!, NOW).action).toBe('PROMOTE');

    // 2. Before promotion, preparation is blocked — the exact deadlock this phase removes.
    const [beforePrep] = await prepRepo().dueCandidates(NOW, 5);
    const blocked = decideFollowupPreparation(beforePrep!);
    expect(blocked.action).toBe('BLOCKED');
    expect(blocked.action === 'BLOCKED' && blocked.reason).toBe('NOT_AWAITING_FOLLOWUP');

    // 3. Promote.
    const r = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    expect(r.outcome).toBe('PROMOTED');

    const [rec] = await handle.db.select().from(outreachRecords).where(eq(outreachRecords.id, recordId));
    expect(rec?.status).toBe('FOLLOW_UP_1_DUE');
    // The row itself is untouched: still DUE, same due instant.
    const [row] = await handle.db.select().from(outreachFollowups).where(eq(outreachFollowups.id, followupId));
    expect(row?.status).toBe('DUE');
    expect(row?.dueAt.getTime()).toBe(rec?.nextFollowupAt?.getTime());

    // 4. Preparation now composes it. This is the handoff that previously needed an operator.
    const [afterPrep] = await prepRepo().dueCandidates(NOW, 5);
    expect(decideFollowupPreparation(afterPrep!)).toEqual({ action: 'COMPOSE', step: 1 });
  });

  it('appends exactly one automated STATE_TRANSITION and nothing else', async () => {
    const { recordId, followupId } = await seedDueFollowup();
    const before = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));

    await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });

    const after = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((e) => !before.some((b) => b.id === e.id));
    expect(added?.type).toBe('STATE_TRANSITION');
    expect(added?.fromStatus).toBe('INITIAL_SENT');
    expect(added?.toStatus).toBe('FOLLOW_UP_1_DUE');
    expect(added?.data).toMatchObject({ trigger: 'FOLLOWUP_DUE', automated: true, promotedBy: 'followup-automation' });
    // Every pre-existing event survives untouched (insert-only timeline).
    for (const b of before) expect(after.some((e) => e.id === b.id && e.type === b.type && e.seq === b.seq)).toBe(true);
  });

  it('serializes two concurrent runs into exactly one promotion and one event', async () => {
    const { recordId, followupId } = await seedDueFollowup();

    // Separate transactions on separate pool connections — the real race a repeating timer and a
    // manual run can produce. The compare-and-set is what makes exactly one of them win.
    const results = await Promise.all([
      svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'run-a' }),
      svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'run-b' }),
    ]);

    expect(results.filter((r) => r.outcome === 'PROMOTED')).toHaveLength(1);
    const loser = results.find((r) => r.outcome !== 'PROMOTED');
    expect(['ALREADY_DUE', 'RACE_LOST']).toContain(loser?.outcome);

    const events = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));
    expect(events.filter((e) => e.toStatus === 'FOLLOW_UP_1_DUE')).toHaveLength(1);
  });

  it('is idempotent across repeated runs', async () => {
    const { recordId, followupId } = await seedDueFollowup();
    const first = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    const second = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    const third = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });

    expect([first.outcome, second.outcome, third.outcome]).toEqual(['PROMOTED', 'ALREADY_DUE', 'ALREADY_DUE']);
    const events = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));
    expect(events.filter((e) => e.toStatus === 'FOLLOW_UP_1_DUE')).toHaveLength(1);
  });

  it('excludes a row that is not due yet, and one that was cancelled', async () => {
    const notDue = await seedDueFollowup();
    // A moment before the due instant: the worklist must be empty.
    const [row] = await handle.db.select().from(outreachFollowups).where(eq(outreachFollowups.id, notDue.followupId));
    expect(await prepRepo().promotionCandidates(row!.dueAt.getTime() - 1, 5)).toEqual([]);

    // A cancelled row (what reply sync and bounce reconciliation leave behind) never promotes.
    await svc().cancelFollowup(notDue.followupId, notDue.recordId, 'REPLY_DETECTED');
    expect(await prepRepo().promotionCandidates(NOW, 5)).toEqual([]);
    const forced = await svc().promoteFollowupDue({
      followupId: notDue.followupId, outreachRecordId: notDue.recordId, actor: 'followup-automation',
    });
    expect(forced.outcome).toBe('SKIPPED');
    const [rec] = await handle.db.select().from(outreachRecords).where(eq(outreachRecords.id, notDue.recordId));
    expect(rec?.status).toBe('INITIAL_SENT');
  });

  it('refuses to promote a record that replied, and leaves it exactly as it was', async () => {
    const { recordId, followupId } = await seedDueFollowup();
    await svc().applyReply({
      outreachRecordId: recordId,
      gmailThreadId: `thr-${randomUUID()}`,
      gmailMessageId: `g-${randomUUID()}`,
      fromEmail: 'reception@clinic.example',
      receivedAtMs: NOW,
      classification: 'positive',
      preview: 'Sounds interesting',
    });

    const r = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    // Reply sync cancels pending rows as it applies the reply, so the FIRST fail-closed layer —
    // "only an active DUE row may promote" — catches this before the status check is ever reached.
    expect(r.outcome).toBe('SKIPPED');
    expect(r.detail).toContain('FOLLOWUP_NOT_ACTIVE');
    const [rec] = await handle.db.select().from(outreachRecords).where(eq(outreachRecords.id, recordId));
    expect(rec?.status).toBe('REPLIED_POSITIVE');
    const events = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));
    expect(events.filter((e) => e.toStatus === 'FOLLOW_UP_1_DUE')).toEqual([]);
  });

  it('blocks on record-level suppression even when the row is still active and due', async () => {
    // The SECOND fail-closed layer, and the one that matters under a race: suppression reached the
    // record (here: do-not-contact) but no cancellation has touched the row yet.
    const { recordId, followupId } = await seedDueFollowup();
    await handle.db.update(outreachRecords).set({ doNotContact: true }).where(eq(outreachRecords.id, recordId));

    const r = await svc().promoteFollowupDue({ followupId, outreachRecordId: recordId, actor: 'followup-automation' });
    expect(r.outcome).toBe('BLOCKED');
    expect(r.detail).toContain('DO_NOT_CONTACT');
    const [rec] = await handle.db.select().from(outreachRecords).where(eq(outreachRecords.id, recordId));
    expect(rec?.status).toBe('INITIAL_SENT');
    const events = await handle.db.select().from(outreachEvents).where(eq(outreachEvents.outreachRecordId, recordId));
    expect(events.filter((e) => e.toStatus === 'FOLLOW_UP_1_DUE')).toEqual([]);
  });

  it('scopes a controlled run to exactly one record', async () => {
    const first = await seedDueFollowup();
    const second = await seedDueFollowup();

    const scoped = await prepRepo().promotionCandidates(NOW, 5, { recordId: first.recordId });
    expect(scoped.map((c) => c.outreachRecordId)).toEqual([first.recordId]);
    expect((await prepRepo().promotionCandidates(NOW, 5)).map((c) => c.outreachRecordId).sort())
      .toEqual([first.recordId, second.recordId].sort());
  });
});
