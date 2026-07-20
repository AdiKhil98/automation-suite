import { SendService, type SendConfig } from '../../domain/send/send-service.js';
import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { HttpGmailSendProvider } from '../../integrations/send/http-gmail-send.js';
import { MockSendProvider, type MockSendScript } from '../../integrations/send/mock-send.js';
import { type SendProvider } from '../../integrations/send/provider.js';
import { DrizzleSendUnitOfWork } from '../../persistence/send-unit-of-work.js';
import { SendRepository } from '../../persistence/repositories/send.repo.js';
import { type CliContext } from '../context.js';

/**
 * Select the Phase 15 sending provider. Mock remains the default and performs zero network I/O.
 * HTTP construction reuses the existing stored OAuth grant; it never starts authorization and does
 * not fetch a token until an explicitly gated provider operation is invoked.
 */
export function buildSendProvider(ctx: CliContext, mockScript: MockSendScript = {}): SendProvider {
  const c = ctx.config;
  if (c.SENDING_PROVIDER === 'mock') return new MockSendProvider(mockScript);
  const client = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE,
    envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  const store = new LocalGmailTokenStore(c.GMAIL_CREDENTIALS_FILE);
  if (!client || !store.exists() || !c.GMAIL_ACCOUNT_EMAIL) {
    throw new Error('HTTP Gmail sending is not credential-ready; existing client, stored credentials, and configured account are required. OAuth authorization was not started.');
  }
  const oauth = new GoogleOAuthClient({ clientId: client.clientId, clientSecret: client.clientSecret,
    redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  return new HttpGmailSendProvider({ tokens: new OAuthAccessTokenProvider(oauth, store), timeoutMs: c.GMAIL_TIMEOUT_MS });
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
    dailyCap: c.SENDING_DAILY_CAP,
  };
}

/** Build the controlled-sending service (mock provider by default; all kill switches respected). */
export function buildSendService(ctx: CliContext, provider = buildSendProvider(ctx)): SendService {
  return new SendService({
    provider,
    store: new SendRepository(ctx.db),
    uow: new DrizzleSendUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: buildSendConfig(ctx.config),
  });
}
