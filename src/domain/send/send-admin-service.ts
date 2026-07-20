export type ReconciliationOutcome = 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT';
export type ReconciliationSelection = ReconciliationOutcome | 'UNRESOLVED';

export interface ReadinessStatus {
  id: string;
  policyVersion: string;
  approvedBy: string;
  approvedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface AttemptStatusView {
  id: string;
  leadId: string;
  status: string;
  errorClass: string | null;
  reservedAt: Date;
  callStartedAt: Date | null;
  completedAt: Date | null;
  reconciledOutcome: string | null;
  reconciledBy: string | null;
  reconciledAt: Date | null;
  reconciliationNote: string | null;
}

export interface SendAdminStore {
  createReadiness(input: { gmailAccount: string; policyVersion: string; approvedBy: string; approvedAt: Date; expiresAt: Date }): Promise<ReadinessStatus>;
  revokeReadiness(input: { id: string; revokedBy: string; reason: string; revokedAt: Date }): Promise<boolean>;
  latestReadiness(gmailAccount: string, policyVersion: string): Promise<ReadinessStatus | null>;
  listAttempts(leadId?: string): Promise<AttemptStatusView[]>;
  reconcile(input: { attemptId: string; outcome: ReconciliationOutcome; reconciledBy: string; note: string;
    reconciledAt: Date; gmailAccount: string; policyVersion: string }): Promise<'SENT_CONFIRMED' | 'DEFINITIVE_FAILURE'>;
  recordUnresolved(input: { attemptId: string; reconciledBy: string; note: string; reconciledAt: Date }): Promise<void>;
}

export class SendAdminService {
  constructor(private readonly store: SendAdminStore, private readonly config: { gmailAccount: string | null; policyVersion: string }, private readonly now: () => number = Date.now) {}

  async createReadiness(input: { approvedBy: string; expiresInMinutes: number }): Promise<ReadinessStatus> {
    const gmailAccount = this.config.gmailAccount?.trim().toLowerCase();
    if (!gmailAccount) throw new Error('configured_gmail_account_required');
    const approvedBy = requiredText(input.approvedBy, 'approved_by', 120);
    if (!Number.isInteger(input.expiresInMinutes) || input.expiresInMinutes < 1 || input.expiresInMinutes > 60) throw new Error('readiness_expiry_must_be_1_to_60_minutes');
    const approvedAt = new Date(this.now());
    return this.store.createReadiness({ gmailAccount, policyVersion: this.config.policyVersion,
      approvedBy, approvedAt, expiresAt: new Date(approvedAt.getTime() + input.expiresInMinutes * 60_000) });
  }

  revokeReadiness(input: { id: string; revokedBy: string; reason: string }): Promise<boolean> {
    return this.store.revokeReadiness({ id: requiredId(input.id), revokedBy: requiredText(input.revokedBy, 'revoked_by', 120),
      reason: requiredText(input.reason, 'revoke_reason', 500), revokedAt: new Date(this.now()) });
  }

  status(): Promise<ReadinessStatus | null> {
    const account = this.config.gmailAccount?.trim().toLowerCase();
    if (!account) throw new Error('configured_gmail_account_required');
    return this.store.latestReadiness(account, this.config.policyVersion);
  }

  attempts(leadId?: string): Promise<AttemptStatusView[]> {
    return this.store.listAttempts(leadId ? requiredId(leadId) : undefined);
  }

  reconciliationPhrase(attemptId: string, outcome: ReconciliationSelection): string {
    return `RECONCILE ${requiredId(attemptId)} ${outcome}`;
  }

  async reconcile(input: { attemptId: string; outcome: ReconciliationSelection; reconciledBy: string; note: string; observedPhrase: string }): Promise<'SENT_CONFIRMED' | 'DEFINITIVE_FAILURE' | 'UNCHANGED'> {
    const attemptId = requiredId(input.attemptId);
    if (!['CONFIRMED_SENT', 'CONFIRMED_NOT_SENT', 'UNRESOLVED'].includes(input.outcome)) throw new Error('invalid_reconciliation_outcome');
    if (input.observedPhrase !== this.reconciliationPhrase(attemptId, input.outcome)) throw new Error('reconciliation_confirmation_mismatch');
    const common = { attemptId, reconciledBy: requiredText(input.reconciledBy, 'reconciled_by', 120),
      note: requiredText(input.note, 'reconciliation_note', 1000), reconciledAt: new Date(this.now()) };
    if (input.outcome === 'UNRESOLVED') { await this.store.recordUnresolved(common); return 'UNCHANGED'; }
    const gmailAccount = this.config.gmailAccount?.trim().toLowerCase();
    if (!gmailAccount) throw new Error('configured_gmail_account_required');
    return this.store.reconcile({ ...common, outcome: input.outcome, gmailAccount,
      policyVersion: this.config.policyVersion });
  }
}

function requiredId(value: string): string {
  const v = value.trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(v)) throw new Error('invalid_identifier');
  return v;
}
function requiredText(value: string, field: string, max: number): string {
  const v = value.trim();
  if (!v || v.length > max || /[\r\n]/.test(v)) throw new Error(`invalid_${field}`);
  return v;
}
