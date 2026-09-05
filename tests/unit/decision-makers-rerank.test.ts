import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionMakersRerankCommand } from '../../src/cli/commands/decision-makers-rerank.js';
import { loadCandidatesFile } from '../../src/domain/contact-resolve-batch/candidates-file.js';
import { guardOperationalLocalData } from '../support/local-data-isolation.js';

// `decision-makers-rerank` also defaults to the real candidates file; every test here passes --file.
guardOperationalLocalData();

let dir: string | null = null;
let logs: string[] = [];

beforeEach(() => { logs = []; vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }); });
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function writeFile(data: unknown): string {
  dir = mkdtempSync(join(tmpdir(), 'dm-rerank-'));
  const path = join(dir, 'candidates.json');
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

const DULWICH = 'lead-dulwich';
/** The exact inversion observed live: the Practice Manager was stored ahead of the Managing Director. */
const DULWICH_ENTRIES = [
  { fullName: 'Michelle Ketchen', title: 'Practice Manager', sourceUrl: 'https://dulwichorthodontics.co.uk/team', evidenceSnippet: 'Michelle Ketchen Practice Manager', confidence: 0.93 },
  { fullName: 'Mena Williams', title: 'Managing Director', sourceUrl: 'https://dulwichorthodontics.co.uk/team', evidenceSnippet: 'Mena Williams Managing Director VIEW PROFILE', confidence: 0.9 },
];

describe('decision-makers-rerank', () => {
  it('moves a Managing Director ahead of a Practice Manager (Dulwich)', () => {
    const path = writeFile({ [DULWICH]: DULWICH_ENTRIES });
    decisionMakersRerankCommand({ file: path, lead: DULWICH, confirm: true });

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Array<{ fullName: string }>>;
    expect(after[DULWICH]?.map((e) => e.fullName)).toEqual(['Mena Williams', 'Michelle Ketchen']);
  });

  it('the reordering is what contact-resolve-batch will actually act on', () => {
    const path = writeFile({ [DULWICH]: DULWICH_ENTRIES });
    expect(loadCandidatesFile(path).get(DULWICH)?.map((c) => `${c.fullName}#${String(c.priority)}`))
      .toEqual(['Michelle Ketchen#1', 'Mena Williams#2']);

    decisionMakersRerankCommand({ file: path, lead: DULWICH, confirm: true });

    // Priority is derived from array position, so the Managing Director is now attempted first.
    expect(loadCandidatesFile(path).get(DULWICH)?.map((c) => `${c.fullName}#${String(c.priority)}`))
      .toEqual(['Mena Williams#1', 'Michelle Ketchen#2']);
  });

  it('never alters names, titles, evidence, source URLs or confidences', () => {
    const path = writeFile({ [DULWICH]: DULWICH_ENTRIES });
    decisionMakersRerankCommand({ file: path, lead: DULWICH, confirm: true });

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, typeof DULWICH_ENTRIES>;
    const byName = new Map(after[DULWICH]?.map((e) => [e.fullName, e]));
    for (const original of DULWICH_ENTRIES) {
      expect(byName.get(original.fullName)).toEqual(original);
    }
  });

  it('dry run by default: prints before → after and writes nothing', () => {
    const path = writeFile({ [DULWICH]: DULWICH_ENTRIES });
    const before = read(path, 'utf8');

    decisionMakersRerankCommand({ file: path, lead: DULWICH });

    expect(read(path, 'utf8')).toBe(before);
    const out = logs.join('\n');
    expect(out).toContain('DRY RUN');
    expect(out).toContain('before:');
    expect(out).toContain('after:');
    expect(out).toContain('REORDERED');
  });

  it('fails closed when a stored candidate no longer maps to any tier — nothing is written or dropped', () => {
    const path = writeFile({
      'lead-x': [
        { fullName: 'A Person', title: 'Owner', confidence: 0.9 },
        { fullName: 'B Person', title: 'Dental Nurse', confidence: 0.8 },
      ],
    });
    const before = read(path, 'utf8');
    expect(() => decisionMakersRerankCommand({ file: path, lead: 'lead-x', confirm: true }))
      .toThrow(expect.objectContaining({ code: 'CANDIDATE_BECAME_UNMAPPED' }));
    expect(read(path, 'utf8')).toBe(before);
  });

  it('batch mode re-ranks every lead; an already-correct lead is left unchanged', () => {
    const path = writeFile({
      [DULWICH]: DULWICH_ENTRIES,
      'lead-ok': [{ fullName: 'Shahin Lalani', title: 'Owner', confidence: 0.95 }],
    });
    decisionMakersRerankCommand({ file: path, confirm: true });

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Array<{ fullName: string }>>;
    expect(after[DULWICH]?.map((e) => e.fullName)).toEqual(['Mena Williams', 'Michelle Ketchen']);
    expect(after['lead-ok']?.map((e) => e.fullName)).toEqual(['Shahin Lalani']);
  });

  it('within a tier, higher confidence wins and equal entries keep their existing order', () => {
    const path = writeFile({
      'lead-y': [
        { fullName: 'Low Conf Owner', title: 'Owner', confidence: 0.7 },
        { fullName: 'High Conf Partner', title: 'Managing Partner', confidence: 0.95 },
        { fullName: 'First Manager', title: 'Practice Manager' },
        { fullName: 'Second Manager', title: 'Operations Manager' },
      ],
    });
    decisionMakersRerankCommand({ file: path, lead: 'lead-y', confirm: true });

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Array<{ fullName: string }>>;
    expect(after['lead-y']?.map((e) => e.fullName))
      .toEqual(['High Conf Partner', 'Low Conf Owner', 'First Manager', 'Second Manager']);
  });

  it('rejects a missing file and an unknown lead', () => {
    const path = writeFile({ [DULWICH]: DULWICH_ENTRIES });
    expect(() => decisionMakersRerankCommand({ file: join(dir ?? '', 'nope.json') })).toThrow(expect.objectContaining({ code: 'CANDIDATES_FILE_MISSING' }));
    expect(() => decisionMakersRerankCommand({ file: path, lead: 'not-a-lead' })).toThrow(expect.objectContaining({ code: 'LEAD_NOT_IN_CANDIDATES_FILE' }));
    expect(() => decisionMakersRerankCommand({ file: path, lead: '  ' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('reaches no network, provider, database or LLM module', async () => {
    // Structural guarantee: the command's entire import graph is the candidates file, the pure title
    // classifier and AppError. Anything reachable from it is offline by construction.
    const source = read(new URL('../../src/cli/commands/decision-makers-rerank.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      '../../domain/contact-resolve-batch/candidates-file.js',
      '../../domain/decision-makers/title-priority.js',
      '../../utils/errors.js',
    ]);
    for (const forbidden of ['provider', 'openai', 'instantly', 'hunter', 'persistence', 'safe-fetch', 'node:http']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
