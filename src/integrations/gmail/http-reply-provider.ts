import { request as httpsRequest } from 'node:https';
import { type Logger } from 'pino';
import { type InboundMessage } from '../../domain/outreach/reply-classification.js';
import { safePreview } from '../../domain/outreach/reply-classification.js';
import { type AccessTokenProvider } from './oauth.js';
import { GMAIL_READONLY_SCOPE } from './oauth.js';
import { type GmailTokenStore } from './token-store.js';
import { type GmailThreadReader } from './reply-provider.js';

/** Fixed Gmail API origin — never configurable. */
const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';

/** The ONLY headers we request (metadata format). No full body is ever downloaded. */
const METADATA_HEADERS = ['From', 'Date', 'Content-Type', 'Auto-Submitted', 'List-Unsubscribe'] as const;

interface HttpJson {
  status: number;
  json: Record<string, unknown> | null;
}

/**
 * Injectable GET function so the provider is unit-testable without a network. Implementations
 * MUST perform a read-only GET and nothing else. `path` always begins with `/gmail/v1/`.
 */
export type GmailHttpGet = (path: string, token: string, timeoutMs: number) => Promise<HttpJson>;

/** Result of the one-time read-only access precondition check. */
export interface ReadAccessCheck {
  ok: boolean;
  reason?: string;
}

/**
 * The two-gate fail-closed decision for LIVE Gmail reading: BOTH GMAIL_REPLY_SYNC_ENABLED=true
 * and the explicit --confirm-gmail-read flag are required. Pure and side-effect-free so the guard
 * is unit-testable without a database or network. `allowed:false` carries the exact reason.
 */
export function liveReplyReadGate(opts: { syncEnabled: boolean; confirmed: boolean }): ReadAccessCheck {
  if (!opts.syncEnabled) return { ok: false, reason: 'GMAIL_REPLY_SYNC_ENABLED=false — refusing any live Gmail read.' };
  if (!opts.confirmed) return { ok: false, reason: 'missing --confirm-gmail-read — refusing any live Gmail read.' };
  return { ok: true };
}

interface GmailHeader {
  name?: unknown;
  value?: unknown;
}

interface GmailMessage {
  id?: unknown;
  threadId?: unknown;
  internalDate?: unknown;
  snippet?: unknown;
  payload?: { headers?: unknown } | undefined;
}

/** Extract a bare email address from an RFC 5322 `From` header value. */
function extractEmail(fromHeader: string): string {
  const angle = /<([^>]+)>/.exec(fromHeader);
  const raw = (angle?.[1] ?? fromHeader).trim();
  return raw.toLowerCase();
}

function headerMap(headers: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(headers)) return map;
  for (const h of headers as GmailHeader[]) {
    if (typeof h.name === 'string' && typeof h.value === 'string') {
      map.set(h.name.toLowerCase(), h.value);
    }
  }
  return map;
}

/**
 * Phase 17A2 REAL, STRICTLY READ-ONLY Gmail thread reader. It issues exactly ONE kind of HTTP
 * request — `GET /gmail/v1/users/me/threads/{knownThreadId}?format=metadata` — for a thread id
 * that already belongs to a tracked outreach record. There is, by construction, NO send, draft,
 * label, archive, trash, modify, or mailbox-wide list/search method on this class. `format=metadata`
 * means message bodies are never fetched; only the requested headers plus Gmail's own short
 * `snippet` (stored as a truncated preview) are read. The OAuth access token is minted per call
 * from the readonly credential and used only as a Bearer header — never logged or persisted.
 *
 * It refuses to operate unless the stored credential's scope is EXACTLY the read-only scope
 * (`verifyReadAccess`), so a compose/send credential can never be used here. A missing or
 * inaccessible thread yields an empty array (fail-closed: no reply is ever inferred from an error).
 */
export class HttpGmailThreadReader implements GmailThreadReader {
  readonly name = 'http-gmail-readonly';
  readonly readsExternally = true;
  private readonly httpGet: GmailHttpGet;

  constructor(
    private readonly deps: {
      tokens: AccessTokenProvider;
      store: GmailTokenStore;
      logger: Logger;
      timeoutMs: number;
      httpGet?: GmailHttpGet;
    },
  ) {
    this.httpGet = deps.httpGet ?? defaultHttpGet;
  }

  /**
   * One-time precondition: confirm a readonly credential exists and its stored scope is EXACTLY
   * the read-only scope (no write/compose/send scope present). Fail-closed and loud — the CLI
   * refuses to run any read when this is not ok, rather than silently degrading.
   */
  async verifyReadAccess(): Promise<ReadAccessCheck> {
    const cred = await this.deps.store.load();
    if (!cred) {
      return { ok: false, reason: 'no readonly Gmail credential — run `pnpm cli gmail-read-auth` first' };
    }
    const scopes = cred.scope.split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GMAIL_READONLY_SCOPE) {
      return { ok: false, reason: `stored scope is not strictly read-only (${cred.scope}); expected exactly ${GMAIL_READONLY_SCOPE}` };
    }
    return { ok: true };
  }

  /**
   * Read one thread by id. Oldest-first. Never mutates anything. A non-2xx status, missing
   * thread, or malformed payload returns [] (fail-closed). The thread id is path-encoded; there
   * is no query search and no `q=` parameter anywhere.
   */
  async readThread(threadId: string): Promise<InboundMessage[]> {
    if (!threadId) return [];
    const token = await this.deps.tokens.getAccessToken(); // short-lived; never logged
    const params = new URLSearchParams({ format: 'metadata' });
    for (const h of METADATA_HEADERS) params.append('metadataHeaders', h);
    const path = `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?${params.toString()}`;

    let res: HttpJson;
    try {
      res = await this.httpGet(path, token, this.deps.timeoutMs);
    } catch (err) {
      this.deps.logger.warn({ threadId, err: err instanceof Error ? err.message : String(err) }, 'gmail thread read failed (fail-closed)');
      return [];
    }
    if (res.status < 200 || res.status >= 300 || !res.json) {
      this.deps.logger.warn({ threadId, status: res.status }, 'gmail thread read non-ok (fail-closed)');
      return [];
    }

    const messages = Array.isArray(res.json.messages) ? (res.json.messages as GmailMessage[]) : [];
    const mapped: InboundMessage[] = [];
    for (const m of messages) {
      if (typeof m.id !== 'string' || typeof m.internalDate !== 'string') continue;
      const headers = headerMap(m.payload?.headers);
      const fromEmail = extractEmail(headers.get('from') ?? '');
      if (!fromEmail) continue;
      const receivedAtMs = Number(m.internalDate);
      if (!Number.isFinite(receivedAtMs)) continue;
      mapped.push({
        messageId: m.id,
        threadId: typeof m.threadId === 'string' ? m.threadId : threadId,
        fromEmail,
        receivedAtMs,
        preview: safePreview(typeof m.snippet === 'string' ? m.snippet : ''),
        headers: {
          fromEmail,
          autoSubmitted: headers.get('auto-submitted') ?? null,
          contentType: headers.get('content-type') ?? null,
          hasListUnsubscribe: headers.has('list-unsubscribe'),
        },
      });
    }
    return mapped.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  }
}

/** Real read-only GET against the Gmail API. NOT exercised by the standard test suite. */
const defaultHttpGet: GmailHttpGet = (path, token, timeoutMs) =>
  new Promise((resolve, reject) => {
    const url = new URL(GMAIL_API_ORIGIN + path);
    const req = httpsRequest(url, { method: 'GET', timeout: timeoutMs, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null;
        try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('gmail request timeout')));
    req.on('error', reject);
    req.end();
  });
