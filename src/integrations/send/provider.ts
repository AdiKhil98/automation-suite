/** Narrow Phase 14 boundary: profile, one known draft, and that draft's send operation only. */
export interface ProviderDraftEnvelope {
  fromName: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachmentCount: number;
}

export interface SendRef {
  providerMessageId: string;
  providerThreadId: string | null;
}

/** `rate_limited`/`transient` are allowed only for a confirmed non-delivery response. Timeouts,
 * lost/malformed responses, 5xx, and any ambiguity after dispatch MUST be `unknown`. */
export type SendResultOutcome = 'ok' | 'rate_limited' | 'transient' | 'auth_error' | 'unknown';
export interface SendResult { outcome: SendResultOutcome; ref?: SendRef; reason?: string }

export type DraftInspectionResult =
  | { outcome: 'ok'; envelope: ProviderDraftEnvelope }
  | { outcome: 'missing' | 'auth_error' | 'invalid' | 'unknown'; reason: string };

export interface SendProvider {
  readonly name: string;
  readonly live: boolean;
  verifyAccount(expectedEmail: string): Promise<{ ok: boolean; email: string | null; reason?: string }>;
  /** Read only the already-known draft id. Never list/search drafts or access the inbox. */
  getKnownDraft(providerDraftId: string): Promise<DraftInspectionResult>;
  /** Dispatch exactly the existing draft id. No MIME/raw or replacement message is accepted. */
  sendExistingDraft(providerDraftId: string): Promise<SendResult>;
}
