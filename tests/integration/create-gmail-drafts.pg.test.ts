import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { GmailDraftService, type GmailConfig } from '../../src/domain/gmail/gmail-service.js';
import { MockGmailDraftProvider } from '../../src/integrations/gmail/mock-gmail.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DrizzleGmailUnitOfWork } from '../../src/persistence/gmail-unit-of-work.js';
import { GmailRepository } from '../../src/persistence/repositories/gmail.repo.js';
import { GmailInputRepository } from '../../src/persistence/repositories/gmail-input.repo.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { demoDecisions, demoDeploymentRuns, demos, emailDraftFinalizations, emailDrafts, gmailDrafts, leads as leadsTbl } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const ACCOUNT = 'sender@example.com';
const RECIP = 'office@example.org';
const BODY = 'Hallo,\n\nDas Konzept: https://demo.example.net/\n\nBeste Grüße\n{{SENDER_NAME}}';

describe('createGmailDrafts (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  async function seed(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `p-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await handle.db.transaction(async (tx) => {
      const fr = new LeadFactsRepository(tx);
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'business_name', value: 'Z', normalizedValue: 'z', sourceType: 'website', sourceUrl: null, confidence: 1 });
      await fr.writeCurrentFact({ leadId: lead.id, factType: 'contact_email', value: RECIP, normalizedValue: RECIP, sourceType: 'website', sourceUrl: null, confidence: 1 });
    });
    for (const s of ['OPPORTUNITY_READY', 'DEMO_DECIDED', 'DEMO_READY', 'EMAIL_DRAFTED', 'EMAIL_APPROVED', 'WAITING_FOR_DEMO_URL', 'FINALIZED_EMAIL_PENDING', 'HUMAN_APPROVED'])
      await leads.updateStatus(lead.id, s as never, new Date());
    const decId = randomUUID(), demoId = randomUUID(), emailId = randomUUID(), depId = randomUUID();
    await handle.db.insert(demoDecisions).values({ id: decId, leadId: lead.id, decision: 'BUILD_DEMO', outcome: 'DEMO_COMPOSED', reason: 'seed', opportunityScore: 60, minOpportunity: 0, justifiedByScore: true, justifiedByFinding: true, briefRulesVersion: 'x' });
    await handle.db.insert(demos).values({ id: demoId, leadId: lead.id, demoDecisionId: decId, templateId: 'composer-v1', templateVersion: 't', path: '/demos/seed', status: 'APPROVED', noindexVerified: true, disclosurePresent: true, contentHash: 'h', ctaKind: 'scroll', factsUsed: [], findingRefs: [] });
    await handle.db.insert(emailDrafts).values({ id: emailId, leadId: lead.id, runId: null, subject: 'Website suggestion', body: BODY, ctaKind: 'demo_link', hasDemoUrlPlaceholder: true, status: 'APPROVED', writerPromptVersion: 'w', reviewerPromptVersion: 'r', schemaVersion: 's', rulesVersion: 'v', provider: 'mock', requestedWriterModel: 'm', requestedReviewerModel: 'm', reviewerDecision: 'APPROVE', humanDecision: 'APPROVED', totalCostUsd: 0 });
    await handle.db.insert(demoDeploymentRuns).values({ id: depId, leadId: lead.id, demoId, originalEmailDraftId: emailId, provider: 'http-netlify', siteId: 's', deployId: 'd1', artifactHash: 'h', attemptFingerprint: 'fp', outcome: 'DEPLOYED_AND_VERIFIED', draftUrl: 'https://x', verifiedUrl: 'https://x', callsMade: 0, startedAt: new Date(), completedAt: new Date() });
    await handle.db.insert(emailDraftFinalizations).values({ id: randomUUID(), originalDraftId: emailId, deploymentRunId: depId, verifiedDeploymentUrl: 'https://demo.example.net/', originalBodyHash: 'oh', resolvedBody: BODY, resolvedBodyHash: 'rh', finalHumanDecision: 'APPROVED', finalReviewedBy: 'local-reviewer' });
    return lead.id;
  }

  const config: GmailConfig = { gmailAccount: ACCOUNT, senderName: 'Example Sender', featureEnabled: true, outboundActionsEnabled: true, credentialsConfigured: true, maxPerDay: 20, minIntervalMs: 0 };
  const service = (provider = new MockGmailDraftProvider(ACCOUNT)) => new GmailDraftService({ provider, store: new GmailRepository(handle.db), uow: new DrizzleGmailUnitOfWork(handle.db), logger, config });

  it('creates a draft, persists metadata, lead → DRAFT_CREATED; re-run reuses (no duplicate)', async () => {
    const leadId = await seed();
    const data = await new GmailInputRepository(handle.db).latest(leadId);
    expect(data.recipientEmail).toBe(RECIP);
    const inp = { leadId, leadStatus: 'HUMAN_APPROVED', finalization: data.finalization, subject: data.subject, recipientEmail: data.recipientEmail };

    const runs = new PipelineRunsRepository(handle.db);
    const r = await service().createDraft(inp, await runs.start('gmail:1', true));
    expect(r.outcome).toBe('DRAFT_CREATED');

    const rows = await handle.db.select().from(gmailDrafts).where(eq(gmailDrafts.leadId, leadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('DRAFT_CREATED');
    expect(rows[0]?.providerDraftId).toBeTruthy();
    expect(rows[0]?.threadId).toBeTruthy();
    expect(rows[0]?.sourceEmailVersion).toBe('rh');
    expect((await handle.db.select().from(leadsTbl).where(eq(leadsTbl.id, leadId)))[0]?.status).toBe('DRAFT_CREATED');

    // Re-run: reset lead to HUMAN_APPROVED; the existing draft must be reused, no duplicate.
    await new LeadsRepository(handle.db).updateStatus(leadId, 'HUMAN_APPROVED', new Date());
    const provider2 = new MockGmailDraftProvider(ACCOUNT);
    const r2 = await service(provider2).createDraft({ ...inp, leadStatus: 'HUMAN_APPROVED' }, await runs.start('gmail:2', true));
    expect(r2.outcome).toBe('DUPLICATE_REUSED');
    expect(provider2.created).toHaveLength(0);
    expect(await handle.db.select().from(gmailDrafts).where(eq(gmailDrafts.leadId, leadId))).toHaveLength(1);
  });
});
