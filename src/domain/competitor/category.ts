import { RELATED_CATEGORY_GROUPS } from './constants.js';
import { normalizeName } from '../leads/normalize.js';
import { type CategoryMatch } from './types.js';

/**
 * Deterministic category-relationship classification using ONLY the explicit
 * RELATED_CATEGORY_GROUPS mapping. Unknown relationships are never treated as related.
 *
 *  - NONE    : the candidate has no supplied primary category.
 *  - EXACT   : normalized candidate category === normalized prospect category.
 *  - RELATED : both categories appear together in one explicit related group.
 *  - WEAK    : both categories are present but neither exact nor explicitly related.
 */
export function classifyCategoryMatch(
  prospectCategory: string | null,
  candidateCategory: string | null,
): CategoryMatch {
  const cand = normalizeName(candidateCategory);
  if (!cand) return 'NONE';
  const prospect = normalizeName(prospectCategory);
  if (!prospect) return 'WEAK'; // candidate has a category but the prospect's is unknown → not comparable
  if (cand === prospect) return 'EXACT';
  for (const group of RELATED_CATEGORY_GROUPS) {
    const g = new Set(group.map((c) => normalizeName(c)).filter((c): c is string => Boolean(c)));
    if (g.has(cand) && g.has(prospect)) return 'RELATED';
  }
  return 'WEAK';
}
