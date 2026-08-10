import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { deterministicFindingApproveCommand } from '../../src/cli/commands/deterministic-finding-approve.js';
import { operatorEmailApproveCommand } from '../../src/cli/commands/operator-email-approve.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import { type CliContext } from '../../src/cli/context.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  capturedPages,
  captureEvidence,
  deterministicFindings,
  emailDrafts,
  pipelineEvents,
  websiteCaptureRuns,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const URL_PRIMARY = 'https://www.mayfield.example/';
const SUBJECT = 'Your appointment booking path';
const BODY = `Hi,

I noticed your booking controls lead to a contact page rather than a direct online scheduling flow.

Adding a direct booking path could make that next step more straightforward.

If useful, I can show you what that could look like.

Best,
Adi`;

describe('operatorEmailApprove (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  function ctx(): CliContext {
    const leads = new LeadsRepository(handle.db);
    const events = new PipelineRepository(handle.db);
    return { db: handle.db, leads, events, service: new LeadService(leads, events), logger } as unknown as CliContext;
  }

  /** Seed a lead + booking-aware capture + booking-intent CTA, then create the deterministic finding so
   * the lead is OUTREACH_READY_DETERMINISTIC with one ACTIVE finding. Returns the ids the email needs. */
  async function seedOutreachReady(): Promise<{ leadId: string; findingId: string; bookCtaId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await leads.updateStatus(lead.id, 'NEEDS_MANUAL_REVIEW', new Date());

    const runId = await new PipelineRunsRepository(handle.db).start('capture:test', true);
    const captureRunId = randomUUID();
    await handle.db.insert(websiteCaptureRuns).values({
      id: captureRunId, leadId: lead.id, runId, purpose: 'AUDIT_CAPTURE', outcome: 'CAPTURED',
      primaryUrl: URL_PRIMARY, desktopPrimaryComplete: true, mobilePrimaryComplete: true,
      pageSelectionPolicyVersion: 'cap-pages-2', startedAt: new Date(), completedAt: new Date(),
    });
    const pageId = randomUUID();
    await handle.db.insert(capturedPages).values({
      id: pageId, captureRunId, requestedUrl: URL_PRIMARY, finalUrl: URL_PRIMARY, role: 'primary', profile: 'desktop', ok: true,
    });
    const bookCtaId = randomUUID();
    await handle.db.insert(captureEvidence).values([
      { id: bookCtaId, capturedPageId: pageId, evidenceType: 'cta', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a.book', extractedValue: `text=Book appointment href=${URL_PRIMARY}contact/ tag=a`, normalizedValue: 'book appointment' },
    ]);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await deterministicFindingApproveCommand(ctx(), { lead: lead.id, category: 'BOOKING_FRICTION', evidence: bookCtaId, by: 'Adi', confirm: true });
    const found = await handle.db.select().from(deterministicFindings).where(eq(deterministicFindings.leadId, lead.id));
    return { leadId: lead.id, findingId: found[0]?.id ?? '', bookCtaId };
  }

  function bodyFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'op-email-'));
    const path = join(dir, 'body.txt');
    writeFileSync(path, BODY, 'utf8');
    return path;
  }

  it('confirm: persists an OPERATOR-authored email, transitions the lead, records the NOTE', async () => {
    const s = await seedOutreachReady();
    await operatorEmailApproveCommand(ctx(), { lead: s.leadId, finding: s.findingId, subject: SUBJECT, bodyFile: bodyFile(), by: 'Adi', confirm: true });

    expect(process.exitCode).toBe(0);
    const rows = await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, s.leadId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.authorship).toBe('OPERATOR');
    expect(row?.status).toBe('APPROVED');
    expect(row?.provider).toBe('operator');
    expect(row?.requestedWriterModel).toBe('OPERATOR');
    expect(row?.requestedReviewerModel).toBe('OPERATOR');
    expect(row?.totalCostUsd).toBe(0);
    // Exact-text preservation.
    expect(row?.subject).toBe(SUBJECT);
    expect(row?.body).toBe(BODY);

    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('READY_FOR_HUMAN_APPROVAL');

    const notes = (await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, s.leadId))).filter((e) => e.type === 'NOTE');
    const note = notes.find((n) => JSON.stringify(n.data).includes('operator') && JSON.stringify(n.data).includes(s.findingId));
    expect(note).toBeDefined();
    expect(JSON.stringify(note?.data)).toContain('OPERATOR');
    expect(JSON.stringify(note?.data)).toContain(s.bookCtaId);
  });

  it('leaves the deterministic finding unchanged', async () => {
    const s = await seedOutreachReady();
    const before = (await handle.db.select().from(deterministicFindings).where(eq(deterministicFindings.id, s.findingId)))[0];
    await operatorEmailApproveCommand(ctx(), { lead: s.leadId, finding: s.findingId, subject: SUBJECT, bodyFile: bodyFile(), by: 'Adi', confirm: true });
    const after = (await handle.db.select().from(deterministicFindings).where(eq(deterministicFindings.id, s.findingId)))[0];
    expect(after).toEqual(before);
  });

  it('dry preview writes nothing and does not transition', async () => {
    const s = await seedOutreachReady();
    await operatorEmailApproveCommand(ctx(), { lead: s.leadId, finding: s.findingId, subject: SUBJECT, bodyFile: bodyFile(), by: 'Adi', confirm: false });
    expect(await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, s.leadId))).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('OUTREACH_READY_DETERMINISTIC');
  });

  it('prevents a duplicate: second confirm fails closed (lead no longer OUTREACH_READY_DETERMINISTIC)', async () => {
    const s = await seedOutreachReady();
    const args = { lead: s.leadId, finding: s.findingId, subject: SUBJECT, bodyFile: bodyFile(), by: 'Adi', confirm: true };
    await operatorEmailApproveCommand(ctx(), args);
    await expect(operatorEmailApproveCommand(ctx(), { ...args, bodyFile: bodyFile() })).rejects.toThrow(/LEAD_NOT_APPROVABLE/);
    expect(await handle.db.select().from(emailDrafts).where(eq(emailDrafts.leadId, s.leadId))).toHaveLength(1);
  });
});
