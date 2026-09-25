import { describe, expect, it } from 'vitest';
import {
  type AuditPersist,
  type ModelCallRecord,
} from '../../src/domain/audit/audit-service.js';
import {
  type AcceptedFinding,
  type FindingReview,
  type OverallReviewDecision,
} from '../../src/domain/audit/audit-types.js';
import { type DbExecutor } from '../../src/persistence/db.js';
import { AuditRepository } from '../../src/persistence/repositories/audit.repo.js';
import { auditFindings, auditReviewFindings, auditReviews } from '../../src/persistence/schema.js';

/**
 * REVIEWER VERDICT OBSERVABILITY.
 *
 * The repository used to write `audit_reviews` only when the reviewer had returned at least one
 * finding-level decision, and it hardcoded `overall_decision = 'APPROVE_WITH_REVISIONS'` for every
 * row it did write. Two consequences, both of which made the stored verdict untrustworthy:
 *
 *  1. A real APPROVE was read back as APPROVE_WITH_REVISIONS — the audit trail asserted revisions
 *     that the reviewer never asked for.
 *  2. A REJECT / MANUAL_REVIEW that accepted nothing left NO review row at all, so the run that
 *     most needs explaining is the one with no reviewer record.
 *
 * The verdict now comes from the reviewer itself and the row's existence tracks whether a reviewer
 * call actually happened — never invented when it did not.
 */

interface Insert {
  table: unknown;
  rows: unknown[];
}

/** The minimal executor surface `AuditRepository.persist` uses: `insert(table).values(rows)`. */
function fakeDb(): { db: DbExecutor; inserts: Insert[] } {
  const inserts: Insert[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as DbExecutor, inserts };
}

function rowsFor(inserts: Insert[], table: unknown): Record<string, unknown>[] {
  return inserts.filter((i) => i.table === table).flatMap((i) => i.rows as Record<string, unknown>[]);
}

const review = (decision: FindingReview['decision'] = 'APPROVE'): FindingReview => ({
  findingRef: 'F1',
  decision,
  evidenceSupported: true,
  impactSupported: true,
  safeForOutreach: true,
  problems: [],
  revisedObservation: null,
  revisedBusinessImpact: null,
  revisedRecommendation: null,
  revisedOutreachAngle: null,
});

const finding = (): AcceptedFinding => ({
  id: 'finding-1',
  findingRef: 'F1',
  category: 'CTA_CLARITY',
  observation: 'The main action may be hard to notice.',
  evidenceIds: ['ev-1'],
  affectedUrls: ['https://example.test/'],
  affectedProfiles: ['DESKTOP'],
  severity: 'MEDIUM',
  confidence: 0.8,
  businessImpact: 'May create friction for interested visitors.',
  recommendation: 'Make the primary action more prominent.',
  safeForOutreach: true,
  outreachAngle: null,
  uncertainty: null,
  reviewDecision: 'APPROVE',
});

function persistRecord(over: Partial<AuditPersist> = {}): AuditPersist {
  const now = new Date('2026-09-25T00:00:00.000Z');
  return {
    auditRun: {
      id: 'run-1',
      leadId: 'lead-1',
      runId: 'pipeline-1',
      captureRunId: 'capture-1',
      outcome: 'AUDITED',
      rubricVersion: 'r1',
      generatorPromptVersion: 'g1',
      reviewerPromptVersion: 'v1',
      schemaVersion: 's1',
      opportunityRulesVersion: 'o1',
      opportunityRulesHash: 'hash',
      provider: 'mock',
      requestedAuditModel: 'm',
      resolvedAuditModel: 'm',
      reasoningEffort: 'medium',
      reasoningMode: 'standard',
      imageDetail: 'low',
      responseStore: false,
      inputFingerprint: 'fp',
      generatorResponseId: null,
      reviewerResponseId: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      startedAt: now,
      completedAt: now,
    },
    accepted: [],
    reviews: [],
    reviewOverallDecision: null,
    opportunity: null,
    modelCalls: [] as ModelCallRecord[],
    ...over,
  };
}

async function persisted(over: Partial<AuditPersist>): Promise<Insert[]> {
  const { db, inserts } = fakeDb();
  await new AuditRepository(db).persist(persistRecord(over));
  return inserts;
}

describe('AuditRepository reviewer persistence', () => {
  it.each<[OverallReviewDecision]>([['APPROVE'], ['APPROVE_WITH_REVISIONS']])(
    'persists the reviewer\'s own verdict %s when findings were accepted',
    async (decision) => {
      const inserts = await persisted({
        accepted: [finding()],
        reviews: [review()],
        reviewOverallDecision: decision,
      });
      const reviews = rowsFor(inserts, auditReviews);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.overallDecision).toBe(decision);
      // Finding-level decisions stay linked to that review row.
      const reviewFindings = rowsFor(inserts, auditReviewFindings);
      expect(reviewFindings).toHaveLength(1);
      expect(reviewFindings[0]?.auditReviewId).toBe(reviews[0]?.id);
      expect(reviewFindings[0]?.findingRef).toBe('F1');
    },
  );

  it.each<[OverallReviewDecision]>([['REJECT'], ['MANUAL_REVIEW']])(
    'still records a %s verdict when no audit finding was persisted',
    async (decision) => {
      const inserts = await persisted({
        auditRun: { ...persistRecord().auditRun, outcome: 'MANUAL_REVIEW_REQUIRED' },
        accepted: [],
        reviews: [review('REJECT')],
        reviewOverallDecision: decision,
      });
      expect(rowsFor(inserts, auditFindings)).toHaveLength(0);
      const reviews = rowsFor(inserts, auditReviews);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.overallDecision).toBe(decision);
      expect(rowsFor(inserts, auditReviewFindings)).toHaveLength(1);
    },
  );

  it('records the verdict even when the reviewer returned no finding-level decisions', async () => {
    const inserts = await persisted({ reviews: [], reviewOverallDecision: 'REJECT' });
    const reviews = rowsFor(inserts, auditReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.overallDecision).toBe('REJECT');
    expect(rowsFor(inserts, auditReviewFindings)).toHaveLength(0);
  });

  it('writes no review row when no reviewer call produced a verdict', async () => {
    const inserts = await persisted({ reviews: [], reviewOverallDecision: null });
    expect(rowsFor(inserts, auditReviews)).toHaveLength(0);
    expect(rowsFor(inserts, auditReviewFindings)).toHaveLength(0);
  });

  it('records UNKNOWN rather than inventing a verdict for a pre-existing recovery envelope', async () => {
    const legacy = persistRecord({ accepted: [finding()], reviews: [review()] }) as unknown as Record<string, unknown>;
    delete legacy.reviewOverallDecision; // envelope written before the verdict was carried
    const { db, inserts } = fakeDb();
    await new AuditRepository(db).persist(legacy as unknown as AuditPersist);
    const reviews = rowsFor(inserts, auditReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.overallDecision).toBe('UNKNOWN');
    expect(rowsFor(inserts, auditReviewFindings)).toHaveLength(1);
  });
});
