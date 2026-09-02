import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { buildCandidatePerson } from '../contact-enrichment/candidate-parsing.js';
import { type CandidatePerson } from '../contact-enrichment/types.js';

/**
 * There is no persisted source of decision-maker names/titles anywhere in the schema (every provider
 * path requires a caller-supplied candidate list). `contact-resolve-batch` sources candidates from an
 * operator-maintained, git-ignored local JSON file instead of adding a new table: `{ [leadId]:
 * [{fullName, title}, ...] }`, array order = priority. Fails closed (throws) on malformed JSON/shape —
 * never silently drops or guesses a candidate.
 */

const candidatesFileSchema = z.record(
  z.string(),
  z.array(z.object({ fullName: z.string().min(1), title: z.string().min(1) })).min(1),
);

/** Load + validate the candidates file. Returns a Map keyed by lead id. */
export function loadCandidatesFile(path: string): Map<string, CandidatePerson[]> {
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
  const byLead = new Map<string, CandidatePerson[]>();
  for (const [leadId, entries] of Object.entries(parsed.data)) {
    byLead.set(leadId, entries.map((e, i) => buildCandidatePerson(e.fullName, e.title, i + 1)));
  }
  return byLead;
}
