import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { buildCandidateLead, buildLeadFromFacts } from '../../src/domain/leads/lead-factory.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { BacklogStatusRepository } from '../../src/persistence/repositories/backlog-status.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import {
  emailDraftFinalizations, emailDrafts, gmailDrafts, outreachCampaigns, outreachFollowups,
  outreachRecords, sendSchedules,
} from '../../src/persistence/schema.js';

/**
 * Real-PostgreSQL coverage for BacklogStatusRepository. The domain-level arithmetic (bucketing,
 * capacity, dedup, day-placement) is already pinned by tests/unit/backlog-status.test.ts against
 * plain data; what can only be proven here is that the actual Drizzle queries — the group-bys and
 * the four-table join chain (send_schedules -> gmail_drafts -> email_draft_finalizations ->
 * email_drafts) that resolves an active schedule's driving sequence step/outreach record — run
 * correctly against a real schema. SELECT-only throughout; nothing here writes through the CLI
 * command, sends, drafts, or touches Gmail/network.
 */

const testDatabase = requireIntegrationTestDatabase();

describe('BacklogStatusRepository (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  const repo = (): BacklogStatusRepository => new BacklogStatusRepository(handle.db);

  async function seedLead(overrides: Partial<Parameters<typeof buildCandidateLead>[0]> = {}): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock', ...overrides });
    await leads.create(lead);
    return lead.id;
  }

  async function insertCampaign(): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(outreachCampaigns).values({
      id, name: `camp-${randomUUID()}`, sequencePolicy: {}, timezone: 'Europe/London',
    });
    return id;
  }

  async function insertOutreachRecord(input: {
    campaignId: string; leadId: string; status: string; doNotContact?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(outreachRecords).values({
      id,
      campaignId: input.campaignId,
      leadId: input.leadId,
      contactEmail: `c-${randomUUID()}@example.com`,
      status: input.status,
      timezone: 'Europe/London',
      doNotContact: input.doNotContact ?? false,
    });
    return id;
  }

  async function insertEmailDraft(input: {
    leadId: string; sequenceStep: number; outreachRecordId: string | null; createdAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(emailDrafts).values({
      id,
      leadId: input.leadId,
      subject: 'Something I noticed on your site',
      body: 'body',
      ctaKind: 'reply',
      status: 'APPROVED',
      writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v',
      provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', totalCostUsd: 0,
      sequenceStep: input.sequenceStep,
      outreachRecordId: input.outreachRecordId,
      createdAt: input.createdAt,
    });
    return id;
  }

  /** Builds the full send_schedules -> gmail_drafts -> email_draft_finalizations -> email_drafts chain. */
  async function seedActiveSchedule(input: {
    leadId: string; sequenceStep: number; outreachRecordId: string | null;
    scheduledAtUtc: Date; scheduleStatus?: string;
  }): Promise<string> {
    const draftId = await insertEmailDraft({
      leadId: input.leadId, sequenceStep: input.sequenceStep, outreachRecordId: input.outreachRecordId,
      createdAt: new Date(),
    });
    const finalizationId = randomUUID();
    await handle.db.insert(emailDraftFinalizations).values({
      id: finalizationId, originalDraftId: draftId, deploymentRunId: null, verifiedDeploymentUrl: null,
      originalBodyHash: 'oh', resolvedBody: 'body', resolvedBodyHash: 'rh', kind: 'REPLY_DIRECT',
    });
    const gmailDraftId = randomUUID();
    await handle.db.insert(gmailDrafts).values({
      id: gmailDraftId, leadId: input.leadId, finalizedEmailId: finalizationId,
      recipientEmail: 'r@example.com', senderEmail: 's@example.com', gmailAccount: 's@example.com',
      provider: 'mock-gmail', providerDraftId: `pd-${randomUUID()}`, outcome: 'DRAFT_CREATED',
      idempotencyFingerprint: `fp-${randomUUID()}`, sourceEmailVersion: 'rh',
    });
    const scheduleId = randomUUID();
    await handle.db.insert(sendSchedules).values({
      id: scheduleId, leadId: input.leadId, gmailDraftId, providerDraftId: `pd-${randomUUID()}`,
      finalizedContentHash: 'rh', recipientEmail: 'r@example.com', scheduledAtUtc: input.scheduledAtUtc,
      timezone: 'Europe/London', rulesVersion: 'v', computedFrom: {}, integrityFingerprint: 'fp',
      origin: 'auto', status: input.scheduleStatus ?? 'SCHEDULED',
    });
    return scheduleId;
  }

  it('countLeadsByStatus groups real rows by status', async () => {
    await seedLead();
    await seedLead();
    const thirdId = await seedLead();
    await new LeadsRepository(handle.db).updateStatus(thirdId, 'QUALIFIED', new Date());

    const counts = await repo().countLeadsByStatus();
    expect(counts.get('NEW')).toBe(2);
    expect(counts.get('QUALIFIED')).toBe(1);
  });

  it('leadIdsWithStatus returns only ids in the requested statuses, and [] for an empty status list', async () => {
    const a = await seedLead();
    const b = await seedLead();
    await new LeadsRepository(handle.db).updateStatus(b, 'QUALIFIED', new Date());

    expect(await repo().leadIdsWithStatus(['NEW'])).toEqual([a]);
    expect(await repo().leadIdsWithStatus([])).toEqual([]);
  });

  it('latestDraftStepByLead picks the newest draft (by createdAt) per lead, not the first inserted', async () => {
    const leadId = await seedLead();
    await insertEmailDraft({ leadId, sequenceStep: 0, outreachRecordId: null, createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertEmailDraft({ leadId, sequenceStep: 1, outreachRecordId: null, createdAt: new Date('2026-01-03T00:00:00Z') });
    await insertEmailDraft({ leadId, sequenceStep: 2, outreachRecordId: null, createdAt: new Date('2026-01-02T00:00:00Z') });

    const byLead = await repo().latestDraftStepByLead([leadId]);
    expect(byLead.get(leadId)).toBe(1);
  });

  it('leadIdentities returns the identity columns isSuppressed() needs', async () => {
    const lead = buildLeadFromFacts(
      {
        businessName: 'Acme Dental', domain: 'acme-dental.example', phone: '+44 20 7946 0000',
        city: 'London', country: 'GB', formattedAddress: '1 Example St', latitude: 51.5, longitude: -0.1,
      },
      { placeId: 'place-1', source: 'mock' },
    );
    await new LeadsRepository(handle.db).create(lead);

    const identities = await repo().leadIdentities([lead.id]);
    const identity = identities.get(lead.id);
    expect(identity?.normalizedDomain).toBe(lead.normalizedDomain);
    expect(identity?.normalizedName).toBe(lead.normalizedName);
    expect(identity?.normalizedPhone).toBe(lead.normalizedPhone);
    expect(identity?.placeId).toBe('place-1');
  });

  it('outreachRecordsForLeads returns status + do_not_contact for every row on the given leads', async () => {
    const leadId = await seedLead();
    const campaignId = await insertCampaign();
    await insertOutreachRecord({ campaignId, leadId, status: 'INITIAL_SENT' });
    await insertOutreachRecord({ campaignId, leadId, status: 'BOUNCED', doNotContact: false });

    const rows = await repo().outreachRecordsForLeads([leadId]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['BOUNCED', 'INITIAL_SENT']);
    expect(await repo().outreachRecordsForLeads([])).toEqual([]);
  });

  it('outreachRecordStateCounts groups by (status, do_not_contact) across the whole table', async () => {
    const leadA = await seedLead();
    const leadB = await seedLead();
    const campaignId = await insertCampaign();
    await insertOutreachRecord({ campaignId, leadId: leadA, status: 'INITIAL_SENT' });
    await insertOutreachRecord({ campaignId, leadId: leadB, status: 'INITIAL_SENT' });
    await insertOutreachRecord({ campaignId, leadId: leadB, status: 'FOLLOW_UP_1_SENT', doNotContact: true });

    const counts = await repo().outreachRecordStateCounts();
    const initialSent = counts.find((c) => c.status === 'INITIAL_SENT' && !c.doNotContact);
    const dncFollowup1 = counts.find((c) => c.status === 'FOLLOW_UP_1_SENT' && c.doNotContact);
    expect(initialSent?.count).toBe(2);
    expect(dncFollowup1?.count).toBe(1);
  });

  it('dueFollowups returns only status=DUE rows, excluding CANCELLED/POSTPONED/SENT', async () => {
    const leadId = await seedLead();
    const campaignId = await insertCampaign();
    const recordId = await insertOutreachRecord({ campaignId, leadId, status: 'FOLLOW_UP_1_DUE' });
    const dueAt = new Date('2026-02-01T09:00:00Z');
    await handle.db.insert(outreachFollowups).values([
      { id: randomUUID(), outreachRecordId: recordId, step: 1, dueAt, timezone: 'Europe/London', status: 'DUE' },
      { id: randomUUID(), outreachRecordId: recordId, step: 2, dueAt, timezone: 'Europe/London', status: 'CANCELLED', cancelledReason: 'test' },
      { id: randomUUID(), outreachRecordId: recordId, step: 3, dueAt, timezone: 'Europe/London', status: 'SENT' },
    ]);

    const due = await repo().dueFollowups();
    expect(due).toHaveLength(1);
    expect(due[0]?.step).toBe(1);
    expect(due[0]?.outreachRecordId).toBe(recordId);
    expect(due[0]?.dueAt.toISOString()).toBe(dueAt.toISOString());
  });

  it('activeScheduledSends resolves sequenceStep + outreachRecordId through the finalization/gmail-draft chain, and excludes non-SCHEDULED rows', async () => {
    const leadId = await seedLead();
    const campaignId = await insertCampaign();
    const recordId = await insertOutreachRecord({ campaignId, leadId, status: 'FOLLOW_UP_1_DUE' });
    const scheduledAt = new Date('2026-03-01T09:00:00Z');
    await seedActiveSchedule({ leadId, sequenceStep: 1, outreachRecordId: recordId, scheduledAtUtc: scheduledAt });

    const otherLeadId = await seedLead();
    await seedActiveSchedule({
      leadId: otherLeadId, sequenceStep: 0, outreachRecordId: null,
      scheduledAtUtc: new Date('2026-03-02T09:00:00Z'), scheduleStatus: 'CANCELLED',
    });

    const active = await repo().activeScheduledSends();
    expect(active).toHaveLength(1);
    expect(active[0]?.leadId).toBe(leadId);
    expect(active[0]?.sequenceStep).toBe(1);
    expect(active[0]?.outreachRecordId).toBe(recordId);
    expect(active[0]?.scheduledAtUtc.toISOString()).toBe(scheduledAt.toISOString());
  });
});
