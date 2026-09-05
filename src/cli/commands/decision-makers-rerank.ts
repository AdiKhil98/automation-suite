import {
  readCandidatesFileIfExists,
  saveCandidatesFile,
  type CandidatesFileData,
  type CandidatesFileEntry,
} from '../../domain/contact-resolve-batch/candidates-file.js';
import { classifyValidatedTitlePriority, type TitlePriority } from '../../domain/decision-makers/title-priority.js';
import { AppError } from '../../utils/errors.js';

export interface DecisionMakersRerankOptions {
  file?: string;
  lead?: string;
  confirm?: boolean;
}

const DEFAULT_FILE = '.local-data/decision-makers/candidates.json';

/**
 * Offline re-ranking of candidates ALREADY stored in candidates.json, using the current deterministic
 * title-priority taxonomy.
 *
 * `contact-resolve-batch` derives each candidate's priority from its position in the array
 * (`loadCandidatesFile` -> `buildCandidatePerson(name, title, i + 1)`) and stops at the first
 * verified contact, so the stored order decides who we actually buy an email for. When the taxonomy
 * changes, that order goes stale — a Managing Director recorded under the old Tier 4 sits behind a
 * Practice Manager and would be contacted second, or never.
 *
 * This command fixes the order using only information already on disk. It makes NO network call, NO
 * LLM call and NO enrichment call, and it does not open the operational database — it is registered
 * without a CLI context for exactly that reason. Names, titles, evidence snippets, source URLs and
 * confidences are never rewritten; only the array order changes.
 */
export function decisionMakersRerankCommand(opts: DecisionMakersRerankOptions): void {
  const path = opts.file ?? DEFAULT_FILE;
  const data = readCandidatesFileIfExists(path);
  if (!data) throw new AppError('CANDIDATES_FILE_MISSING', `No candidates file at "${path}" — nothing to re-rank.`);

  const targetLeadId = opts.lead?.trim();
  if (opts.lead !== undefined && !targetLeadId) throw new AppError('INVALID_ARGUMENT', '--lead requires a lead id.');
  if (targetLeadId && !(targetLeadId in data)) {
    throw new AppError('LEAD_NOT_IN_CANDIDATES_FILE', `--lead "${targetLeadId}" has no entry in "${path}".`);
  }

  const leadIds = targetLeadId ? [targetLeadId] : Object.keys(data);
  console.log(`\n=== decision-makers-rerank (${opts.confirm ? 'WRITE' : 'DRY RUN'}) ===`);
  console.log(`  file:  ${path}`);
  console.log(`  leads: ${String(leadIds.length)}${targetLeadId ? ` (--lead ${targetLeadId})` : ' (all)'}`);
  console.log('  No network, LLM or enrichment call is made by this command.\n');

  const next: CandidatesFileData = { ...data };
  let changed = 0;

  for (const leadId of leadIds) {
    const entries = data[leadId];
    if (!entries) continue;

    // Fail closed: a stored candidate that no longer maps to any tier is a taxonomy regression, not
    // licence to drop a paid-for result. Report it and write nothing.
    const tiered: Array<{ entry: CandidatesFileEntry; tier: TitlePriority }> = [];
    const unmapped: CandidatesFileEntry[] = [];
    for (const entry of entries) {
      const tier = classifyValidatedTitlePriority(entry.title);
      if (tier === null) unmapped.push(entry);
      else tiered.push({ entry, tier });
    }
    if (unmapped.length > 0) {
      throw new AppError(
        'CANDIDATE_BECAME_UNMAPPED',
        `Lead ${leadId}: ${String(unmapped.length)} stored candidate(s) no longer map to any tier under the current taxonomy — ${unmapped.map((e) => `"${e.fullName} — ${e.title}"`).join(', ')}. Refusing to re-rank; nothing was written. Fix the taxonomy or remove the entry deliberately.`,
      );
    }

    // Tier first, then the existing confidence ordering. Array.prototype.sort is stable, so entries
    // that tie on both keys keep the order they already had.
    const sorted = [...tiered].sort((a, b) => a.tier - b.tier || (b.entry.confidence ?? -1) - (a.entry.confidence ?? -1));
    const before = tiered.map((t) => t.entry.fullName);
    const after = sorted.map((t) => t.entry.fullName);
    const reordered = before.some((n, i) => n !== after[i]);
    if (reordered) changed += 1;

    console.log(`  lead ${leadId}${reordered ? '  (REORDERED)' : '  (unchanged)'}`);
    console.log(`    before: ${tiered.map((t) => `${t.entry.fullName} [${t.entry.title}]`).join(' → ')}`);
    console.log(`    after:  ${sorted.map((t) => `${t.entry.fullName} [${t.entry.title}, tier ${String(t.tier)}]`).join(' → ')}`);

    // The same entry objects, reordered — nothing about a candidate's content is rewritten.
    next[leadId] = sorted.map((t) => t.entry);
  }

  if (!opts.confirm) {
    console.log(`\n  DRY RUN: ${String(changed)} lead(s) would be reordered. Nothing written. Re-run with --confirm to apply.`);
    return;
  }
  if (changed === 0) {
    console.log('\n  Nothing to change; file left untouched.');
    return;
  }
  saveCandidatesFile(path, next);
  console.log(`\n  wrote: ${path} (${String(changed)} lead(s) reordered)`);
}
