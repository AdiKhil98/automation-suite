import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { type Lead } from '../../domain/leads/lead.js';
import { type DbExecutor } from '../db.js';
import { suppressionList } from '../schema.js';

export type SuppressionScope = 'domain' | 'phone' | 'place_id' | 'email';
export interface SuppressionRecord { id: string; scope: SuppressionScope; value: string; reason: string | null; createdBy: string; createdAt: Date; revokedAt: Date | null; revokedBy: string | null; revokeReason: string | null }

/**
 * Read-only suppression gate for qualification (full sending-time enforcement is
 * Phase 12+). A lead is suppressed if any of its identity keys is listed.
 */
export class SuppressionRepository {
  constructor(private readonly db: DbExecutor) {}

  async add(scope: SuppressionScope, value: string, reason: string, createdBy = 'system'): Promise<string> {
    const id = randomUUID();
    await this.db.insert(suppressionList).values({ id, scope, value: normalizeSuppressionValue(scope, value), reason, createdBy });
    return id;
  }

  async revoke(id: string, by: string, reason: string, at = new Date()): Promise<boolean> {
    const rows = await this.db.update(suppressionList).set({ revokedAt: at, revokedBy: by, revokeReason: reason })
      .where(and(eq(suppressionList.id, id), isNull(suppressionList.revokedAt))).returning({ id: suppressionList.id });
    return rows.length === 1;
  }

  async list(scope?: SuppressionScope): Promise<SuppressionRecord[]> {
    const rows = await this.db.select().from(suppressionList)
      .where(scope ? eq(suppressionList.scope, scope) : undefined).orderBy(asc(suppressionList.createdAt));
    return rows.map((row) => ({ ...row, scope: row.scope as SuppressionScope }));
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
        .where(and(eq(suppressionList.scope, scope), inArray(suppressionList.value, values), isNull(suppressionList.revokedAt)))
        .limit(1);
      if (rows.length > 0) return true;
    }
    return false;
  }

  async isEmailSuppressed(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(and(eq(suppressionList.scope, 'email'), eq(suppressionList.value, normalizeSuppressionValue('email', email)), isNull(suppressionList.revokedAt)))
      .limit(1);
    return rows.length > 0;
  }
}

export function normalizeSuppressionValue(scope: SuppressionScope, input: string): string {
  const value = input.trim();
  if (!value) throw new Error('suppression_value_required');
  if (scope === 'email') {
    const email = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid_suppression_email');
    return email;
  }
  if (scope === 'domain') {
    const domain = value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('invalid_suppression_domain');
    return domain;
  }
  if (scope === 'phone') {
    const phone = value.replace(/[\s().-]/g, '');
    if (!/^\+?[0-9]{7,20}$/.test(phone)) throw new Error('invalid_suppression_phone');
    return phone;
  }
  if (!/^[A-Za-z0-9_-]{3,256}$/.test(value)) throw new Error('invalid_suppression_place_id');
  return value;
}
