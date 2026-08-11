import { normalizeContactEmail } from '../../domain/lead-facts/contact-email.js';
import { factSourceTypeSchema } from '../../domain/lead-facts/lead-fact.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface SetContactEmailOptions {
  lead?: string;
  email?: string;
  sourceType?: string;
  sourceUrl?: string;
  confirm?: boolean;
}

/**
 * Set the current `contact_email` fact for a lead from an operator-supplied address, reusing the existing
 * fact/provenance system (`LeadFactsRepository.writeCurrentFact`, which supersedes any prior current fact).
 * The raw value is normalized to a BARE address (strips `mailto:` + `?query`/`#fragment`) and validated
 * before persistence. It records ONLY what the operator supplies — no guessing, no person/title inference.
 * Zero external calls. Dry preview unless `--confirm`.
 */
export async function setContactEmailCommand(ctx: CliContext, opts: SetContactEmailOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const rawEmail = opts.email?.trim();
  const sourceTypeRaw = opts.sourceType?.trim();
  const sourceUrl = opts.sourceUrl?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required.');
  if (!rawEmail) throw new AppError('EMAIL_REQUIRED', '--email <address> is required.');
  if (!sourceTypeRaw) throw new AppError('SOURCE_TYPE_REQUIRED', '--source-type <mock|manual|website|google_places> is required.');
  if (!sourceUrl) throw new AppError('SOURCE_URL_REQUIRED', '--source-url <url> is required (provenance).');

  const sourceTypeParsed = factSourceTypeSchema.safeParse(sourceTypeRaw);
  if (!sourceTypeParsed.success) {
    throw new AppError('SOURCE_TYPE_INVALID', `--source-type must be one of mock|manual|website|google_places (got "${sourceTypeRaw}").`);
  }
  const sourceType = sourceTypeParsed.data;

  const normalized = normalizeContactEmail(rawEmail);
  if (!normalized.ok || !normalized.value) {
    console.error(`Contact email REFUSED: ${normalized.reason ?? 'invalid'}. No fact written.`);
    process.exitCode = 1;
    return;
  }
  const bare = normalized.value;

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found.`);

  console.log(`\n=== contact_email fact (lead ${leadId}) ===`);
  console.log(`  value (bare):  ${bare}`);
  console.log(`  raw input:     ${rawEmail}`);
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
      leadId, factType: 'contact_email', value: bare, normalizedValue: bare, sourceType, sourceUrl, confidence: 1,
    });
    await new PipelineRepository(tx).record({
      leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null,
      message: `contact_email set: ${bare}`,
      data: { factType: 'contact_email', value: bare, sourceType, sourceUrl },
    });
  });

  console.log(`\n  Persisted current contact_email = ${bare} (sourceType=${sourceType}). Prior current fact superseded.`);
  console.log('  No external calls, no Gmail/send.');
}
