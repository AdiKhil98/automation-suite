import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  type ContactResolution,
  type IntendedDecisionMaker,
  type NewContactResolution,
  type PersistedContactResolutionType,
} from '../../domain/contact-resolution/resolution.js';
import { type DbExecutor } from '../db.js';
import { contactResolutions } from '../schema.js';

type Row = typeof contactResolutions.$inferSelect;

function toDomain(row: Row): ContactResolution {
  return {
    id: row.id,
    leadId: row.leadId,
    resolutionType: row.resolutionType as PersistedContactResolutionType,
    recipientEmail: row.recipientEmail,
    sourceFactId: row.sourceFactId,
    enrichmentResultId: row.enrichmentResultId,
    sourceUrl: row.sourceUrl,
    intendedDecisionMakers: (row.intendedDecisionMakers ?? []) as IntendedDecisionMaker[],
    resolvedAt: row.resolvedAt,
    isCurrent: row.isCurrent,
  };
}

/**
 * Persistence for terminal contact resolutions — the recipient contract downstream email generation
 * consumes. This repo never writes lead_facts: a GENERIC_OFFICIAL resolution POINTS AT the existing
 * `contact_email` fact through `sourceFactId` rather than duplicating or superseding it, so the fact
 * store stays the single authoritative record of the address itself.
 *
 * UNRESOLVED is never stored. It is the absence of a current row, which is why `getCurrent` returning
 * null is the correct and only representation of "no usable recipient".
 */
export class ContactResolutionRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * Supersede any current resolution and insert the new one. Must run inside a transaction: the
   * partial unique index permits at most one current row per lead, so the demote and the insert have
   * to land together.
   */
  async writeCurrentResolution(resolution: NewContactResolution): Promise<string> {
    const id = randomUUID();
    await this.db
      .update(contactResolutions)
      .set({ isCurrent: false })
      .where(and(eq(contactResolutions.leadId, resolution.leadId), eq(contactResolutions.isCurrent, true)));

    await this.db.insert(contactResolutions).values({
      id,
      leadId: resolution.leadId,
      resolutionType: resolution.resolutionType,
      recipientEmail: resolution.recipientEmail,
      sourceFactId: resolution.sourceFactId ?? null,
      enrichmentResultId: resolution.enrichmentResultId ?? null,
      sourceUrl: resolution.sourceUrl ?? null,
      // A named list on a PERSONAL_VERIFIED row is rejected by contact_resolutions_intended_ck; the
      // person there IS the recipient and needs no forwarding request.
      intendedDecisionMakers: resolution.resolutionType === 'GENERIC_OFFICIAL' ? (resolution.intendedDecisionMakers ?? []) : [],
      isCurrent: true,
    });
    return id;
  }

  /** The lead's current resolution, or null when it is UNRESOLVED. */
  async getCurrent(leadId: string): Promise<ContactResolution | null> {
    const rows = await this.db
      .select()
      .from(contactResolutions)
      .where(and(eq(contactResolutions.leadId, leadId), eq(contactResolutions.isCurrent, true)))
      .limit(1);
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  /** Full history for a lead (newest first), including superseded rows. For audit/review only. */
  async listByLead(leadId: string): Promise<ContactResolution[]> {
    const rows = await this.db.select().from(contactResolutions).where(eq(contactResolutions.leadId, leadId));
    return rows.map(toDomain).sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime());
  }
}
