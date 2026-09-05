import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeFileAtomicSync } from '../../utils/atomic-write.js';
import { AppError } from '../../utils/errors.js';
import { buildCandidatePerson } from '../contact-enrichment/candidate-parsing.js';
import { type CandidatePerson } from '../contact-enrichment/types.js';

/**
 * There is no persisted source of decision-maker names/titles anywhere in the schema (every provider
 * path requires a caller-supplied candidate list). `contact-resolve-batch` sources candidates from an
 * operator-maintained, git-ignored local JSON file instead of adding a new table: `{ [leadId]:
 * [{fullName, title}, ...] }`, array order = priority. Fails closed (throws) on malformed JSON/shape —
 * never silently drops or guesses a candidate.
 *
 * `discover-decision-makers` PRODUCES this same file. Its extra provenance fields (sourceUrl,
 * evidenceSnippet, confidence) are optional and additive — a plain (non-`.strict()`) Zod object
 * silently ignores unknown keys, so a hand-written minimal file and a discover-decision-makers-written
 * provenance-rich file are both valid, and `loadCandidatesFile`/`contact-resolve-batch` need no changes
 * to accept either.
 */

const candidatesFileEntrySchema = z.object({
  fullName: z.string().min(1),
  title: z.string().min(1),
  sourceUrl: z.string().optional(),
  evidenceSnippet: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type CandidatesFileEntry = z.infer<typeof candidatesFileEntrySchema>;

const candidatesFileSchema = z.record(z.string(), z.array(candidatesFileEntrySchema).min(1));
export type CandidatesFileData = z.infer<typeof candidatesFileSchema>;

function readAndParse(path: string): CandidatesFileData {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AppError('CANDIDATES_FILE_UNREADABLE', `Could not read --candidates-file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new AppError('CANDIDATES_FILE_INVALID_JSON', `--candidates-file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = candidatesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError('CANDIDATES_FILE_INVALID_SHAPE', `--candidates-file "${path}" must be {"<leadId>": [{"fullName": "...", "title": "..."}, ...]}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Load + validate the candidates file. Returns a Map keyed by lead id. Fails closed if missing/malformed. */
export function loadCandidatesFile(path: string): Map<string, CandidatePerson[]> {
  const data = readAndParse(path);
  const byLead = new Map<string, CandidatePerson[]>();
  for (const [leadId, entries] of Object.entries(data)) {
    byLead.set(leadId, entries.map((e, i) => buildCandidatePerson(e.fullName, e.title, i + 1)));
  }
  return byLead;
}

/**
 * Same as `loadCandidatesFile` but returns `null` when the file does not exist, instead of throwing.
 * Used by `discover-decision-makers` to check "does an output file already exist to reuse" — distinct
 * from `loadCandidatesFile`'s fail-closed-on-missing behavior, which is correct for
 * `contact-resolve-batch` (the file is required there) but wrong for this optional-reuse check. Any
 * OTHER read error (invalid JSON/shape) still throws — a present-but-corrupt file is never silently
 * treated as "nothing to reuse".
 */
export function readCandidatesFileIfExists(path: string): CandidatesFileData | null {
  if (!existsSync(path)) return null;
  return readAndParse(path);
}

/** Write the candidates file (pretty-printed), creating the parent directory if needed. The write is
 * atomic: an interrupted run must never truncate a file that holds already-paid-for extraction
 * results. Reading and validation are unchanged, so `contact-resolve-batch` sees the same format. */
export function saveCandidatesFile(path: string, data: CandidatesFileData): void {
  writeFileAtomicSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
