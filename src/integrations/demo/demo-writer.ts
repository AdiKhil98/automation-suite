import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { safePathSegment } from '../../domain/demo/sanitize.js';
import { type DemoOutputWriter } from '../../domain/demo/demo-service.js';

/**
 * Writes generated demo files to `<baseDir>/<leadId>/`. The lead id is constrained to a
 * safe path segment (no traversal), and the resolved output is asserted to stay within
 * the base directory. Demos are local and private until human-approved.
 */
export class LocalDemoWriter implements DemoOutputWriter {
  constructor(private readonly baseDir: string) {}

  async write(leadId: string, files: Record<string, string>): Promise<string> {
    const segment = safePathSegment(leadId);
    const base = resolve(this.baseDir);
    const dir = resolve(base, segment);
    if (dir !== base && !dir.startsWith(base + sep)) {
      throw new Error('demo output path escaped the base directory');
    }
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      // File names are fixed by the caller (index.html, netlify.toml); constrain anyway.
      if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`unsafe demo file name: ${name}`);
      await writeFile(join(dir, name), content, 'utf8');
    }
    return dir;
  }
}
