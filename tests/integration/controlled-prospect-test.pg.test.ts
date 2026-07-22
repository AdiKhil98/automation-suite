import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { controlledEmailArtifactHash, controlledRecipientFingerprint } from '../../src/domain/prospect/controlled-test.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { ControlledTestRepository } from '../../src/persistence/repositories/controlled-test.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { controlledTestEvaluations, leadFacts, prospectRuns, sendingReadinessApprovals } from '../../src/persistence/schema.js';
import { requireIntegrationTestDatabase } from '../support/test-database.js';

const testDatabase = requireIntegrationTestDatabase();

describe('controlled prospect orchestration records', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  it('keeps recipient override separate, approvals hash-bound, and readiness non-sendable', async () => {
    const db = handle.db;
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await new LeadsRepository(db).create(lead);
    const leadId = lead.id;
    const pipelineRunId = await new PipelineRunsRepository(db).start('prospect:lawyers', true);
    const prospectRunId = randomUUID();
    await db.insert(prospectRuns).values({ id: prospectRunId, pipelineRunId, operatorNiche: 'lawyers',
      includedTypes: ['lawyer'], requestedLocation: 'Example City', formattedLocation: 'Example City',
      latitude: 1, longitude: 1, locationProvider: 'manual', radiusKm: 10, rankPreference: 'POPULARITY',
      targetQualified: 1, maxCandidates: 1, continuePipeline: true, status: 'COMPLETED', result: 'TARGET_REACHED',
      qualifiedCount: 1, processedCount: 1, externalCalls: {}, discoveredAt: new Date(), completedAt: new Date() });
    const id = randomUUID();
    const recipient = 'operator@controlled.example';
    const fingerprint = controlledRecipientFingerprint(recipient);
    const expiresAt = new Date(Date.now() + 60_000);
    const repo = new ControlledTestRepository(db);
    await repo.start({ id, prospectRunId, pipelineRunId, leadId, recipientEmail: recipient,
      recipientFingerprint: fingerprint, recipientEnvName: 'TEST_RECIPIENT_EMAIL', expiresAt });
    const artifactHash = controlledEmailArtifactHash('Example subject', 'Example body');
    await repo.approve({ controlledTestRunId: id, leadId, artifactType: 'EMAIL_DRAFT', artifactId: 'email-1',
      artifactHash, recipientFingerprint: fingerprint, expiresAt });
    expect(await repo.isArtifactApproved({ controlledTestRunId: id, leadId, artifactType: 'EMAIL_DRAFT',
      artifactId: 'email-1', artifactHash })).toBe(true);
    expect(await repo.isArtifactApproved({ controlledTestRunId: id, leadId, artifactType: 'EMAIL_DRAFT',
      artifactId: 'email-1', artifactHash: `${artifactHash}changed` })).toBe(false);

    const facts = await db.select().from(leadFacts).where(eq(leadFacts.leadId, leadId));
    expect(facts.some((f) => f.factType === 'contact_email')).toBe(false);
    expect(await db.select().from(sendingReadinessApprovals)).toHaveLength(0);
    expect(await db.select().from(controlledTestEvaluations)).toHaveLength(0);
  });
});
