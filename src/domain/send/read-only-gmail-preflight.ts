import { type ReadOnlyGmailVerifier } from '../../integrations/send/provider.js';
import { compareProviderEnvelope, expectedDraftEnvelope, providerEnvelopeHash } from './envelope.js';
import { type SendInput } from './send-service.js';

export interface GmailPreflightResult { ok: boolean; outcome: string; envelopeHash?: string }

/** External read-only verification of one persisted known draft. It has no store and cannot mutate state. */
export class ReadOnlyGmailPreflightService {
  constructor(private readonly verifier: ReadOnlyGmailVerifier,
    private readonly config: { gmailAccount: string; senderName: string | null }) {}

  async verify(input: SendInput): Promise<GmailPreflightResult> {
    const draft = input.currentGmailDraft;
    if (!draft?.providerDraftId || !draft.providerMessageId || !draft.providerThreadId || !input.currentRecipientEmail ||
        !input.subject || !input.finalization || !this.config.senderName) return { ok: false, outcome: 'local_binding_incomplete' };
    let expected;
    try { expected = expectedDraftEnvelope({ senderName: this.config.senderName, senderEmail: draft.senderEmail,
      recipientEmail: input.currentRecipientEmail, subject: input.subject, resolvedBody: input.finalization.resolvedBody, replyTo: null }); }
    catch { return { ok: false, outcome: 'approved_envelope_invalid' }; }
    const account = await this.verifier.verifyAccount(this.config.gmailAccount);
    if (!account.ok || account.email?.trim().toLowerCase() !== this.config.gmailAccount.trim().toLowerCase()) {
      return { ok: false, outcome: 'authenticated_account_mismatch' };
    }
    const inspected = await this.verifier.getKnownDraft(draft.providerDraftId);
    if (inspected.outcome !== 'ok') return { ok: false, outcome: `known_draft_${inspected.outcome}` };
    if (inspected.providerDraftId !== undefined && inspected.providerDraftId !== draft.providerDraftId) return { ok: false, outcome: 'draft_identity_changed' };
    if (inspected.providerMessageId !== draft.providerMessageId || inspected.providerThreadId !== draft.providerThreadId) return { ok: false, outcome: 'message_identity_changed' };
    const problems = compareProviderEnvelope(expected, inspected.envelope);
    if (problems.length > 0) return { ok: false, outcome: problems.join(',') };
    return { ok: true, outcome: 'verified', envelopeHash: providerEnvelopeHash(inspected.envelope) };
  }
}
