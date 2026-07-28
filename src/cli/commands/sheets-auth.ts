import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadGmailClientCredentials } from '../../integrations/gmail/client-config.js';
import { GoogleOAuthClient } from '../../integrations/gmail/oauth.js';
import { LocalGmailTokenStore } from '../../integrations/gmail/token-store.js';
import { GOOGLE_SHEETS_SCOPE } from '../../integrations/google/sheets/http-sheets.js';
import { type CliContext } from '../context.js';

/**
 * Phase 17A3 one-time local OAuth setup for the Google Sheets OPERATOR PROJECTION writer. It grants
 * ONLY the minimum Sheets scope (`spreadsheets`) and stores the resulting refresh token in a SEPARATE
 * git-ignored 0600 file (GOOGLE_SHEETS_CREDENTIALS_FILE), entirely distinct from every Gmail
 * credential — no Gmail credential is read or written. It reuses the existing installed-app loopback
 * OAuth pattern (same Google Cloud OAuth client), differing only in scope and stored file. Run once,
 * then `outreach-sync-sheet --confirm-sheet-write` (with GOOGLE_SHEETS_PROVIDER=http +
 * GOOGLE_SHEETS_SYNC_ENABLED=true + a spreadsheet id) can write the projection.
 */
export async function sheetsAuthCommand(ctx: CliContext): Promise<void> {
  const c = ctx.config;
  const clientCreds = loadGmailClientCredentials({ clientFile: c.GMAIL_OAUTH_CLIENT_FILE, envClientId: c.GMAIL_OAUTH_CLIENT_ID, envClientSecret: c.GMAIL_OAUTH_CLIENT_SECRET });
  if (!clientCreds) {
    console.log(`No OAuth client credentials found. Save the downloaded Google Cloud "Desktop app" JSON to ${c.GMAIL_OAUTH_CLIENT_FILE} (or set GMAIL_OAUTH_CLIENT_ID/SECRET).`);
    return;
  }

  const oauth = new GoogleOAuthClient({ clientId: clientCreds.clientId, clientSecret: clientCreds.clientSecret, redirectUri: c.GMAIL_OAUTH_REDIRECT_URI, timeoutMs: c.GMAIL_TIMEOUT_MS });
  const store = new LocalGmailTokenStore(c.GOOGLE_SHEETS_CREDENTIALS_FILE);
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
          await store.save({ refreshToken: tok.refreshToken, accountEmail: c.GMAIL_ACCOUNT_EMAIL ?? null, scope: GOOGLE_SHEETS_SCOPE, obtainedAt: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Authorized (Google Sheets, write-scope for the operator projection). Refresh token stored locally. You can close this tab.');
          server.close(() => resolveDone());
        })
        .catch((err: unknown) => {
          res.writeHead(500); res.end('Authorization failed.');
          server.close(() => rejectDone(err instanceof Error ? err : new Error(String(err))));
        });
    });
    server.listen(c.GMAIL_OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`\nGoogle Sheets authorization (scope: ${GOOGLE_SHEETS_SCOPE} ONLY — write the operator projection; no Gmail access).`);
      console.log('\nOpen this URL in your browser, sign in, and approve:\n');
      console.log(oauth.authUrl(state, GOOGLE_SHEETS_SCOPE));
      console.log(`\nWaiting for the callback on ${c.GMAIL_OAUTH_REDIRECT_URI} ...`);
    });
    server.on('error', rejectDone);
  });

  console.log(`\nAuthorized (Sheets). Refresh token saved (0600) to ${c.GOOGLE_SHEETS_CREDENTIALS_FILE} (git-ignored).`);
  console.log('This credential can ONLY access Google Sheets. A live write additionally requires GOOGLE_SHEETS_PROVIDER=http, GOOGLE_SHEETS_SYNC_ENABLED=true, a spreadsheet id, and --confirm-sheet-write.');
}
