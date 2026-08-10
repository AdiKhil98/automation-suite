import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { deterministicFindingApproveCommand } from '../../src/cli/commands/deterministic-finding-approve.js';
import { resolveComposerFindings } from '../../src/domain/deterministic-finding/composer-projection.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import { type CliContext } from '../../src/cli/context.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { DeterministicFindingRepository } from '../../src/persistence/repositories/deterministic-finding.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  auditRuns,
  capturedPages,
  captureEvidence,
  deterministicFindingEvidence,
  deterministicFindings,
  pipelineEvents,
  websiteCaptureRuns,
} from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });
const URL_PRIMARY = 'https://www.whitgift.example/';

interface Seeded {
  leadId: string;
  captureRunId: string;
  telId: string;
  mailtoId: string;
  bookCtaId: string;
  priorAuditRunId: string;
}

describe('deterministicFindingApprove (PostgreSQL)', () => {
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

  /** Seed a NEEDS_MANUAL_REVIEW lead + completed booking-aware capture with tel/mailto AND a
   * booking-INTENT CTA (a "Book appointment" control routing to /contact) + a prior VALIDATION_FAILED
   * audit run with zero findings (the Whitgift/Mayfield situation). With `withBookingCta` a DIRECT
   * online-booking CTA is also added, which must disqualify the finding. */
  async function seed(opts: { withBookingCta?: boolean } = {}): Promise<Seeded> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await leads.updateStatus(lead.id, 'NEEDS_MANUAL_REVIEW', new Date());

    const runId = await new PipelineRunsRepository(handle.db).start('capture:test', true);
    const captureRunId = randomUUID();
    await handle.db.insert(websiteCaptureRuns).values({
      id: captureRunId,
      leadId: lead.id,
      runId,
      purpose: 'AUDIT_CAPTURE',
      outcome: 'CAPTURED',
      primaryUrl: URL_PRIMARY,
      desktopPrimaryComplete: true,
      mobilePrimaryComplete: true,
      // Booking-aware capture policy so a verified booking-absence conclusion is permitted.
      pageSelectionPolicyVersion: 'cap-pages-2',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const pageId = randomUUID();
    await handle.db.insert(capturedPages).values({
      id: pageId, captureRunId, requestedUrl: URL_PRIMARY, finalUrl: URL_PRIMARY, role: 'primary', profile: 'desktop', ok: true,
    });
    const telId = randomUUID();
    const mailtoId = randomUUID();
    const bookCtaId = randomUUID();
    const rows = [
      { id: telId, capturedPageId: pageId, evidenceType: 'tel', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a[href^=tel]', extractedValue: '+44 20 1234 5678', normalizedValue: '+442012345678' },
      { id: mailtoId, capturedPageId: pageId, evidenceType: 'mailto', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a[href^=mailto]', extractedValue: 'reception@whitgift.example', normalizedValue: 'reception@whitgift.example' },
      { id: randomUUID(), capturedPageId: pageId, evidenceType: 'title', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'title', extractedValue: 'Whitgift Dental', normalizedValue: 'whitgift dental' },
      // Booking-INTENT control: "Book appointment" routing to the contact page (positive friction anchor).
      { id: bookCtaId, capturedPageId: pageId, evidenceType: 'cta', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a.book', extractedValue: `text=Book appointment href=${URL_PRIMARY}contact/ tag=a`, normalizedValue: 'book appointment' },
    ];
    if (opts.withBookingCta) {
      rows.push({ id: randomUUID(), capturedPageId: pageId, evidenceType: 'cta', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a.book-online', extractedValue: 'Book online', normalizedValue: 'book online' });
    }
    await handle.db.insert(captureEvidence).values(rows);

    // Prior VALIDATION_FAILED audit run with zero findings — must remain byte-for-byte unchanged.
    const priorAuditRunId = randomUUID();
    await handle.db.insert(auditRuns).values({
      id: priorAuditRunId,
      leadId: lead.id,
      runId: null,
      captureRunId,
      outcome: 'VALIDATION_FAILED',
      rubricVersion: 'audit-rubric-1',
      generatorPromptVersion: 'gen-1',
      reviewerPromptVersion: 'rev-1',
      schemaVersion: 'audit-schema-1',
      opportunityRulesVersion: 'opp-rules-1',
      opportunityRulesHash: 'hash-1',
      provider: 'openai',
      requestedAuditModel: 'sol',
      resolvedAuditModel: 'sol',
      reasoningEffort: 'medium',
      reasoningMode: 'default',
      imageDetail: 'high',
      responseStore: false,
      inputFingerprint: 'fp-1',
      totalCostUsd: 0.15909,
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      completedAt: new Date('2026-08-01T00:01:00.000Z'),
    });

    return { leadId: lead.id, captureRunId, telId, mailtoId, bookCtaId, priorAuditRunId };
  }

  it('dry preview: validates and prints the finding but writes nothing and does not transition', async () => {
    const s = await seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await deterministicFindingApproveCommand(ctx(), {
      lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: false,
    });

    expect(process.exitCode).toBe(0);
    expect(await handle.db.select().from(deterministicFindings)).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('NEEDS_MANUAL_REVIEW');
    expect(log.mock.calls.flat().join('\n')).toContain('DETERMINISTIC_OPERATOR_APPROVED');
  });

  it('confirm: persists the finding + evidence links, transitions the lead, records the operator NOTE', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await deterministicFindingApproveCommand(ctx(), {
      lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: true,
    });

    expect(process.exitCode).toBe(0);
    const found = await handle.db.select().from(deterministicFindings).where(eq(deterministicFindings.leadId, s.leadId));
    expect(found).toHaveLength(1);
    expect(found[0]?.category).toBe('BOOKING_FRICTION');
    expect(found[0]?.provenance).toBe('DETERMINISTIC_OPERATOR_APPROVED');
    expect(found[0]?.safeForOutreach).toBe(true);
    expect(found[0]?.status).toBe('ACTIVE');
    expect(found[0]?.observation.startsWith('On the pages reviewed,')).toBe(true);
    expect(found[0]?.evidenceHash).toHaveLength(64);

    const links = await handle.db.select().from(deterministicFindingEvidence);
    expect(links.map((l) => l.captureEvidenceId).sort()).toEqual([s.bookCtaId].sort());

    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('OUTREACH_READY_DETERMINISTIC');

    const notes = (await handle.db.select().from(pipelineEvents).where(eq(pipelineEvents.leadId, s.leadId)))
      .filter((e) => e.type === 'NOTE');
    expect(notes.some((n) => JSON.stringify(n.data).includes('DETERMINISTIC_OPERATOR_APPROVED'))).toBe(true);
  });

  it('leaves the prior VALIDATION_FAILED audit run untouched', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = (await handle.db.select().from(auditRuns).where(eq(auditRuns.id, s.priorAuditRunId)))[0];

    await deterministicFindingApproveCommand(ctx(), {
      lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: true,
    });

    const after = (await handle.db.select().from(auditRuns).where(eq(auditRuns.id, s.priorAuditRunId)))[0];
    expect(after).toEqual(before);
    expect(after?.outcome).toBe('VALIDATION_FAILED');
    // No new audit run was fabricated.
    expect(await handle.db.select().from(auditRuns).where(eq(auditRuns.leadId, s.leadId))).toHaveLength(1);
  });

  it('prevents a duplicate active finding for the same lead+category', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const args = { lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: true };

    await deterministicFindingApproveCommand(ctx(), args);
    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('OUTREACH_READY_DETERMINISTIC');

    // Second attempt: lead is no longer NEEDS_MANUAL_REVIEW, so it fails closed before any duplicate write.
    process.exitCode = 0;
    await expect(deterministicFindingApproveCommand(ctx(), args)).rejects.toThrow(/LEAD_NOT_APPROVABLE/);
    expect(await handle.db.select().from(deterministicFindings).where(eq(deterministicFindings.leadId, s.leadId))).toHaveLength(1);
    err.mockRestore();
  });

  it('fails closed (no write, no transition) when a direct booking signal exists', async () => {
    const s = await seed({ withBookingCta: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await deterministicFindingApproveCommand(ctx(), {
      lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: true,
    });

    expect(process.exitCode).toBe(1);
    expect(await handle.db.select().from(deterministicFindings)).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(s.leadId))?.status).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('projects the persisted finding into the composer input (deterministic provenance)', async () => {
    const s = await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await deterministicFindingApproveCommand(ctx(), {
      lead: s.leadId, category: 'BOOKING_FRICTION', evidence: `${s.bookCtaId}`, by: 'op@example.com', confirm: true,
    });

    const projected = await new DeterministicFindingRepository(handle.db).listActiveComposerFindings(s.leadId);
    expect(projected).toHaveLength(1);
    const resolved = resolveComposerFindings(null, projected);
    expect(resolved.source).toBe('DETERMINISTIC_OPERATOR_APPROVED');
    expect(resolved.findings[0]?.safeForOutreach).toBe(true);
    expect(resolved.findings[0]?.observation.startsWith('On the pages reviewed,')).toBe(true);
  });
});
