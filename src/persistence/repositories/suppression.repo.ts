import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { type Lead } from '../../domain/leads/lead.js';
import { type DbExecutor } from '../db.js';
import { suppressionList } from '../schema.js';

export type SuppressionScope = 'domain' | 'phone' | 'place_id' | 'email';

/**
 * Read-only suppression gate for qualification (full sending-time enforcement is
 * Phase 12+). A lead is suppressed if any of its identity keys is listed.
 */
export class SuppressionRepository {
  constructor(private readonly db: DbExecutor) {}

  async add(scope: SuppressionScope, value: string, reason?: string): Promise<void> {
    await this.db.insert(suppressionList).values({ id: randomUUID(), scope, value, reason: reason ?? null });
  }

  async isSuppressed(lead: Pick<Lead, 'normalizedDomain' | 'normalizedPhone' | 'placeId'>): Promise<boolean> {
    const checks: Array<{ scope: SuppressionScope; value: string }> = [];
    if (lead.normalizedDomain) checks.push({ scope: 'domain', value: lead.normalizedDomain });
    if (lead.normalizedPhone) checks.push({ scope: 'phone', value: lead.normalizedPhone });
    if (lead.placeId) checks.push({ scope: 'place_id', value: lead.placeId });
    if (checks.length === 0) return false;

    for (const scope of ['domain', 'phone', 'place_id'] as const) {
      const values = checks.filter((c) => c.scope === scope).map((c) => c.value);
      if (values.length === 0) continue;
      const rows = await this.db
        .select({ id: suppressionList.id })
        .from(suppressionList)
        .where(and(eq(suppressionList.scope, scope), inArray(suppressionList.value, values)))
        .limit(1);
      if (rows.length > 0) return true;
    }
    return false;
  }

  async isEmailSuppressed(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(and(eq(suppressionList.scope, 'email'), eq(suppressionList.value, email.trim().toLowerCase())))
      .limit(1);
    return rows.length > 0;
  }
}
