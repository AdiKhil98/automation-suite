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

/** Non-`ok` results are honest provider classifications. Timeouts, network loss, malformed success,
 * 5xx, and any ambiguity after dispatch MUST be `unknown`, never an automatic retry signal. */
export type SendResultOutcome = 'ok' | 'definitive_failure' | 'rate_limited' | 'auth_error' | 'unknown';
export interface SendResult { outcome: SendResultOutcome; ref?: SendRef; reason?: string }

export type DraftInspectionResult =
  | { outcome: 'ok'; envelope: ProviderDraftEnvelope; providerDraftId?: string; providerMessageId?: string; providerThreadId?: string | null }
  | { outcome: 'missing' | 'auth_error' | 'rate_limited' | 'definitive_failure' | 'invalid' | 'unknown'; reason: string };

export interface SendProvider {
  readonly name: string;
  readonly live: boolean;
  verifyAccount(expectedEmail: string): Promise<{ ok: boolean; email: string | null; reason?: string }>;
  /** Read only the already-known draft id. Never list/search drafts or access the inbox. */
  getKnownDraft(providerDraftId: string): Promise<DraftInspectionResult>;
  /** Dispatch exactly the existing draft id. No MIME/raw or replacement message is accepted. */
  sendExistingDraft(providerDraftId: string): Promise<SendResult>;
}
