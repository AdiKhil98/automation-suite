import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { normalize, resolve, sep } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { demos } from '../../persistence/schema.js';
import { type CliContext } from '../context.js';

export interface PreviewDemoOptions {
  lead: string;
}

const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.toml': 'text/plain; charset=utf-8', '.css': 'text/css' };

/**
 * Serve a lead's generated demo on LOOPBACK ONLY (127.0.0.1). Never binds a public
 * interface, so the preview is not exposed. Runs until Ctrl+C.
 */
export async function previewDemoCommand(ctx: CliContext, opts: PreviewDemoOptions): Promise<void> {
  const rows = await ctx.db.select().from(demos).where(eq(demos.leadId, opts.lead)).orderBy(desc(demos.createdAt)).limit(1);
  const demo = rows[0];
  if (!demo || !demo.path) {
    console.error(`No generated demo found for lead ${opts.lead}. Run: pnpm cli generate-demos --campaign <c>`);
    process.exitCode = 1;
    return;
  }
  const root = resolve(demo.path);
  console.log(`Demo status: ${demo.status} (pending human review — not published).`);

  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] as string);
    const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
    const filePath = resolve(root, rel);
    // Path-traversal guard: served file must stay within the demo directory.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    void stat(filePath)
      .then((s) => {
        if (!s.isFile()) throw new Error('not a file');
        const ext = filePath.slice(filePath.lastIndexOf('.'));
        res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'x-robots-tag': 'noindex, nofollow, noarchive' });
        createReadStream(filePath).pipe(res);
      })
      .catch(() => res.writeHead(404).end('not found'));
  });

  await new Promise<void>((resolvePromise) => {
    // 127.0.0.1 = loopback only. Do NOT use 0.0.0.0.
    server.listen(ctx.config.DEMO_PREVIEW_PORT, '127.0.0.1', () => {
      console.log(`\nPreview (local only): http://127.0.0.1:${String(ctx.config.DEMO_PREVIEW_PORT)}/`);
      console.log(`Serving: ${root}`);
      console.log('Press Ctrl+C to stop.');
    });
    process.on('SIGINT', () => { server.close(); resolvePromise(); });
  });
}
