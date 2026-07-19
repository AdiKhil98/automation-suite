/**
 * Phase 12 Gmail draft boundary. Provider-agnostic; Google-specific HTTP never crosses this
 * line. The ONLY mutating operation is creating a DRAFT (users.drafts.create) — never send,
 * never read/modify/archive the inbox, never contact discovery. The OAuth access token lives
 * only inside the HTTP adapter and is never returned, logged, or persisted.
 */

export interface CreateDraftRequest {
  /** RFC 5322 message, base64url-encoded (the Gmail `message.raw`). */
  rawBase64Url: string;
  /** Our idempotency fingerprint (informational; duplicate prevention is enforced in our DB). */
  idempotencyFingerprint: string;
}

export interface GmailDraftRef {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

export type GmailOutcome = 'ok' | 'rate_limited' | 'transient' | 'auth_error' | 'invalid';

export interface GmailResult {
  outcome: GmailOutcome;
  ref?: GmailDraftRef;
  reason?: string;
}

export interface AccountVerification {
  ok: boolean;
  /** The authorized account email if the API/scope allows reading it, else null. */
  email: string | null;
  reason?: string;
}

export interface GmailDraftProvider {
  readonly name: string;
  /** Create a DRAFT only. */
  createDraft(req: CreateDraftRequest): Promise<GmailResult>;
  /** Best-effort check that the token's account matches the expected email. Under the
   * compose-only scope the profile may be unreadable → { ok:false, email:null }. */
  verifyAccount(expectedEmail: string): Promise<AccountVerification>;
}
