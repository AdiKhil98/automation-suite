import { and, desc, eq, or, type SQL } from 'drizzle-orm';
import { type DedupCandidate, type DedupInput } from '../../domain/leads/dedup.js';
import { type DedupStatus, type Lead, type LeadPriority } from '../../domain/leads/lead.js';
import { type TxLeadStore } from '../../pipeline/ports.js';
import { type LeadStore } from '../../domain/leads/lead-service.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { type DbExecutor } from '../db.js';
import { leads } from '../schema.js';

type LeadRow = typeof leads.$inferSelect;

function toDomain(row: LeadRow): Lead {
  return {
    id: row.id,
    businessName: row.businessName,
    normalizedName: row.normalizedName,
    domain: row.domain,
    normalizedDomain: row.normalizedDomain,
    phone: row.phone,
    normalizedPhone: row.normalizedPhone,
    formattedAddress: row.formattedAddress,
    normalizedAddress: row.normalizedAddress,
    latitude: row.latitude,
    longitude: row.longitude,
    placeId: row.placeId,
    city: row.city,
    country: row.country,
    status: row.status as LeadStatus,
    priority: (row.priority as LeadPriority | null) ?? null,
    source: row.source,
    dedupStatus: row.dedupStatus as DedupStatus,
    duplicateOf: row.duplicateOf,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class LeadsRepository implements LeadStore, TxLeadStore {
  constructor(private readonly db: DbExecutor) {}

  async create(lead: Lead): Promise<void> {
    await this.db.insert(leads).values(lead);
  }

  async getById(id: string): Promise<Lead | null> {
    const rows = await this.db.select().from(leads).where(eq(leads.id, id)).limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void> {
    await this.db.update(leads).set({ status, updatedAt }).where(eq(leads.id, id));
  }

  async setDedupStatus(id: string, status: DedupStatus, duplicateOf: string | null): Promise<void> {
    await this.db.update(leads).set({ dedupStatus: status, duplicateOf }).where(eq(leads.id, id));
  }

  /** Refresh denormalized projection columns (derived from current facts). */
  async updateProjection(
    id: string,
    patch: Partial<
      Pick<Lead, 'domain' | 'normalizedDomain' | 'phone' | 'normalizedPhone' | 'formattedAddress' | 'normalizedAddress'>
    >,
  ): Promise<void> {
    await this.db.update(leads).set({ ...patch, updatedAt: new Date() }).where(eq(leads.id, id));
  }

  async list(limit = 100): Promise<Lead[]> {
    const rows = await this.db.select().from(leads).orderBy(desc(leads.createdAt)).limit(limit);
    return rows.map(toDomain);
  }

  /**
   * Candidate leads that share a strong identifier (domain / phone / name) with the
   * input. The dedup engine then applies address-anchored precedence to decide.
   */
  async findDedupCandidates(input: DedupInput): Promise<DedupCandidate[]> {
    const conditions: SQL[] = [];
    if (input.normalizedDomain) conditions.push(eq(leads.normalizedDomain, input.normalizedDomain));
    if (input.normalizedPhone) conditions.push(eq(leads.normalizedPhone, input.normalizedPhone));
    if (input.normalizedName) conditions.push(eq(leads.normalizedName, input.normalizedName));
    if (conditions.length === 0) return [];

    const rows = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.dedupStatus, 'UNIQUE'), or(...conditions)))
      .limit(50);

    return rows.map((row) => ({
      leadId: row.id,
      normalizedName: row.normalizedName,
      normalizedDomain: row.normalizedDomain,
      normalizedPhone: row.normalizedPhone,
      normalizedAddress: row.normalizedAddress,
      latitude: row.latitude,
      longitude: row.longitude,
      city: row.city,
    }));
  }
}
