import { randomUUID } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  type FactSourceType,
  type FactType,
  type LeadFact,
  type NewLeadFact,
} from '../../domain/lead-facts/lead-fact.js';
import { type TxLeadFactStore } from '../../pipeline/ports.js';
import { type DbExecutor } from '../db.js';
import { leadFacts } from '../schema.js';

type Row = typeof leadFacts.$inferSelect;

function toDomain(row: Row): LeadFact {
  return {
    id: row.id,
    leadId: row.leadId,
    factType: row.factType as FactType,
    value: row.value,
    normalizedValue: row.normalizedValue,
    sourceType: row.sourceType as FactSourceType,
    sourceUrl: row.sourceUrl,
    capturedAt: row.capturedAt,
    confidence: row.confidence,
    supersededBy: row.supersededBy,
    supersededAt: row.supersededAt,
    isCurrent: row.isCurrent,
  };
}

/**
 * Fact store with supersession. `writeCurrentFact` must run inside a transaction:
 * it demotes the prior current fact, inserts the new one, and links supersession —
 * the partial unique index guarantees at most one current fact per (lead, type).
 */
export class LeadFactsRepository implements TxLeadFactStore {
  constructor(private readonly db: DbExecutor) {}

  async writeCurrentFact(fact: NewLeadFact): Promise<string> {
    const id = randomUUID();
    const now = fact.capturedAt ?? new Date();

    await this.db
      .update(leadFacts)
      .set({ isCurrent: false, supersededAt: now })
      .where(
        and(
          eq(leadFacts.leadId, fact.leadId),
          eq(leadFacts.factType, fact.factType),
          eq(leadFacts.isCurrent, true),
        ),
      );

    await this.db.insert(leadFacts).values({
      id,
      leadId: fact.leadId,
      factType: fact.factType,
      value: fact.value,
      normalizedValue: fact.normalizedValue,
      sourceType: fact.sourceType,
      sourceUrl: fact.sourceUrl,
      capturedAt: now,
      confidence: fact.confidence ?? 1,
      isCurrent: true,
    });

    await this.db
      .update(leadFacts)
      .set({ supersededBy: id })
      .where(
        and(
          eq(leadFacts.leadId, fact.leadId),
          eq(leadFacts.factType, fact.factType),
          eq(leadFacts.isCurrent, false),
          isNull(leadFacts.supersededBy),
          ne(leadFacts.id, id),
        ),
      );

    return id;
  }

  async listCurrentFacts(leadId: string): Promise<LeadFact[]> {
    const rows = await this.db
      .select()
      .from(leadFacts)
      .where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.isCurrent, true)));
    return rows.map(toDomain);
  }

  async getCurrentFact(leadId: string, factType: FactType): Promise<LeadFact | null> {
    const rows = await this.db
      .select()
      .from(leadFacts)
      .where(
        and(
          eq(leadFacts.leadId, leadId),
          eq(leadFacts.factType, factType),
          eq(leadFacts.isCurrent, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }
}
