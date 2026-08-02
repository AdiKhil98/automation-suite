import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { CompetitorEnrichmentRepository, type EnrichedEmailRecord } from '../../src/persistence/repositories/competitor-enrichment.repo.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { emailClaimLedger, emailCompetitorEnrichment, emailDrafts, leads } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const NOW = new Date('2026-08-03T00:00:00.000Z');

describe('email competitor enrichment persistence (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  function record(emailId: string, leadId: string): EnrichedEmailRecord {
    return {
      emailId, leadId, demoId: null, runId: null,
      subject: 'Booking below the fold', body: 'Hello,\n\nYour booking sits low.\n\nTwo nearby clinics surface a booking action directly on their homepage. That may make booking harder for a first-time visitor to find.\n\nBest regards,',
      ctaKind: 'reply', hasDemoUrlPlaceholder: false,
      writerPromptVersion: 'email-writer-2', reviewerPromptVersion: 'email-reviewer-2',
      schemaVersion: 'email-copy-schema-3', rulesVersion: 'email-copy-standard-2', provider: 'mock',
      requestedWriterModel: 'mock', requestedReviewerModel: 'mock',
      enrichment: {
        competitorEvidenceUsed: 'APPROVED_COMPETITOR_PATTERN_PACKAGE', enrichmentRulesVersion: 'competitor-email-enrichment-2026-08-03',
        packageId: 'pkg1', packageVersion: 1, packageHash: 'hash-a', selectedPatternId: 'p-book', selectedContrastId: null,
        primaryIssueEvidenceId: 'f1', primaryIssueFindingRef: 'F1', alignmentAuditCategory: 'BOOKING_FRICTION',
        alignmentEvidenceCategory: 'BOOKING_CTA_VISIBLE', revalidatedAt: NOW, recomputedHashMatched: true,
        composedMessageHash: 'msg-hash-1',
      },
      ledger: [
        { claimType: 'PROSPECT_OBSERVATION', text: 'Your booking sits low.', prospectEvidenceIds: ['f1'], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true },
        { claimType: 'COMPETITOR_PATTERN', text: 'Two nearby clinics surface a booking action directly on their homepage.', prospectEvidenceIds: [], patternId: 'p-book', contrastId: null, competitorEvidenceIds: ['e1', 'e2'], externallySafe: true },
        { claimType: 'CAUTIOUS_CONSEQUENCE', text: 'That may make booking harder for a first-time visitor to find.', prospectEvidenceIds: [], patternId: 'p-book', contrastId: null, competitorEvidenceIds: [], externallySafe: true },
        { claimType: 'CTA', text: 'cta:REPLY_FOR_DETAILS', prospectEvidenceIds: [], patternId: null, contrastId: null, competitorEvidenceIds: [], externallySafe: true },
      ],
    };
  }

  async function seedLead(): Promise<string> {
    const leadId = randomUUID();
    await handle.db.insert(leads).values({ id: leadId, normalizedDomain: 'prospect.example', status: 'OPPORTUNITY_READY' });
    return leadId;
  }

  it('persists the email draft + enrichment provenance + claim ledger in one call', async () => {
    const leadId = await seedLead();
    const emailId = randomUUID();
    await new CompetitorEnrichmentRepository(handle.db).persistEnrichedEmail(record(emailId, leadId));

    const draftRows = await handle.db.select().from(emailDrafts).where(eq(emailDrafts.id, emailId));
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!.schemaVersion).toBe('email-copy-schema-3');

    const enrichmentRows = await handle.db.select().from(emailCompetitorEnrichment).where(eq(emailCompetitorEnrichment.emailId, emailId));
    expect(enrichmentRows).toHaveLength(1);
    expect(enrichmentRows[0]!.competitorEvidenceUsed).toBe('APPROVED_COMPETITOR_PATTERN_PACKAGE');
    expect(enrichmentRows[0]!.composedMessageHash).toBe('msg-hash-1');

    const ledgerRows = await handle.db.select().from(emailClaimLedger).where(eq(emailClaimLedger.emailId, emailId));
    expect(ledgerRows).toHaveLength(4);
    expect(ledgerRows.map((r) => r.ordinal).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    const competitorClaim = ledgerRows.find((r) => r.claimType === 'COMPETITOR_PATTERN')!;
    expect(competitorClaim.patternId).toBe('p-book');
    expect(competitorClaim.competitorEvidenceIds).toEqual(['e1', 'e2']);
  });

  it('a changed composition is a NEW email id (never a mutation of history)', async () => {
    const leadId = await seedLead();
    const first = randomUUID();
    const second = randomUUID();
    await new CompetitorEnrichmentRepository(handle.db).persistEnrichedEmail(record(first, leadId));
    const changed = record(second, leadId);
    changed.enrichment.composedMessageHash = 'msg-hash-2';
    changed.enrichment.packageVersion = 2;
    await new CompetitorEnrichmentRepository(handle.db).persistEnrichedEmail(changed);

    const all = await handle.db.select().from(emailCompetitorEnrichment).where(eq(emailCompetitorEnrichment.leadId, leadId));
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.composedMessageHash))).toEqual(new Set(['msg-hash-1', 'msg-hash-2']));
  });

  it('rejects an invalid competitor evidence mode via the CHECK constraint', async () => {
    const leadId = await seedLead();
    const emailId = randomUUID();
    const bad = record(emailId, leadId);
    bad.enrichment.competitorEvidenceUsed = 'NAMED';
    await expect(new CompetitorEnrichmentRepository(handle.db).persistEnrichedEmail(bad)).rejects.toThrow();
  });
});
