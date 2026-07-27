import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEvidenceExport,
  countBySourceType,
} from '../../src/domain/ku64-export/evidence-export.js';
import {
  assertWithinLocalData,
  resolveEvidenceOutputPath,
} from '../../src/domain/ku64-export/output-path.js';
import { readOnlyGuard } from '../../src/domain/ku64-export/read-only-guard.js';
import {
  KU64_EXPORT_SOURCE_TYPES,
  Ku64ExportError,
  type Ku64RawExportData,
} from '../../src/domain/ku64-export/types.js';
import { Ku64ExportReadRepository } from '../../src/persistence/ku64-export-read.js';
import { type DbExecutor } from '../../src/persistence/db.js';
import { leads as leadsTable } from '../../src/persistence/schema.js';

const AT = new Date('2026-01-01T00:00:00.000Z');
const LEAD_ID = 'lead-ku64';

/** A complete, internally-consistent, ku64.de-bound raw export model. */
function validData(): Ku64RawExportData {
  return {
    leads: [
      {
        id: LEAD_ID,
        businessName: 'KU64 Zahnaerzte',
        normalizedName: 'ku64 zahnaerzte',
        domain: 'https://www.ku64.de',
        normalizedDomain: 'ku64.de',
        city: 'Berlin',
        country: 'DE',
        status: 'OPPORTUNITY_READY',
        factsSource: 'website',
        factsSourceUrl: 'https://www.ku64.de',
        factsCapturedAt: AT,
      },
    ],
    leadFacts: [
      {
        id: 'fact-1',
        leadId: LEAD_ID,
        factType: 'website',
        value: 'https://www.ku64.de',
        normalizedValue: 'ku64.de',
        sourceType: 'website',
        sourceUrl: 'https://www.ku64.de',
        confidence: 1,
        capturedAt: AT,
        isCurrent: true,
      },
      {
        id: 'fact-2',
        leadId: LEAD_ID,
        factType: 'phone',
        value: '+49 30 864 64 64',
        normalizedValue: '3086464',
        sourceType: 'website',
        sourceUrl: 'https://www.ku64.de/kontakt',
        confidence: 0.9,
        capturedAt: AT,
        isCurrent: true,
      },
    ],
    qualificationResults: [
      {
        id: 'qr-1',
        leadId: LEAD_ID,
        campaign: 'ku64',
        qualificationStage: 'PRE_AUDIT',
        rulesVersion: 'rules-1',
        rulesConfigHash: 'hash-1',
        decision: 'ACCEPT',
        priority: 'HIGH',
        nextStep: 'AUDIT',
        businessViabilityScore: 80,
        auditabilityScore: 70,
        contactabilityScore: 90,
        opportunityScore: 60,
        deterministicScore: 75,
        triggeredRules: ['has_website'],
        missingRequiredFacts: [],
        reasons: [{ code: 'ok', detail: 'strong' }],
        inputFingerprint: 'fp-qr-1',
        evaluatedAt: AT,
      },
    ],
    qualificationResultFacts: [{ qualificationResultId: 'qr-1', leadFactId: 'fact-1' }],
    auditRuns: [
      {
        id: 'audit-1',
        leadId: LEAD_ID,
        captureRunId: 'capture-1',
        outcome: 'AUDITED',
        rubricVersion: 'rubric-1',
        generatorPromptVersion: 'gen-1',
        reviewerPromptVersion: 'rev-1',
        schemaVersion: 'audit-schema-1',
        opportunityRulesVersion: 'opp-1',
        opportunityRulesHash: 'opp-hash-1',
        inputFingerprint: 'fp-audit-1',
        startedAt: AT,
        completedAt: AT,
      },
    ],
    auditFindings: [
      {
        id: 'finding-1',
        auditRunId: 'audit-1',
        findingRef: 'F1',
        category: 'CTA_CLARITY',
        observation: 'CTA is weak',
        affectedUrls: ['https://www.ku64.de'],
        affectedProfiles: ['mobile'],
        severity: 'MEDIUM',
        confidence: 0.8,
        businessImpact: 'fewer bookings',
        recommendation: 'add a clear CTA',
        safeForOutreach: true,
        outreachAngle: 'booking',
        uncertainty: null,
        reviewDecision: 'ACCEPT',
      },
    ],
    auditFindingEvidence: [{ auditFindingId: 'finding-1', captureEvidenceId: 'capev-1' }],
    auditReviews: [{ id: 'review-1', auditRunId: 'audit-1', overallDecision: 'ACCEPT' }],
    auditReviewFindings: [
      {
        id: 'rf-1',
        auditReviewId: 'review-1',
        findingRef: 'F1',
        decision: 'ACCEPT',
        evidenceSupported: true,
        impactSupported: true,
        safeForOutreach: true,
        problems: [],
        revisedObservation: null,
        revisedBusinessImpact: null,
        revisedRecommendation: null,
        revisedOutreachAngle: null,
      },
    ],
    opportunityAssessments: [
      {
        id: 'opp-1',
        auditRunId: 'audit-1',
        leadId: LEAD_ID,
        conversionScore: 60,
        mobileScore: 55,
        trustScore: 70,
        contactabilityScore: 90,
        overallScore: 65,
        rulesVersion: 'opp-1',
        rulesHash: 'opp-hash-1',
        breakdown: { conversion: 60 },
        capsApplied: [],
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        leadId: LEAD_ID,
        sourceType: 'website',
        sourceUrl: 'https://www.ku64.de',
        claim: 'Homepage lacks a prominent booking CTA',
        confidence: 0.8,
        selector: 'header',
        capturedAt: AT,
      },
    ],
    captureRuns: [
      {
        id: 'capture-1',
        leadId: LEAD_ID,
        purpose: 'AUDIT_CAPTURE',
        outcome: 'CAPTURED',
        primaryUrl: 'https://www.ku64.de',
        normalizedEvidenceFingerprint: 'cap-fp-1',
        extractorVersion: 'extract-1',
        pageSelectionPolicyVersion: 'select-1',
        startedAt: AT,
        completedAt: AT,
      },
    ],
    capturedPages: [
      {
        id: 'page-1',
        captureRunId: 'capture-1',
        requestedUrl: 'https://www.ku64.de',
        finalUrl: 'https://www.ku64.de/',
        canonicalUrl: 'https://www.ku64.de/',
        httpStatus: 200,
        role: 'home',
        profile: 'mobile',
        ok: true,
        hasHorizontalOverflow: false,
      },
    ],
    captureEvidence: [
      {
        id: 'capev-1',
        capturedPageId: 'page-1',
        evidenceType: 'cta',
        sourceUrl: 'https://www.ku64.de',
        profile: 'mobile',
        selector: 'header a',
        normalizedValue: 'kontakt',
      },
    ],
  };
}

const OK_OPTS = { expectedDomain: 'ku64.de', confirmProductionRead: true, exportedAt: AT.toISOString() };

/** Assert `fn` throws a Ku64ExportError whose reason code matches. */
function throwsWithReason(fn: () => unknown, reason: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Ku64ExportError);
  expect((thrown as Ku64ExportError).code).toBe(`KU64_EXPORT:${reason}`);
}

describe('buildEvidenceExport — fail-closed guards', () => {
  it('rejects a missing production-read confirmation', () => {
    throwsWithReason(() => buildEvidenceExport(validData(), { ...OK_OPTS, confirmProductionRead: false }), 'confirmation_required');
  });

  it('rejects a wrong/non-existent lead (empty result)', () => {
    throwsWithReason(() => buildEvidenceExport({ ...validData(), leads: [] }, OK_OPTS), 'lead_not_found');
  });

  it('rejects when more than one lead is returned', () => {
    const base = validData();
    const data = { ...base, leads: [base.leads[0]!, { ...base.leads[0]!, id: 'lead-other' }] };
    throwsWithReason(() => buildEvidenceExport(data, OK_OPTS), 'multiple_leads');
  });

  it('rejects an expected-domain that is not ku64.de', () => {
    throwsWithReason(() => buildEvidenceExport(validData(), { ...OK_OPTS, expectedDomain: 'notku64.de' }), 'domain_not_allowed');
  });

  it('accepts the www variant of the expected domain', () => {
    expect(() => buildEvidenceExport(validData(), { ...OK_OPTS, expectedDomain: 'https://www.ku64.de/' })).not.toThrow();
  });

  it('rejects when the lead domain does not match the expected domain', () => {
    const base = validData();
    const data = { ...base, leads: [{ ...base.leads[0]!, normalizedDomain: 'someone-else.de', domain: 'someone-else.de' }] };
    throwsWithReason(() => buildEvidenceExport(data, OK_OPTS), 'domain_mismatch');
  });

  it('rejects an unrelated child record (different lead id)', () => {
    const base = validData();
    const data = { ...base, leadFacts: [{ ...base.leadFacts[0]!, leadId: 'lead-other' }, base.leadFacts[1]!] };
    throwsWithReason(() => buildEvidenceExport(data, OK_OPTS), 'unrelated_record');
  });

  it('rejects a dangling audit finding (unknown audit run)', () => {
    const base = validData();
    const data = { ...base, auditFindings: [{ ...base.auditFindings[0]!, auditRunId: 'audit-nope' }] };
    throwsWithReason(() => buildEvidenceExport(data, OK_OPTS), 'unrelated_record');
  });
});

describe('buildEvidenceExport — output shape, exclusions, determinism', () => {
  it('emits only whitelisted source types (no email/gmail/schedule/demo)', () => {
    const doc = buildEvidenceExport(validData(), OK_OPTS);
    const allowed = new Set<string>(KU64_EXPORT_SOURCE_TYPES);
    for (const r of doc.records) expect(allowed.has(r.sourceType)).toBe(true);
    const types = new Set(doc.records.map((r) => r.sourceType));
    for (const banned of ['email', 'gmail', 'schedule', 'send', 'demo', 'deployment']) {
      expect([...types].some((t) => t.includes(banned))).toBe(false);
    }
  });

  it('excludes raw HTML, verbatim bodies, and screenshot data even if present on input rows', () => {
    const base = validData();
    // Simulate leaked raw fields on the input row; the whitelist must drop them.
    const tainted = {
      ...base.evidence[0]!,
      rawEvidence: '<html><body>VERBATIM PAGE BODY</body></html>',
      screenshotPath: '/.artifacts/secret-shot.png',
    } as (typeof base.evidence)[number];
    const doc = buildEvidenceExport({ ...base, evidence: [tainted] }, OK_OPTS);
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('VERBATIM PAGE BODY');
    expect(serialized).not.toContain('rawEvidence');
    expect(serialized).not.toContain('screenshotPath');
    expect(serialized).not.toContain('secret-shot.png');
  });

  it('does not leak an injected secret field into the payload', () => {
    const base = validData();
    const tainted = { ...base.leadFacts[0]!, apiKey: 'sk-SECRET-should-not-appear' } as (typeof base.leadFacts)[number];
    const doc = buildEvidenceExport({ ...base, leadFacts: [tainted, base.leadFacts[1]!] }, OK_OPTS);
    expect(JSON.stringify(doc)).not.toContain('sk-SECRET-should-not-appear');
  });

  it('orders records canonically by (sourceType, recordId)', () => {
    const doc = buildEvidenceExport(validData(), OK_OPTS);
    const keys = doc.records.map((r) => `${r.sourceType} ${r.recordId}`);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('produces a deterministic payload/records hash independent of exportedAt', () => {
    const a = buildEvidenceExport(validData(), { ...OK_OPTS, exportedAt: '2026-01-01T00:00:00.000Z' });
    const b = buildEvidenceExport(validData(), { ...OK_OPTS, exportedAt: '2030-12-31T23:59:59.000Z' });
    expect(a.exportedAt).not.toBe(b.exportedAt);
    expect(a.recordsSha256).toBe(b.recordsSha256);
    expect(a.records.map((r) => r.payloadSha256)).toEqual(b.records.map((r) => r.payloadSha256));
    // exportedAt must never appear inside any hashed payload.
    for (const r of a.records) expect(JSON.stringify(r.payload)).not.toContain('exportedAt');
  });

  it('binds the export to the lead and ku64.de, and reports counts by type', () => {
    const doc = buildEvidenceExport(validData(), OK_OPTS);
    expect(doc.leadId).toBe(LEAD_ID);
    expect(doc.normalizedDomain).toBe('ku64.de');
    const counts = countBySourceType(doc);
    expect(counts.lead).toBe(1);
    expect(counts.lead_fact).toBe(2);
    expect(counts.evidence).toBe(1);
    expect(counts.audit_finding).toBe(1);
    expect(doc.recordCount).toBe(doc.records.length);
  });

  it('folds junction rows into parent payloads', () => {
    const doc = buildEvidenceExport(validData(), OK_OPTS);
    const qr = doc.records.find((r) => r.sourceType === 'qualification_result');
    expect(qr?.payload.supportingLeadFactIds).toEqual(['fact-1']);
    const finding = doc.records.find((r) => r.sourceType === 'audit_finding');
    expect(finding?.payload.evidenceCaptureIds).toEqual(['capev-1']);
  });
});

describe('readOnlyGuard', () => {
  it('throws when any write-capable method is reached', () => {
    const guarded = readOnlyGuard({
      select: () => 'ok',
      insert: () => 'nope',
      update: () => 'nope',
      delete: () => 'nope',
      execute: () => 'nope',
    });
    expect(guarded.select()).toBe('ok');
    expect(() => guarded.insert()).toThrow(Ku64ExportError);
    expect(() => guarded.update()).toThrow(Ku64ExportError);
    expect(() => guarded.delete()).toThrow(Ku64ExportError);
    expect(() => guarded.execute()).toThrow(Ku64ExportError);
  });

  it('refuses mutation of the guarded object', () => {
    const guarded = readOnlyGuard<{ select: () => string; extra?: number }>({ select: () => 'ok' });
    expect(() => {
      guarded.extra = 1;
    }).toThrow(Ku64ExportError);
  });
});

describe('resolveEvidenceOutputPath / assertWithinLocalData', () => {
  const repoRoot = '/repo';

  it('defaults to .local-data/ku64-v2/evidence.json', () => {
    const p = resolveEvidenceOutputPath(repoRoot);
    expect(p.endsWith(path.join('.local-data', 'ku64-v2', 'evidence.json'))).toBe(true);
  });

  it('rejects a path outside .local-data/ku64-v2/', () => {
    throwsWithReason(() => resolveEvidenceOutputPath(repoRoot, '../evil.json'), 'output_path_outside_local_data');
    throwsWithReason(
      () => resolveEvidenceOutputPath(repoRoot, '.local-data/other/evidence.json'),
      'output_path_outside_local_data',
    );
    throwsWithReason(() => assertWithinLocalData(path.resolve(repoRoot, '..', 'passwd'), repoRoot), 'output_path_outside_local_data');
  });

  it('allows a nested file within the allowed directory', () => {
    expect(() => resolveEvidenceOutputPath(repoRoot, '.local-data/ku64-v2/evidence.json')).not.toThrow();
  });
});

describe('Ku64ExportReadRepository — SELECT-only, zero mutation calls', () => {
  it('never invokes insert/update/delete/execute', async () => {
    const mutations: string[] = [];
    const reads: string[] = [];

    class FakeSelect implements PromiseLike<unknown[]> {
      private table: unknown;
      from(table: unknown): this {
        this.table = table;
        return this;
      }
      where(): this {
        return this;
      }
      limit(): this {
        return this;
      }
      then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        const rows = this.table === leadsTable ? [{ id: LEAD_ID, normalizedDomain: 'ku64.de' }] : [];
        return Promise.resolve(rows).then(onfulfilled ?? undefined) as PromiseLike<TResult1 | TResult2>;
      }
    }

    const fakeDb = {
      select: () => {
        reads.push('select');
        return new FakeSelect();
      },
      insert: () => {
        mutations.push('insert');
        return {};
      },
      update: () => {
        mutations.push('update');
        return {};
      },
      delete: () => {
        mutations.push('delete');
        return {};
      },
      execute: () => {
        mutations.push('execute');
        return Promise.resolve([]);
      },
    };

    const repo = new Ku64ExportReadRepository(fakeDb as unknown as DbExecutor);
    const data = await repo.loadLeadExportData(LEAD_ID);

    expect(mutations).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(data.leads).toHaveLength(1);
  });
});
