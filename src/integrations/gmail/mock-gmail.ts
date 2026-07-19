import {
  type AccountVerification,
  type CreateDraftRequest,
  type GmailDraftProvider,
  type GmailResult,
} from './provider.js';

export interface MockGmailScript {
  create?: GmailResult;
  verify?: AccountVerification;
}

/**
 * Deterministic Gmail provider for tests + mock runs. Zero network. A script controls the
 * create/verify outcomes so the whole state machine (ok, rate-limited, transient, auth error,
 * account mismatch) can be exercised without touching Gmail. Records every create request.
 */
export class MockGmailDraftProvider implements GmailDraftProvider {
  readonly name = 'mock-gmail';
  readonly created: CreateDraftRequest[] = [];

  constructor(private readonly account: string, private readonly script: MockGmailScript = {}) {}

  async createDraft(req: CreateDraftRequest): Promise<GmailResult> {
    this.created.push(req);
    if (this.script.create) return this.script.create;
    const id = `mock-draft-${req.idempotencyFingerprint.slice(0, 16)}`;
    return { outcome: 'ok', ref: { draftId: id, messageId: `mock-msg-${req.idempotencyFingerprint.slice(0, 12)}`, threadId: `mock-thread-${req.idempotencyFingerprint.slice(0, 12)}` } };
  }

  async verifyAccount(expectedEmail: string): Promise<AccountVerification> {
    if (this.script.verify) return this.script.verify;
    return { ok: this.account === expectedEmail, email: this.account };
  }
}
