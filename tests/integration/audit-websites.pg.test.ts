import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService, type AuditConfig, type AuditTxRepos, type AuditUnitOfWork } from '../../src/domain/audit/audit-service.js';
import { recoverEnvelopes } from '../../src/domain/audit/envelope-recovery.js';
import { buildEvidencePackage, type EvidencePackage } from '../../src/domain/audit/evidence-package.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { defaultMockAuditResponder } from '../../src/fixtures/mock-audit-responses.js';
import { LocalEnvelopeStore } from '../../src/integrations/audit/envelope-store.js';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { DrizzleAuditUnitOfWork } from '../../src/persistence/audit-unit-of-work.js';
import { AuditInputRepository } from '../../src/persistence/repositories/audit-input.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import {
  auditFindingEvidence,
  auditFindings,
  auditReviews,
  auditRuns,
  captureEvidence,
  capturedPages,
  modelCalls,
  opportunityAssessments,
  websiteCaptureRuns,
} from '../../src/persistence/schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });
const URL_PRIMARY = 'https://www.acmedental.example/';

const CONFIG: AuditConfig = {
  auditModel: 'mock-audit-1',
  reviewModel: 'mock-audit-1',
  auditEffort: 'medium',
  reviewEffort: 'medium',
  imageDetail: 'high',
  store: false,
  timeoutMs: 1000,
  maxOutputTokens: 4000,
  maxRetries: 0,
  maxCallsPerLead: 4,
  maxGeneratorAttempts: 2,
  maxReviewerAttempts: 2,
  maxCostUsdPerLead: null,
  severeCaptureLimitations: false,
  promptCacheEnabled: true,
  worstCaseInputTokensPerCall: 35_800,
};

describe.skipIf(!DATABASE_URL)('auditWebsites (PostgreSQL)', () => {
  let handle: DbHandle;
  let envDir: string;

  beforeEach(async () => {
    handle ??= createDb(DATABASE_URL as string);
    await truncateAll(handle.db);
    envDir = await mkdtemp(join(tmpdir(), 'auditenv-'));
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  /** Seed a READY_FOR_AUDIT lead with a completed AUDIT_CAPTURE run + evidence rows. */
  async function seed(): Promise<{ leadId: string; captureRunId: string }> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    await leads.updateStatus(lead.id, 'READY_FOR_AUDIT', new Date());

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
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const pageId = randomUUID();
    await handle.db.insert(capturedPages).values({
      id: pageId,
      captureRunId,
      requestedUrl: URL_PRIMARY,
      finalUrl: URL_PRIMARY,
      role: 'primary',
      profile: 'desktop',
      ok: true,
    });
    await handle.db.insert(captureEvidence).values([
      { id: randomUUID(), capturedPageId: pageId, evidenceType: 'cta', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a.book', extractedValue: 'Book an appointment', normalizedValue: 'book an appointment' },
      { id: randomUUID(), capturedPageId: pageId, evidenceType: 'tel', sourceUrl: URL_PRIMARY, profile: 'desktop', selector: 'a[href^=tel]', extractedValue: '+43 1 234 5678', normalizedValue: '+4312345678' },
    ]);
    return { leadId: lead.id, captureRunId };
  }

  async function loadPackage(leadId: string): Promise<{ pkg: EvidencePackage; captureRunId: string }> {
    const source = await new AuditInputRepository(handle.db).latestAuditCapture(leadId);
    if (!source) throw new Error('no capture source');
    const pkg = buildEvidencePackage({
      leadId,
      captureRunId: source.captureRunId,
      facts: { businessName: 'Acme Dental', category: 'dental_clinic', city: 'Vienna', officialDomain: 'www.acmedental.example' },
      primaryUrl: source.primaryUrl,
      evidence: source.evidence,
      images: [],
      versions: { extractor: 't', emulation: 't', pageSelection: 't' },
      limits: { maxEvidence: 50, maxSecondaryPages: 3, maxEvidenceChars: 300, maxImages: 2 },
    });
    return { pkg, captureRunId: source.captureRunId };
  }

  function service(responder: MockResponder = defaultMockAuditResponder, uow?: AuditUnitOfWork): { svc: AuditService; envelopes: LocalEnvelopeStore } {
    const envelopes = new LocalEnvelopeStore(envDir);
    const svc = new AuditService({
      provider: new MockLlmProvider(responder),
      uow: uow ?? new DrizzleAuditUnitOfWork(handle.db),
      envelopes,
      logger,
      config: CONFIG,
    });
    return { svc, envelopes };
  }

  it('AUDITED: persists run, findings, evidence links, review, score, model calls; lead → OPPORTUNITY_READY', async () => {
    const { leadId } = await seed();
    const { pkg, captureRunId } = await loadPackage(leadId);
    const { svc } = service();
    const runId = await new PipelineRunsRepository(handle.db).start('audit:test', true);

    const r = await svc.audit({ leadId, captureRunId, package: pkg }, runId);
    expect(r.outcome).toBe('AUDITED');
    expect(r.callsMade).toBe(2);

    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('OPPORTUNITY_READY');

    const runs = await handle.db.select().from(auditRuns).where(eq(auditRuns.leadId, leadId));
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.outcome).toBe('AUDITED');
    expect(run?.rubricVersion).toBe('audit-rubric-1');
    expect(run?.inputFingerprint).toBeTruthy();

    const findings = await handle.db.select().from(auditFindings).where(eq(auditFindings.auditRunId, run?.id ?? ''));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.id !== f.findingRef)).toBe(true); // DB UUIDs, not model refs

    const links = await handle.db.select().from(auditFindingEvidence);
    expect(links.length).toBeGreaterThanOrEqual(1); // FK to real capture_evidence rows held

    const reviews = await handle.db.select().from(auditReviews).where(eq(auditReviews.auditRunId, run?.id ?? ''));
    expect(reviews).toHaveLength(1);

    const opps = await handle.db.select().from(opportunityAssessments).where(eq(opportunityAssessments.leadId, leadId));
    expect(opps).toHaveLength(1);
    expect(opps[0]?.overallScore).toBeGreaterThan(0);
    expect(opps[0]?.rulesVersion).toBe('opp-rules-1');

    const calls = await handle.db.select().from(modelCalls).where(eq(modelCalls.leadId, leadId));
    expect(calls).toHaveLength(2);
    expect(calls.map((m) => m.purpose).sort()).toEqual(['audit_review', 'website_audit']);

    // Envelope removed after successful persistence.
    expect((await readdir(envDir)).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('MODEL_REFUSAL: every paid attempt is recorded and lead routes to NEEDS_MANUAL_REVIEW', async () => {
    const { leadId } = await seed();
    const { pkg, captureRunId } = await loadPackage(leadId);
    const { svc } = service(() => ({ status: 'refusal', refusal: 'no' }));
    const runId = await new PipelineRunsRepository(handle.db).start('audit:test', true);

    const r = await svc.audit({ leadId, captureRunId, package: pkg }, runId);
    expect(r.outcome).toBe('MODEL_REFUSAL');
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('NEEDS_MANUAL_REVIEW');

    const calls = await handle.db.select().from(modelCalls).where(eq(modelCalls.leadId, leadId));
    expect(calls).toHaveLength(2); // both refusal attempts accounted despite failure
    expect(calls.every((m) => m.status === 'refusal')).toBe(true);
  });

  it('envelope recovery: failed DB write is replayed idempotently without new model calls', async () => {
    const { leadId } = await seed();
    const { pkg, captureRunId } = await loadPackage(leadId);

    // A unit-of-work that fails once, simulating a DB outage after paid calls.
    const real = new DrizzleAuditUnitOfWork(handle.db);
    let failures = 0;
    const failingUow: AuditUnitOfWork = {
      transaction: <T,>(fn: (repos: AuditTxRepos) => Promise<T>): Promise<T> => {
        failures += 1;
        if (failures === 1) throw new Error('simulated db outage');
        return real.transaction(fn);
      },
    };
    const { svc, envelopes } = service(defaultMockAuditResponder, failingUow);
    const runId = await new PipelineRunsRepository(handle.db).start('audit:test', true);

    await expect(svc.audit({ leadId, captureRunId, package: pkg }, runId)).rejects.toThrow('simulated db outage');

    // Paid results are safe on disk; nothing was persisted.
    expect((await readdir(envDir)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(await handle.db.select().from(auditRuns)).toHaveLength(0);
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('READY_FOR_AUDIT');

    // Replay: persists everything and transitions the lead — zero model calls.
    const summary = await recoverEnvelopes(real, envelopes, logger);
    expect(summary).toMatchObject({ scanned: 1, replayed: 1, failed: 0 });
    expect(await handle.db.select().from(auditRuns)).toHaveLength(1);
    expect((await new LeadsRepository(handle.db).getById(leadId))?.status).toBe('OPPORTUNITY_READY');
    expect((await readdir(envDir)).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    // Second run is a no-op (idempotent).
    const again = await recoverEnvelopes(real, envelopes, logger);
    expect(again).toMatchObject({ scanned: 0, replayed: 0, failed: 0 });
    expect(await handle.db.select().from(auditRuns)).toHaveLength(1);
  });
});
