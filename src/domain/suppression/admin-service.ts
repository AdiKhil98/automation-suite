import { sha256Hex } from '../../utils/hash.js';
import { normalizeSuppressionValue, type SuppressionRecord, type SuppressionScope } from '../../persistence/repositories/suppression.repo.js';

export interface SuppressionAdminStore {
  add(scope: SuppressionScope, value: string, reason: string, createdBy: string): Promise<string>;
  revoke(id: string, by: string, reason: string, at?: Date): Promise<boolean>;
  list(scope?: SuppressionScope): Promise<SuppressionRecord[]>;
}
export interface SuppressionAudit { record(event: { leadId: null; runId: null; type: 'NOTE'; fromStatus: null; toStatus: null; message: string; data: unknown }): Promise<void> }
export interface RedactedSuppression { id: string; scope: SuppressionScope; valueHash: string; active: boolean; createdAt: Date; revokedAt: Date | null }

/** Audited suppression administration. Raw identity values never enter audit events or output views. */
export class SuppressionAdminService {
  constructor(private readonly store: SuppressionAdminStore, private readonly audit: SuppressionAudit, private readonly now: () => Date = () => new Date()) {}

  previewHash(scope: SuppressionScope, value: string): string { return sha256Hex(`${scope}|${normalizeSuppressionValue(scope, value)}`); }

  async add(scope: SuppressionScope, value: string, reason: string, by: string): Promise<string> {
    requireText(reason, 'suppression_reason_required'); requireText(by, 'operator_required');
    const normalized = normalizeSuppressionValue(scope, value); const valueHash = this.previewHash(scope, normalized);
    const id = await this.store.add(scope, normalized, reason.trim(), by.trim());
    await this.audit.record({ leadId: null, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
      message: 'suppression: ADDED', data: { suppressionId: id, scope, valueHash } });
    return id;
  }

  async revoke(id: string, reason: string, by: string): Promise<boolean> {
    requireText(id, 'suppression_id_required'); requireText(reason, 'revoke_reason_required'); requireText(by, 'operator_required');
    const changed = await this.store.revoke(id.trim(), by.trim(), reason.trim(), this.now());
    if (changed) await this.audit.record({ leadId: null, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
      message: 'suppression: REVOKED', data: { suppressionId: id.trim() } });
    return changed;
  }

  async list(scope?: SuppressionScope): Promise<RedactedSuppression[]> {
    return (await this.store.list(scope)).map((r) => ({ id: r.id, scope: r.scope,
      valueHash: this.previewHash(r.scope, r.value), active: r.revokedAt === null, createdAt: r.createdAt, revokedAt: r.revokedAt }));
  }
}

function requireText(value: string, error: string): void { if (!value.trim()) throw new Error(error); }
