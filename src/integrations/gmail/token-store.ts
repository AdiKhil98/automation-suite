import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Locally-stored Gmail OAuth credentials. The REFRESH TOKEN is a long-lived secret: it lives
 * ONLY in this git-ignored file with 0600 permissions — never in env, the database, migrations,
 * logs, or chat. Access tokens are short-lived and held in memory only.
 */
export interface GmailCredentials {
  refreshToken: string;
  accountEmail: string | null;
  scope: string;
  obtainedAt: string;
}

export interface GmailTokenStore {
  load(): Promise<GmailCredentials | null>;
  save(cred: GmailCredentials): Promise<void>;
  exists(): boolean;
}

export class LocalGmailTokenStore implements GmailTokenStore {
  constructor(private readonly file: string) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  async load(): Promise<GmailCredentials | null> {
    if (!existsSync(this.file)) return null;
    return JSON.parse(await readFile(this.file, 'utf8')) as GmailCredentials;
  }

  async save(cred: GmailCredentials): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    await chmod(this.file, 0o600);
  }
}
