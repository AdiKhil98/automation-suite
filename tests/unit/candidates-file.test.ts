import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCandidatesFile,
  readCandidatesFileIfExists,
  saveCandidatesFile,
} from '../../src/domain/contact-resolve-batch/candidates-file.js';

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

  it('a discover-decision-makers-style file with extra provenance fields is still accepted unchanged (generated JSON is accepted by contact-resolve-batch)', () => {
    const path = writeTemp(JSON.stringify({
      'lead-1': [
        {
          fullName: 'Shyam Shastri', title: 'Principal Dentist',
          sourceUrl: 'https://diamond-smile.com/meet-the-team',
          evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.',
          confidence: 0.97,
        },
      ],
    }));
    const map = loadCandidatesFile(path);
    // Extra provenance fields are silently ignored by buildCandidatePerson; the resolver-facing shape
    // is unchanged.
    expect(map.get('lead-1')).toEqual([
      { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
    ]);
  });
});

describe('readCandidatesFileIfExists / saveCandidatesFile', () => {
  it('returns null for a missing file instead of throwing', () => {
    expect(readCandidatesFileIfExists('/no/such/file.json')).toBeNull();
  });

  it('still fails closed on a PRESENT but corrupt file (never treated as "nothing to reuse")', () => {
    const path = writeTemp('{ not json');
    expect(() => readCandidatesFileIfExists(path)).toThrow(/not valid JSON/);
  });

  it('round-trips: saveCandidatesFile then readCandidatesFileIfExists returns the same data, and loadCandidatesFile accepts it', () => {
    dir = mkdtempSync(join(tmpdir(), 'candidates-file-test-'));
    const path = join(dir, 'out', 'candidates.json'); // parent dir does not exist yet
    const data = {
      'lead-1': [{ fullName: 'Shyam Shastri', title: 'Principal Dentist', sourceUrl: 'https://diamond-smile.com/meet-the-team', evidenceSnippet: 'snip', confidence: 0.9 }],
    };
    saveCandidatesFile(path, data);
    expect(readCandidatesFileIfExists(path)).toEqual(data);
    expect(loadCandidatesFile(path).get('lead-1')).toEqual([
      { fullName: 'Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1 },
    ]);
  });
});
