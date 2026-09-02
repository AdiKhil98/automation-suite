import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCandidatesFile } from '../../src/domain/contact-resolve-batch/candidates-file.js';

let dir: string | null = null;
function writeTemp(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'candidates-file-test-'));
  const path = join(dir, 'candidates.json');
  writeFileSync(path, content, 'utf8');
  return path;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('loadCandidatesFile', () => {
  it('loads a valid file, preserving array order as priority', () => {
    const path = writeTemp(JSON.stringify({
      'lead-1': [
        { fullName: 'Shyam Shastri', title: 'Principal Dentist' },
        { fullName: 'Shaimil Patel', title: 'Clinical Director' },
      ],
    }));
    const map = loadCandidatesFile(path);
    expect(map.get('lead-1')).toEqual([
      { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
      { fullName: 'Shaimil Patel', firstName: 'Shaimil', lastName: 'Patel', title: 'Clinical Director', priority: 2 },
    ]);
  });

  it('fails closed on a missing file', () => {
    expect(() => loadCandidatesFile('/no/such/file.json')).toThrow(/CANDIDATES_FILE_UNREADABLE|Could not read/);
  });

  it('fails closed on invalid JSON', () => {
    const path = writeTemp('{ not json');
    expect(() => loadCandidatesFile(path)).toThrow(/CANDIDATES_FILE_INVALID_JSON|not valid JSON/);
  });

  it('fails closed on an empty candidate array for a lead', () => {
    const path = writeTemp(JSON.stringify({ 'lead-1': [] }));
    expect(() => loadCandidatesFile(path)).toThrow(/must be \{"<leadId>"/);
  });

  it('fails closed on a malformed entry (missing title)', () => {
    const path = writeTemp(JSON.stringify({ 'lead-1': [{ fullName: 'Shyam Shastri' }] }));
    expect(() => loadCandidatesFile(path)).toThrow(/must be \{"<leadId>"/);
  });

  it('an empty top-level object is valid (no leads have known candidates yet)', () => {
    const path = writeTemp('{}');
    expect(loadCandidatesFile(path).size).toBe(0);
  });
});
