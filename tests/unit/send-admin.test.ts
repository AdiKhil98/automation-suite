import { describe, expect, it } from 'vitest';
import { SendAdminService, type ReadinessStatus, type SendAdminStore } from '../../src/domain/send/send-admin-service.js';

const NOW = Date.parse('2026-07-20T12:00:00Z');
const ACCOUNT = 'sender@example.invalid';

function fakeStore(overrides: Partial<SendAdminStore> = {}): SendAdminStore {
  return {
    async createReadiness(input) { return { id: 'readiness-example', policyVersion: input.policyVersion,
      approvedBy: input.approvedBy, approvedAt: input.approvedAt, expiresAt: input.expiresAt,
      revokedAt: null, revokedBy: null, revokeReason: null }; },
    async revokeReadiness() { return true; }, async latestReadiness() { return null; },
    async listAttempts() { return []; }, async reconcile(input) { return input.outcome === 'CONFIRMED_SENT' ? 'SENT_CONFIRMED' : 'DEFINITIVE_FAILURE'; },
    async recordUnresolved() { /* audited by the persistence implementation */ },
    ...overrides,
  };
}

describe('SendAdminService', () => {
  it('creates a bounded expiring readiness approval and rejects unsafe expiry', async () => {
    const store = fakeStore({ async createReadiness(input) {
      const captured: ReadinessStatus = { id: 'readiness-example', policyVersion: input.policyVersion, approvedBy: input.approvedBy,
        approvedAt: input.approvedAt, expiresAt: input.expiresAt, revokedAt: null, revokedBy: null, revokeReason: null };
      return captured;
    } });
    const service = new SendAdminService(store, { gmailAccount: ACCOUNT, policyVersion: 'send-policy-1' }, () => NOW);
    const created = await service.createReadiness({ approvedBy: 'Example Operator', expiresInMinutes: 15 });
    expect(created.expiresAt.getTime()).toBe(NOW + 15 * 60_000);
    await expect(service.createReadiness({ approvedBy: 'Example Operator', expiresInMinutes: 61 })).rejects.toThrow('readiness_expiry');
  });

  it('requires explicit nonempty reconciliation evidence and delegates only supported outcomes', async () => {
    const service = new SendAdminService(fakeStore(), { gmailAccount: ACCOUNT, policyVersion: 'send-policy-1' }, () => NOW);
    await expect(service.reconcile({ attemptId: 'attempt-example', outcome: 'CONFIRMED_SENT',
      reconciledBy: 'Example Operator', note: '', observedPhrase: 'RECONCILE attempt-example CONFIRMED_SENT' })).rejects.toThrow('reconciliation_note');
    expect(await service.reconcile({ attemptId: 'attempt-example', outcome: 'CONFIRMED_NOT_SENT',
      reconciledBy: 'Example Operator', note: 'Provider evidence confirmed no delivery.',
      observedPhrase: 'RECONCILE attempt-example CONFIRMED_NOT_SENT' })).toBe('DEFINITIVE_FAILURE');
  });

  it('keeps unresolved outcomes unchanged and rejects an incorrect confirmation phrase', async () => {
    let unresolved = 0; let changed = 0;
    const service = new SendAdminService(fakeStore({ async recordUnresolved() { unresolved += 1; },
      async reconcile() { changed += 1; return 'SENT_CONFIRMED'; } }),
    { gmailAccount: ACCOUNT, policyVersion: 'send-policy-1' }, () => NOW);
    await expect(service.reconcile({ attemptId: 'attempt-example', outcome: 'CONFIRMED_SENT',
      reconciledBy: 'Example Operator', note: 'Evidence reference.', observedPhrase: 'wrong' })).rejects.toThrow('confirmation_mismatch');
    expect(await service.reconcile({ attemptId: 'attempt-example', outcome: 'UNRESOLVED',
      reconciledBy: 'Example Operator', note: 'Evidence remains inconclusive.',
      observedPhrase: 'RECONCILE attempt-example UNRESOLVED' })).toBe('UNCHANGED');
    expect(unresolved).toBe(1); expect(changed).toBe(0);
  });
});
