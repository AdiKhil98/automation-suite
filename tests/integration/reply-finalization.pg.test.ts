import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { replyEmailFinalizeCommand } from '../../src/cli/commands/reply-email-finalize.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import { type CliContext } from '../../src/cli/context.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { sha256Hex } from '../../src/utils/hash.js';
import { emailDraftFinalizations, emailDrafts } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const BODY = 'Hi,\n\nYour booking controls lead to a contact page.\n\nBest,\nAdi';

describe('replyEmailFinalize (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    process.exitCode = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  function ctx(): CliContext {
    const leads = new LeadsRepository(handle.db);
    const events = new PipelineRepository(handle.db);
    return { db: handle.db, leads, events, service: new LeadService(leads, events), logger } as unknown as CliContext;
  }

  async function seed(opts: { humanApproved?: boolean } = {}): Promise<{ leadId: string; draftId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await leads.updateStatus(lead.id, opts.humanApproved === false ? 'READY_FOR_HUMAN_APPROVAL' : 'HUMAN_APPROVED', new Date());
    const draftId = randomUUID();
    await handle.db.insert(emailDrafts).values({
      id: draftId, leadId: lead.id, subject: 'A note about your booking path', body: BODY, ctaKind: 'reply',
      status: 'APPROVED', authorship: 'OPERATOR', humanDecision: 'APPROVED', humanReviewedBy: 'Adi',
      writerPromptVersion: 'OPERATOR', reviewerPromptVersion: 'OPERATOR', schemaVersion: 'email-copy-schema-3',
      rulesVersion: 'operator-email-1', provider: 'operator', requestedWriterModel: 'OPERATOR', requestedReviewerModel: 'OPERATOR', totalCostUsd: 0,
    });
    return { leadId: lead.id, draftId };
  }

  it('confirm: creates a REPLY_DIRECT finalization with no deployment and an exact-body resolution', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await replyEmailFinalizeCommand(ctx(), { lead: s.leadId, draft: s.draftId, by: 'Adi', confirm: true });

    const rows = await handle.db.select().from(emailDraftFinalizations).where(eq(emailDraftFinalizations.originalDraftId, s.draftId));
    expect(rows).toHaveLength(1);
    const f = rows[0];
    expect(f?.kind).toBe('REPLY_DIRECT');
    expect(f?.deploymentRunId).toBeNull();
    expect(f?.verifiedDeploymentUrl).toBeNull();
    expect(f?.finalHumanDecision).toBe('APPROVED');
    expect(f?.finalReviewedBy).toBe('Adi');
    expect(f?.resolvedBody).toBe(BODY);
    expect(f?.originalBodyHash).toBe(sha256Hex(BODY));
    expect(f?.resolvedBodyHash).toBe(sha256Hex(BODY));
    // Lead stays HUMAN_APPROVED (no transition).
    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('HUMAN_APPROVED');
  });

  it('is idempotent: a second confirm is a no-op (still one finalization)', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await replyEmailFinalizeCommand(ctx(), { lead: s.leadId, draft: s.draftId, by: 'Adi', confirm: true });
    await replyEmailFinalizeCommand(ctx(), { lead: s.leadId, draft: s.draftId, by: 'Adi', confirm: true });
    expect(await handle.db.select().from(emailDraftFinalizations).where(eq(emailDraftFinalizations.originalDraftId, s.draftId))).toHaveLength(1);
  });

  it('fails closed when the lead is not HUMAN_APPROVED', async () => {
    const s = await seed({ humanApproved: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await replyEmailFinalizeCommand(ctx(), { lead: s.leadId, draft: s.draftId, by: 'Adi', confirm: true });
    expect(process.exitCode).toBe(1);
    expect(await handle.db.select().from(emailDraftFinalizations).where(eq(emailDraftFinalizations.originalDraftId, s.draftId))).toHaveLength(0);
  });

  it('dry preview writes nothing', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await replyEmailFinalizeCommand(ctx(), { lead: s.leadId, draft: s.draftId, by: 'Adi', confirm: false });
    expect(await handle.db.select().from(emailDraftFinalizations).where(eq(emailDraftFinalizations.originalDraftId, s.draftId))).toHaveLength(0);
  });
});
