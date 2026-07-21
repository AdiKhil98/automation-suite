import { describe, expect, it } from 'vitest';
import { SuppressionAdminService, type SuppressionAdminStore, type SuppressionAudit } from '../../src/domain/suppression/admin-service.js';
import { normalizeSuppressionValue, type SuppressionRecord, type SuppressionScope } from '../../src/persistence/repositories/suppression.repo.js';

function fixture() {
  const rows: SuppressionRecord[] = []; const events: unknown[] = [];
  const store: SuppressionAdminStore = { async add(scope, value, reason, createdBy) { rows.push({ id: 'suppression-example', scope, value, reason, createdBy,
      createdAt: new Date('2026-07-21T00:00:00Z'), revokedAt: null, revokedBy: null, revokeReason: null }); return 'suppression-example'; },
    async revoke(id, by, reason, at = new Date()) { const row = rows.find((r) => r.id === id && !r.revokedAt); if (!row) return false;
      row.revokedAt = at; row.revokedBy = by; row.revokeReason = reason; return true; }, async list(scope?: SuppressionScope) { return rows.filter((r) => !scope || r.scope === scope); } };
  const audit: SuppressionAudit = { async record(event) { events.push(event); } };
  return { rows, events, service: new SuppressionAdminService(store, audit, () => new Date('2026-07-21T01:00:00Z')) };
}

describe('suppression administration', () => {
  it('normalizes all existing scopes and rejects malformed values', () => {
    expect(normalizeSuppressionValue('email', ' User@Example.Invalid ')).toBe('user@example.invalid');
    expect(normalizeSuppressionValue('domain', 'https://www.example.invalid/path')).toBe('example.invalid');
    expect(normalizeSuppressionValue('phone', '+1 (555) 010-0000')).toBe('+15550100000');
    expect(normalizeSuppressionValue('place_id', 'place_example')).toBe('place_example');
    expect(() => normalizeSuppressionValue('email', 'not-an-email')).toThrow('invalid_suppression_email');
  });
  it('adds, inspects redacted, revokes, and preserves an audit trail without raw values', async () => {
    const f = fixture(); const raw = 'contact@example.invalid';
    await f.service.add('email', raw, 'fictional objection', 'Example Operator');
    const viewed = await f.service.list(); expect(viewed[0]?.valueHash).not.toContain(raw); expect(viewed[0]?.active).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain(raw);
    expect(await f.service.revoke('suppression-example', 'fictional resolution', 'Example Operator')).toBe(true);
    expect((await f.service.list())[0]?.active).toBe(false); expect(f.events).toHaveLength(2);
  });
  it('rejects duplicate revocation and blank operator evidence', async () => {
    const f = fixture(); await f.service.add('domain', 'example.invalid', 'fictional reason', 'Example Operator');
    await f.service.revoke('suppression-example', 'resolved', 'Example Operator');
    expect(await f.service.revoke('suppression-example', 'again', 'Example Operator')).toBe(false);
    await expect(f.service.add('email', 'contact@example.invalid', '', 'Example Operator')).rejects.toThrow('suppression_reason_required');
  });
});
