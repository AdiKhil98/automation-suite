import { GmailDraftService } from '../../domain/gmail/gmail-service.js';
import { OAuthAccessTokenProvider } from '../../integrations/gmail/access-token.js';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { HttpGmailDraftProvider } from '../../integrations/gmail/http-gmail.js';
import { MockGmailDraftProvider } from '../../integrations/gmail/mock-gmail.js';
import { type GmailDraftProvider } from '../../integrations/gmail/provider.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { DrizzleGmailUnitOfWork } from '../../persistence/gmail-unit-of-work.js';
import { GmailRepository } from '../../persistence/repositories/gmail.repo.js';
import { type CliContext } from '../context.js';

export interface BuiltGmail {
  service: GmailDraftService;
  providerName: string;
  live: boolean;
}

/**
 * Build the Gmail draft service. A REAL Gmail draft requires GMAIL_DRAFTS_ENABLED=true AND
 * OUTBOUND_ACTIONS_ENABLED=true AND
 * OAuth client id/secret AND a stored refresh token (run `gmail-auth`) AND GMAIL_ACCOUNT_EMAIL
 * AND GMAIL_SENDER_NAME. Otherwise the mock provider is used (no network). Only drafts.create
 * is ever called; the token is never logged or persisted.
 */
export function buildGmailService(ctx: CliContext): BuiltGmail {
  const c = ctx.config;
  const store = new LocalGmailTokenStore(c.GMAIL_CREDENTIALS_FILE);
  const clientCreds = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  const credentialsConfigured = !!clientCreds && !!c.GMAIL_ACCOUNT_EMAIL && !!c.GMAIL_SENDER_NAME && store.exists();
  const live = c.GMAIL_DRAFTS_ENABLED && c.OUTBOUND_ACTIONS_ENABLED && credentialsConfigured;

  let provider: GmailDraftProvider;
  if (live && clientCreds) {
    const oauth = new GoogleOAuthClient({ clientId: clientCreds.clientId, clientSecret: clientCreds.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
    provider = new HttpGmailDraftProvider({ tokens: new OAuthAccessTokenProvider(oauth, store), logger: ctx.logger, timeoutMs: c.GMAIL_TIMEOUT_MS });
  } else {
    provider = new MockGmailDraftProvider(c.GMAIL_ACCOUNT_EMAIL ?? 'mock@example.com');
  }

  const service = new GmailDraftService({
    provider,
    store: new GmailRepository(ctx.db),
    uow: new DrizzleGmailUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: {
      gmailAccount: c.GMAIL_ACCOUNT_EMAIL ?? 'mock@example.com',
      senderName: c.GMAIL_SENDER_NAME ?? null,
      featureEnabled: c.GMAIL_DRAFTS_ENABLED,
      outboundActionsEnabled: c.OUTBOUND_ACTIONS_ENABLED,
      credentialsConfigured,
      maxPerDay: c.GMAIL_MAX_DRAFTS_PER_DAY,
      minIntervalMs: c.GMAIL_MIN_DRAFT_INTERVAL_MS,
    },
  });
  return { service, providerName: provider.name, live };
}
