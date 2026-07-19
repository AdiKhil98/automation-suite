import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GMAIL_COMPOSE_SCOPE, GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { type CliContext } from '../context.js';

/**
 * One-time local OAuth setup: authorize this machine to CREATE Gmail drafts (gmail.compose
 * scope ONLY) and store the resulting refresh token in a git-ignored 0600 file. Loopback
 * callback on 127.0.0.1. Never sends email; never reads the inbox. Run once, then
 * `create-gmail-drafts` can mint access tokens automatically.
 */
export async function gmailAuthCommand(ctx: CliContext): Promise<void> {
  const c = ctx.config;
  const clientCreds = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  if (!clientCreds) {
    console.log(`No OAuth client credentials found. Save the downloaded Google Cloud "Desktop app" JSON to ${c.GMAIL_OAUTH_CLIENT_FILE} (or set GMAIL_OAUTH_CLIENT_ID/SECRET).`);
    return;
  }
  if (!c.GMAIL_ACCOUNT_EMAIL) { console.log('Missing GMAIL_ACCOUNT_EMAIL. Set it in .env before running gmail-auth.'); return; }

  const oauth = new GoogleOAuthClient({ clientId: clientCreds.clientId, clientSecret: clientCreds.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const store = new LocalGmailTokenStore(c.GMAIL_CREDENTIALS_FILE);
  const state = randomBytes(16).toString('hex');
  const callbackPath = new URL(c.GMAIL_OAUTH_REDIRECT_URI).pathname;

  await new Promise<void>((resolveDone, rejectDone) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(c.GMAIL_OAUTH_CALLBACK_PORT)}`);
      if (url.pathname !== callbackPath) { res.writeHead(404); res.end('not found'); return; }
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      if (!code || gotState !== state) { res.writeHead(400); res.end('Invalid OAuth callback (state mismatch or missing code).'); return; }
      oauth.exchangeCode(code)
        .then(async (tok) => {
          if (!tok.refreshToken) throw new Error('No refresh token returned — ensure prompt=consent + access_type=offline and that this is the first authorization.');
          await store.save({ refreshToken: tok.refreshToken, accountEmail: c.GMAIL_ACCOUNT_EMAIL ?? null, scope: GMAIL_COMPOSE_SCOPE, obtainedAt: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Authorized. Refresh token stored locally. You can close this tab.');
          server.close(() => resolveDone());
        })
        .catch((err: unknown) => {
          res.writeHead(500); res.end('Authorization failed.');
          server.close(() => rejectDone(err instanceof Error ? err : new Error(String(err))));
        });
    });
    server.listen(c.GMAIL_OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      console.log('\nGmail authorization (scope: gmail.compose ONLY — create drafts, never send/read).');
      console.log(`Account to authorize: ${c.GMAIL_ACCOUNT_EMAIL ?? '(set GMAIL_ACCOUNT_EMAIL)'}`);
      console.log('\nOpen this URL in your browser, sign in, and approve:\n');
      console.log(oauth.authUrl(state));
      console.log(`\nWaiting for the callback on ${c.GMAIL_OAUTH_REDIRECT_URI} ...`);
    });
    server.on('error', rejectDone);
  });

  console.log(`\nAuthorized. Refresh token saved (0600) to ${c.GMAIL_CREDENTIALS_FILE} (git-ignored).`);
  console.log('The draft command will verify the authorized Gmail profile matches GMAIL_ACCOUNT_EMAIL before creating any draft.');
}
