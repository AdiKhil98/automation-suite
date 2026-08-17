import { factSourceTypeSchema } from '../../domain/lead-facts/lead-fact.js';
import { isValidTimeZone } from '../../domain/schedule/timezone.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface SetContactTimezoneOptions {
  lead?: string;
  timezone?: string;
  sourceType?: string;
  sourceUrl?: string;
  confirm?: boolean;
}

/**
 * Set the current `contact_timezone` fact for a lead from an operator-supplied IANA timezone, reusing the
 * existing fact/provenance system (`LeadFactsRepository.writeCurrentFact`, which supersedes any prior
 * current fact). The value is validated with the existing `isValidTimeZone` helper before persistence.
 * It records ONLY what the operator supplies — no guessing/inference. Zero external calls; no
 * scheduling/send/LLM/network. Dry preview unless `--confirm`.
 */
export async function setContactTimezoneCommand(ctx: CliContext, opts: SetContactTimezoneOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const timezone = opts.timezone?.trim();
  const sourceTypeRaw = opts.sourceType?.trim();
  const sourceUrl = opts.sourceUrl?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required.');
  if (!timezone) throw new AppError('TIMEZONE_REQUIRED', '--timezone <iana> is required (e.g. Europe/London).');
  if (!sourceTypeRaw) throw new AppError('SOURCE_TYPE_REQUIRED', '--source-type <mock|manual|website|google_places> is required.');
  if (!sourceUrl) throw new AppError('SOURCE_URL_REQUIRED', '--source-url <url> is required (provenance).');

  const sourceTypeParsed = factSourceTypeSchema.safeParse(sourceTypeRaw);
  if (!sourceTypeParsed.success) {
    throw new AppError('SOURCE_TYPE_INVALID', `--source-type must be one of mock|manual|website|google_places (got "${sourceTypeRaw}").`);
  }
  const sourceType = sourceTypeParsed.data;

  if (!isValidTimeZone(timezone)) {
    console.error(`Timezone REFUSED: "${timezone}" is not a valid IANA timezone. No fact written.`);
    process.exitCode = 1;
    return;
  }

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found.`);

  console.log(`\n=== contact_timezone fact (lead ${leadId}) ===`);
  console.log(`  value (iana):  ${timezone}`);
  console.log(`  source type:   ${sourceType}`);
  console.log(`  source url:    ${sourceUrl}`);
  console.log(`  confidence:    1`);

  if (!opts.confirm) {
    console.log('\n  Dry preview only. Re-run with --confirm to persist the fact.');
    console.log('  No fact written. No external calls.');
    return;
  }

  await ctx.db.transaction(async (tx) => {
    await new LeadFactsRepository(tx).writeCurrentFact({
      leadId, factType: 'contact_timezone', value: timezone, normalizedValue: timezone, sourceType, sourceUrl, confidence: 1,
    });
    await new PipelineRepository(tx).record({
      leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
      message: `contact_timezone set: ${timezone}`,
      data: { factType: 'contact_timezone', value: timezone, sourceType, sourceUrl },
    });
  });

  console.log(`\n  Persisted current contact_timezone = ${timezone} (sourceType=${sourceType}). Prior current fact superseded.`);
  console.log('  No external calls, no Gmail/send/schedule.');
}
