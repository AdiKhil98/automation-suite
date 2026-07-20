import { type DraftInspectionResult, type SendProvider, type SendResult } from './provider.js';

export interface MockSendScript {
  account?: { ok: boolean; email: string | null; reason?: string };
  draft?: DraftInspectionResult;
  send?: SendResult;
}

/** Deterministic zero-network provider. It never contacts Gmail or any host. */
export class MockSendProvider implements SendProvider {
  readonly name = 'mock-send';
  readonly live = false;
  readonly verified: string[] = [];
  readonly inspected: string[] = [];
  readonly sent: string[] = [];

  constructor(private readonly script: MockSendScript = {}) {}

  async verifyAccount(expectedEmail: string): Promise<{ ok: boolean; email: string | null; reason?: string }> {
    this.verified.push(expectedEmail);
    return this.script.account ?? { ok: true, email: expectedEmail };
  }

  async getKnownDraft(providerDraftId: string): Promise<DraftInspectionResult> {
    this.inspected.push(providerDraftId);
    return this.script.draft ?? { outcome: 'missing', reason: 'mock_draft_not_scripted' };
  }

  async sendExistingDraft(providerDraftId: string): Promise<SendResult> {
    this.sent.push(providerDraftId);
    if (this.script.send) return this.script.send;
    return { outcome: 'ok', ref: { providerMessageId: 'mock-message-id', providerThreadId: 'mock-thread-id' } };
  }
}
