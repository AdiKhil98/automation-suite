import { desc, eq } from 'drizzle-orm';
import { type Lead, type LeadPriority } from '../../domain/leads/lead.js';
import { type LeadStore } from '../../domain/leads/lead-service.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { type Database } from '../db.js';
import { leads } from '../schema.js';

type LeadRow = typeof leads.$inferSelect;

function toDomain(row: LeadRow): Lead {
  return {
    id: row.id,
    businessName: row.businessName,
    normalizedName: row.normalizedName,
    domain: row.domain,
    normalizedDomain: row.normalizedDomain,
    placeId: row.placeId,
    city: row.city,
    country: row.country,
    status: row.status as LeadStatus,
    priority: (row.priority as LeadPriority | null) ?? null,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class LeadsRepository implements LeadStore {
  constructor(private readonly db: Database) {}

  async create(lead: Lead): Promise<void> {
    await this.db.insert(leads).values({
      id: lead.id,
      businessName: lead.businessName,
      normalizedName: lead.normalizedName,
      domain: lead.domain,
      normalizedDomain: lead.normalizedDomain,
      placeId: lead.placeId,
      city: lead.city,
      country: lead.country,
      status: lead.status,
      priority: lead.priority,
      source: lead.source,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    });
  }

  async getById(id: string): Promise<Lead | null> {
    const rows = await this.db.select().from(leads).where(eq(leads.id, id)).limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async updateStatus(id: string, status: LeadStatus, updatedAt: Date): Promise<void> {
    await this.db.update(leads).set({ status, updatedAt }).where(eq(leads.id, id));
  }

  async list(limit = 100): Promise<Lead[]> {
    const rows = await this.db.select().from(leads).orderBy(desc(leads.createdAt)).limit(limit);
    return rows.map(toDomain);
  }
}
