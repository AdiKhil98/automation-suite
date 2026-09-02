import { AppError } from '../../utils/errors.js';
import { type CandidatePerson } from './types.js';

/**
 * Shared decision-maker name/title parsing, used by both the single-lead `--candidate "Name|Title"` CLI
 * flag and the multi-lead `contact-resolve-batch` candidates JSON file — the same fail-closed rules
 * (non-empty name/title, a derivable last name) apply to a candidate however it was supplied.
 */

const HONORIFICS = new Set(['dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'prof', 'prof.', 'miss']);

/** Build one priority-ordered candidate from a full name + title. Throws `BAD_CANDIDATE` (AppError) on
 * an empty name/title or a name with no derivable last name (never guesses one). */
export function buildCandidatePerson(fullName: string, title: string, priority: number): CandidatePerson {
  const name = fullName.trim();
  const t = title.trim();
  if (!name || !t) throw new AppError('BAD_CANDIDATE', `Candidate name and title must both be non-empty (got name="${fullName}", title="${title}").`);
  const tokens = name.split(/\s+/).filter((tok) => !HONORIFICS.has(tok.toLowerCase()));
  const firstName = tokens[0] ?? name;
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] ?? '' : '';
  if (!lastName) throw new AppError('BAD_CANDIDATE', `Cannot derive a last name from "${fullName}".`);
  return { fullName: name, firstName, lastName, title: t, priority };
}
