import { AppError } from '../../utils/errors.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { ContactEnrichmentRepository } from '../../persistence/repositories/contact-enrichment.repo.js';
import { ContactEnrichmentService, computeInputHash, type EnrichmentRunCaps } from '../../domain/contact-enrichment/service.js';
import { type CandidatePerson } from '../../domain/contact-enrichment/types.js';
import { INSTANTLY_ENDPOINTS, INSTANTLY_SCOPES } from '../../integrations/contact-enrichment/instantly-schema.js';
import { buildContactEnrichmentProvider } from './contact-enrich-build.js';
import { type CliContext } from '../context.js';

export interface ContactEnrichCliOptions {
  lead?: string;
  candidate?: string[];
  domain?: string;
  confirm?: boolean;
  maxCredits?: string;
  maxRequests?: string;
}

const HONORIFICS = new Set(['dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'prof', 'prof.', 'miss']);

/** Parse `"Full Name|Title"` specs into priority-ordered candidates (order given = priority). */
export function parseCandidates(specs: string[]): CandidatePerson[] {
  return specs.map((spec, i) => {
    const [namePart, titlePart] = spec.split('|');
    const fullName = (namePart ?? '').trim();
    const title = (titlePart ?? '').trim();
    if (!fullName || !title) throw new AppError('BAD_CANDIDATE', `--candidate must be "Full Name|Title" (got "${spec}").`);
    const tokens = fullName.split(/\s+/).filter((t) => !HONORIFICS.has(t.toLowerCase()));
    const firstName = tokens[0] ?? fullName;
    const lastName = tokens.length > 1 ? tokens[tokens.length - 1] ?? '' : '';
    if (!lastName) throw new AppError('BAD_CANDIDATE', `Cannot derive a last name from "${fullName}".`);
    return { fullName, firstName, lastName, title, priority: i + 1 };
  });
}

export async function contactEnrichCommand(ctx: CliContext, opts: ContactEnrichCliOptions): Promise<void> {
  const c = ctx.config;
  const leadId = opts.lead?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead; no bulk mode).');
  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found.`);

  const candidates = parseCandidates(opts.candidate ?? []);
  if (candidates.length === 0) throw new AppError('CANDIDATES_REQUIRED', 'At least one --candidate "Full Name|Title" is required.');

  const facts = new LeadFactsRepository(ctx.db);
  const domain = (
    opts.domain?.trim() ||
    (await facts.getCurrentFact(leadId, 'official_domain'))?.value ||
    lead.normalizedDomain ||
    ''
  ).trim().toLowerCase();
  if (!domain) throw new AppError('DOMAIN_REQUIRED', 'No domain: pass --domain or ensure the lead has an official_domain fact.');

  const caps: EnrichmentRunCaps = {
    maxRequests: opts.maxRequests ? Number.parseInt(opts.maxRequests, 10) : c.CONTACT_ENRICHMENT_MAX_REQUESTS_PER_RUN,
    maxCredits: opts.maxCredits ? Number.parseInt(opts.maxCredits, 10) : c.CONTACT_ENRICHMENT_MAX_CREDITS_PER_RUN,
    minCreditsPerLookup: 1,
  };
  const repo = new ContactEnrichmentRepository(ctx.db);
  const providerName = c.CONTACT_ENRICHMENT_PROVIDER;

  // ---- PLAN / DRY-RUN (default): pure projection. No provider constructed, no network, no spend. ----
  if (!opts.confirm) {
    const inputHash = computeInputHash(providerName, domain, candidates);
    // Dry-run must not depend on the enrichment table existing yet (migration 0039 may be unapplied).
    const existing = await repo.findByInputHash(leadId, providerName, inputHash).catch(() => null);
    console.log(`\n=== contact-enrich PLAN (dry-run — no spend) ===`);
    console.log(`  lead:            ${leadId}`);
    console.log(`  domain:          ${domain}`);
    console.log(`  provider:        ${providerName}`);
    console.log(`  paid gates:      CONTACT_ENRICHMENT_ENABLED=${String(c.CONTACT_ENRICHMENT_ENABLED)} ALLOW_PAID_ENRICHMENT_CALLS=${String(c.ALLOW_PAID_ENRICHMENT_CALLS)} key=${c.INSTANTLY_API_KEY ? 'set' : 'MISSING'}`);
    console.log(`  caps:            maxRequests=${String(caps.maxRequests)} maxCredits=${String(caps.maxCredits)}`);
    console.log(`  candidates (priority order):`);
    for (const p of candidates) console.log(`    ${String(p.priority)}. ${p.fullName} — ${p.title}  (${p.firstName} ${p.lastName})`);
    if (providerName === 'instantly') {
      console.log(`  endpoints:       POST ${INSTANTLY_ENDPOINTS.enrich} → GET ${INSTANTLY_ENDPOINTS.enrich}/{resource_id} → POST ${INSTANTLY_ENDPOINTS.leadsList} {list_id}`);
      console.log(`  required scopes: ${INSTANTLY_SCOPES.enrich} (enrich) / ${INSTANTLY_SCOPES.read} (poll) / ${INSTANTLY_SCOPES.leadsRead} (retrieve)`);
      console.log(`  expected credits/verified lead: 1 work-email enrichment + verification (see canary).`);
    }
    console.log(`  idempotency:     ${existing ? `EXISTING ${existing.outcome} (re-run would NOT spend)` : 'none yet (a run would create one)'}`);
    console.log(`\n  To execute (mock is safe; Instantly requires the paid gates above): add --confirm`);
    return;
  }

  // ---- RUN: build provider (Instantly hard-gated) and enrich. Mock returns NOT_FOUND (fail closed). ----
  const provider = buildContactEnrichmentProvider(ctx);
  const service = new ContactEnrichmentService({ provider, store: repo, logger: ctx.logger });
  const result = await service.run(leadId, domain, candidates, caps);

  console.log(`\n=== contact-enrich RESULT (provider=${result.provider}) ===`);
  console.log(`  lead:            ${result.leadId}`);
  console.log(`  outcome:         ${result.outcome}`);
  console.log(`  credits used:    ${String(result.creditsUsed)}`);
  if (result.accepted) {
    console.log(`  decision-maker:  ${result.accepted.fullName} — ${result.accepted.title}`);
    console.log(`  email:           ${result.accepted.email}`);
    console.log(`  verification:    ${result.accepted.verificationStatus} (data quality: ${result.accepted.dataQuality ?? '-'}, confidence: ${result.accepted.confidence ?? '-'})`);
  } else {
    console.log(`  decision-maker:  none accepted — fail closed (no generic/guessed fallback).`);
  }
}
