import { SendService, type SendConfig } from '../../domain/send/send-service.js';
import { MockSendProvider, type MockSendScript } from '../../integrations/send/mock-send.js';
import { type SendProvider } from '../../integrations/send/provider.js';
import { DrizzleSendUnitOfWork } from '../../persistence/send-unit-of-work.js';
import { SendRepository } from '../../persistence/repositories/send.repo.js';
import { type CliContext } from '../context.js';

/**
 * Select the sending provider. Phase 14 is MOCK-FIRST: no live adapter is implemented, so a real
 * send is structurally impossible. Selecting the live provider is refused until a later, separately
 * approved step wires and hardens it. The mock provider performs zero network I/O.
 */
export function buildSendProvider(c: CliContext['config'], mockScript: MockSendScript = {}): SendProvider {
  if (c.SENDING_PROVIDER === 'http') {
    throw new Error('Live sending provider (SENDING_PROVIDER=http) is not implemented; Phase 14 is mock-first. Keep SENDING_PROVIDER=mock.');
  }
  return new MockSendProvider(mockScript);
}

export function buildSendConfig(c: CliContext['config']): SendConfig {
  return {
    gmailAccount: c.GMAIL_ACCOUNT_EMAIL ?? 'mock@example.com',
    senderName: c.GMAIL_SENDER_NAME ?? null,
    policyVersion: c.SENDING_POLICY_VERSION,
    sendingEnabled: c.SENDING_ENABLED,
    outboundActionsEnabled: c.OUTBOUND_ACTIONS_ENABLED,
    dryRun: c.DRY_RUN,
    maxLateMs: c.SENDING_MAX_LATE_MINUTES * 60_000,
    confirmationTtlMs: c.SENDING_CONFIRMATION_TTL_SECONDS * 1000,
  };
}

/** Build the controlled-sending service (mock provider by default; all kill switches respected). */
export function buildSendService(ctx: CliContext, provider = buildSendProvider(ctx.config)): SendService {
  return new SendService({
    provider,
    store: new SendRepository(ctx.db),
    uow: new DrizzleSendUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: buildSendConfig(ctx.config),
  });
}
