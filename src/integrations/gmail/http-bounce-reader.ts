import { request as httpsRequest } from 'node:https';
import { type Logger } from 'pino';
import { type RawDeliveryNotification, type TrackedOutbound } from '../../domain/outreach/delivery.js';
import { normalizeEmail } from '../../domain/outreach/reply-classification.js';
import { type AccessTokenProvider, GMAIL_READONLY_SCOPE } from './oauth.js';
import { type GmailBounceReader } from './bounce-reader.js';
import { type GmailHttpGet, type ReadAccessCheck } from './http-reply-provider.js';
import { type GmailTokenStore } from './token-store.js';

/** Fixed Gmail API origin — never configurable. */
const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';

/** Bounded number of candidate DSNs a single reconciliation will inspect. */
const MAX_CANDIDATES = 50;

interface GmailHeader { name?: unknown; value?: unknown }
interface GmailPart {
  mimeType?: unknown;
  headers?: unknown;
  body?: { data?: unknown } | undefined;
  parts?: unknown;
}
interface GmailFullMessage {
  id?: unknown;
  threadId?: unknown;
  internalDate?: unknown;
  snippet?: unknown;
  payload?: GmailPart | undefined;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  for (const h of headers as GmailHeader[]) {
    if (typeof h.name === 'string' && h.name.toLowerCase() === name.toLowerCase() && typeof h.value === 'string') {
      return h.value;
    }
  }
  return null;
}

function extractEmail(fromHeader: string | null): string {
  if (!fromHeader) return '';
  const angle = /<([^>]+)>/.exec(fromHeader);
  return normalizeEmail((angle?.[1] ?? fromHeader).trim());
}

/** Collect every RFC 5322 Message-ID token (`<...>`) from a header string. */
function messageIdTokens(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^>]+>/g)].map((m) => m[0]);
}

function decodePartData(data: unknown): string {
  if (typeof data !== 'string' || !data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** Depth-first walk of a Gmail payload tree, yielding every part. */
function walkParts(part: GmailPart | undefined, out: GmailPart[]): void {
  if (!part) return;
  out.push(part);
  if (Array.isArray(part.parts)) {
    for (const p of part.parts as GmailPart[]) walkParts(p, out);
  }
}

/**
 * Phase 17C REAL, STRICTLY READ-ONLY Gmail bounce reader. It performs only GETs: a single
 * bounded `messages.list` scoped to delivery-notification markers AND the tracked recipients
 * (so the search is connected to tracked outbounds and can find DSNs even in a SEPARATE
 * thread), followed by one `messages.get?format=full` per candidate to parse the standard
 * `multipart/report` / `message/delivery-status` structure. There is, by construction, NO
 * send, draft, label, archive, trash, or modify method on this class. It refuses to operate
 * unless the stored credential's scope is EXACTLY the read-only scope. Any error yields an
 * empty result (fail-closed: no bounce is ever inferred from an error). The standard test
 * suite never exercises this class (mock reader only).
 */
export class HttpGmailBounceReader implements GmailBounceReader {
  readonly name = 'http-gmail-readonly-bounce';
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

  /** Same fail-closed precondition as the reply reader: scope must be EXACTLY read-only. */
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

  async findDeliveryNotifications(input: { outbounds: readonly TrackedOutbound[] }): Promise<RawDeliveryNotification[]> {
    const recipients = [...new Set(input.outbounds.map((o) => normalizeEmail(o.contactEmail)).filter(Boolean))];
    // Nothing tracked to connect a DSN to → do not search the mailbox at all.
    if (recipients.length === 0) return [];

    const q = this.buildScopedQuery(recipients);
    const ids = await this.listCandidateIds(q);
    const out: RawDeliveryNotification[] = [];
    for (const id of ids) {
      const parsed = await this.fetchNotification(id);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * A scoped Gmail search: delivery-notification markers AND at least one tracked recipient.
   * This is the ONLY search this codebase issues, and it exists solely to find DSNs connected
   * to tracked outbounds (correlation + fail-closed filtering still happen in the domain).
   */
  private buildScopedQuery(recipients: readonly string[]): string {
    const markers = '(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" OR subject:"Mail Delivery Subsystem" OR subject:"Undelivered")';
    const recipientClause = `(${recipients.map((r) => `"${r}"`).join(' OR ')})`;
    return `${markers} ${recipientClause}`;
  }

  private async listCandidateIds(q: string): Promise<string[]> {
    const params = new URLSearchParams({ q, maxResults: String(MAX_CANDIDATES) });
    const path = `/gmail/v1/users/me/messages?${params.toString()}`;
    let res;
    try {
      res = await this.httpGet(path, await this.deps.tokens.getAccessToken(), this.deps.timeoutMs);
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'gmail bounce search failed (fail-closed)');
      return [];
    }
    if (res.status < 200 || res.status >= 300 || !res.json) return [];
    const messages = Array.isArray(res.json.messages) ? res.json.messages : [];
    const ids: string[] = [];
    for (const m of messages as { id?: unknown }[]) {
      if (typeof m.id === 'string') ids.push(m.id);
    }
    return ids;
  }

  private async fetchNotification(id: string): Promise<RawDeliveryNotification | null> {
    const params = new URLSearchParams({ format: 'full' });
    const path = `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`;
    let res;
    try {
      res = await this.httpGet(path, await this.deps.tokens.getAccessToken(), this.deps.timeoutMs);
    } catch (err) {
      this.deps.logger.warn({ id, err: err instanceof Error ? err.message : String(err) }, 'gmail bounce fetch failed (fail-closed)');
      return null;
    }
    if (res.status < 200 || res.status >= 300 || !res.json) return null;
    return this.mapMessage(res.json as GmailFullMessage);
  }

  /** Map a full Gmail message into the raw DSN boundary shape (headers + delivery-status). */
  private mapMessage(msg: GmailFullMessage): RawDeliveryNotification | null {
    if (typeof msg.id !== 'string') return null;
    const topHeaders = msg.payload?.headers;
    const parts: GmailPart[] = [];
    walkParts(msg.payload, parts);

    const from = extractEmail(headerValue(topHeaders, 'From'));
    const subject = headerValue(topHeaders, 'Subject') ?? '';
    const contentType = headerValue(topHeaders, 'Content-Type');
    const xFailed = headerValue(topHeaders, 'X-Failed-Recipients');

    const referenced = new Set<string>();
    for (const t of messageIdTokens(headerValue(topHeaders, 'References'))) referenced.add(t);
    for (const t of messageIdTokens(headerValue(topHeaders, 'In-Reply-To'))) referenced.add(t);
    // Some providers surface the failed message's id directly on the DSN.
    for (const name of ['Original-Message-ID', 'X-Original-Message-ID']) {
      for (const t of messageIdTokens(headerValue(topHeaders, name))) referenced.add(t);
    }

    let deliveryStatusText: string | null = null;
    let textPlainBody: string | null = null;
    for (const p of parts) {
      const mime = typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : '';
      if (mime === 'message/delivery-status') {
        deliveryStatusText = decodePartData(p.body?.data) || deliveryStatusText;
      }
      if (mime === 'text/plain' && textPlainBody === null) {
        textPlainBody = decodePartData(p.body?.data) || null;
      }
      // The embedded original (message/rfc822) carries the outbound's own Message-ID.
      if (mime === 'message/rfc822' || mime === 'text/rfc822-headers') {
        const embedded = decodePartData(p.body?.data);
        for (const line of embedded.split(/\r?\n/)) {
          const m = /^(?:x-)?(?:original-)?message-id\s*:\s*(.+)$/i.exec(line.trim());
          if (m?.[1]) for (const t of messageIdTokens(m[1])) referenced.add(t);
        }
        for (const t of messageIdTokens(headerValue(p.headers, 'Message-ID'))) referenced.add(t);
      }
    }
    // Fallback: when no structured delivery-status part is present, use the text/plain body
    // so the domain's free-text parse can still recover the status/diagnostic code.
    if (!deliveryStatusText && textPlainBody) deliveryStatusText = textPlainBody;

    const internalDate = typeof msg.internalDate === 'string' ? Number(msg.internalDate) : NaN;
    return {
      gmailMessageId: msg.id,
      gmailThreadId: typeof msg.threadId === 'string' ? msg.threadId : '',
      receivedAtMs: Number.isFinite(internalDate) ? internalDate : Date.now(),
      fromEmail: from,
      subject,
      contentType,
      xFailedRecipients: xFailed,
      referencedMessageIds: [...referenced],
      deliveryStatusText,
      snippet: typeof msg.snippet === 'string' ? msg.snippet : '',
    };
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
