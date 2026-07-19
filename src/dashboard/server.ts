import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { type Logger } from 'pino';
import { type ReviewService } from '../domain/review/review-service.js';
import { safePathSegment } from '../domain/demo/sanitize.js';
import { renderIndex, renderLeadDetail } from './pages.js';
import {
  csrfMatches, isAllowedHost, isSameOrigin, newCsrfToken, parseFormBody, SECURITY_HEADERS,
} from './security.js';

export interface ReviewServerDeps {
  service: ReviewService;
  demoOutputDir: string;
  logger: Logger;
}

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, ...SECURITY_HEADERS });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

/**
 * Build the local review dashboard HTTP server. Loopback-only (caller binds 127.0.0.1). Every
 * request is Host-checked; every mutating POST additionally requires a same-origin Origin/Referer
 * and the per-session CSRF token. Returns the server plus the session CSRF token (embedded in forms).
 */
export function createReviewServer(deps: ReviewServerDeps): { server: Server; csrfToken: string } {
  const csrfToken = newCsrfToken();
  const base = resolve(deps.demoOutputDir);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'dashboard request failed');
      if (!res.headersSent) send(res, 500, 'Internal error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host)) { send(res, 403, 'Forbidden (host)'); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET') {
      if (path === '/') { send(res, 200, renderIndex(await deps.service.listAwaiting())); return; }
      const lead = /^\/lead\/([^/]+)$/.exec(path);
      if (lead) {
        const detail = await deps.service.detail(decodeURIComponent(lead[1] as string));
        if (!detail) { send(res, 404, 'Lead not found'); return; }
        send(res, 200, renderLeadDetail(detail, csrfToken));
        return;
      }
      const demo = /^\/demo\/([^/]+)$/.exec(path);
      if (demo) { await serveDemo(decodeURIComponent(demo[1] as string), res); return; }
      send(res, 404, 'Not found');
      return;
    }

    if (method === 'POST') {
      const m = /^\/lead\/([^/]+)\/(demo|email|finalized)\/(approve|reject)$/.exec(path);
      if (!m) { send(res, 404, 'Not found'); return; }
      // Same-origin + CSRF gate for all mutations.
      if (!isSameOrigin({ origin: req.headers.origin, referer: req.headers.referer, host: req.headers.host })) { send(res, 403, 'Forbidden (origin)'); return; }
      const body = parseFormBody(await readBody(req));
      if (!csrfMatches(csrfToken, body.csrf)) { send(res, 403, 'Forbidden (csrf)'); return; }

      const leadId = decodeURIComponent(m[1] as string);
      const target = m[2] as 'demo' | 'email' | 'finalized';
      const decision = m[3] === 'approve' ? 'APPROVED' : 'REJECTED';
      const notes = (body.notes ?? '').trim() || null;
      const result = target === 'demo'
        ? await deps.service.decideDemo(leadId, decision, notes)
        : target === 'finalized'
          ? await deps.service.decideFinalizedEmail(leadId, decision, notes)
          : await deps.service.decideEmail(leadId, decision, notes);
      deps.logger.info({ leadId, target, decision, result }, 'review action');
      res.writeHead(303, { Location: `/lead/${encodeURIComponent(leadId)}`, ...SECURITY_HEADERS });
      res.end();
      return;
    }

    send(res, 405, 'Method not allowed');
  }

  async function serveDemo(leadId: string, res: ServerResponse): Promise<void> {
    const detail = await deps.service.detail(leadId);
    if (!detail?.demo) { send(res, 404, 'No demo'); return; }
    // Traversal-safe: constrain to <demoOutputDir>/<safe-lead-segment>/index.html.
    let file: string;
    try {
      file = resolve(base, safePathSegment(leadId), 'index.html');
    } catch {
      send(res, 400, 'Bad lead id'); return;
    }
    if (file !== base && !file.startsWith(base + sep)) { send(res, 403, 'Forbidden'); return; }
    if (!existsSync(file)) { send(res, 404, 'Demo file missing'); return; }
    send(res, 200, await readFile(file, 'utf8'));
  }

  return { server, csrfToken };
}
