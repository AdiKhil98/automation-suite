import { AppError } from '../../utils/errors.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { ContactEnrichmentRepository } from '../../persistence/repositories/contact-enrichment.repo.js';
import { ContactEnrichmentService, computeInputHash, type EnrichmentRunCaps } from '../../domain/contact-enrichment/service.js';
import { type CandidatePerson } from '../../domain/contact-enrichment/types.js';
import { INSTANTLY_ENDPOINTS, INSTANTLY_SCOPES } from '../../integrations/contact-enrichment/instantly-schema.js';
import { HUNTER_ENDPOINTS } from '../../integrations/contact-enrichment/hunter-schema.js';
import { buildContactEnrichmentProvider } from './contact-enrich-build.js';
import { type CliContext } from '../context.js';

export interface ContactEnrichCliOptions {
  lead?: string;
  candidate?: string[];
  domain?: string;
  preview?: boolean;
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
  if (!opts.preview && !opts.confirm) {
    const previewHash = computeInputHash('PREVIEW', providerName, domain, candidates);
    const enrichHash = computeInputHash('ENRICH', providerName, domain, candidates);
    const existingPreview = await repo.findByInputHash(leadId, providerName, 'PREVIEW', previewHash).catch(() => null);
    const existingEnrich = await repo.findByInputHash(leadId, providerName, 'ENRICH', enrichHash).catch(() => null);
    console.log(`\n=== contact-enrich PLAN (dry-run — no spend) ===`);
    console.log(`  lead:            ${leadId}`);
    console.log(`  domain:          ${domain}`);
    console.log(`  provider:        ${providerName}`);
    console.log(`  DRY_RUN:         ${String(c.DRY_RUN)}  (must be false for a live preview/enrich)`);
    console.log(`  paid gates:      CONTACT_ENRICHMENT_ENABLED=${String(c.CONTACT_ENRICHMENT_ENABLED)} ALLOW_PAID_ENRICHMENT_CALLS=${String(c.ALLOW_PAID_ENRICHMENT_CALLS)} key=${c.INSTANTLY_API_KEY ? 'set' : 'MISSING'}`);
    console.log(`  caps:            maxRequests=${String(caps.maxRequests)} maxCredits=${String(caps.maxCredits)} previewLimit=${String(c.CONTACT_ENRICHMENT_PREVIEW_LIMIT)}`);
    console.log(`  candidates (priority order):`);
    for (const p of candidates) console.log(`    ${String(p.priority)}. ${p.fullName} — ${p.title}  (${p.firstName} ${p.lastName})`);
    if (providerName === 'instantly') {
      console.log(`  flow:            [--preview] non-enriching search (0 credits) → local match → [--confirm] paid enrich of a matched person only`);
      console.log(`  preview endpoint: POST ${INSTANTLY_ENDPOINTS.previewLeads}`);
      console.log(`  enrich endpoints: POST ${INSTANTLY_ENDPOINTS.enrich} → GET ${INSTANTLY_ENDPOINTS.enrich}/{resource_id} → POST ${INSTANTLY_ENDPOINTS.leadsList}`);
      console.log(`  required scopes: ${INSTANTLY_SCOPES.enrich} + ${INSTANTLY_SCOPES.read} + ${INSTANTLY_SCOPES.leadsRead}`);
    }
    if (providerName === 'hunter') {
      console.log(`  flow:            [--preview] zero-network echo of known candidates (0 credits) → [--confirm] Finder + independent Verifier, stop at first VERIFIED`);
      console.log(`  finder endpoint:  GET ${HUNTER_ENDPOINTS.emailFinder}`);
      console.log(`  verifier endpoint: GET ${HUNTER_ENDPOINTS.emailVerifier} (called only when Finder returns an email)`);
    }
    console.log(`  idempotency (PREVIEW): ${existingPreview ? `EXISTING ${existingPreview.outcome} (re-run would NOT spend)` : 'none yet'}`);
    console.log(`  idempotency (ENRICH):  ${existingEnrich ? `EXISTING ${existingEnrich.outcome} (re-run would NOT spend)` : 'none yet'}`);
    console.log(`\n  --preview = live non-paid search + match (no credits). --confirm = full run (paid enrich of a match).`);
    return;
  }

  // ---- LIVE: build provider (Instantly hard-gated incl. DRY_RUN kill switch). ----
  const provider = buildContactEnrichmentProvider(ctx);
  const service = new ContactEnrichmentService({ provider, store: repo, logger: ctx.logger });
  // --preview => never enrich. --confirm => enrich only if the paid kill switch is on.
  const performEnrichment = Boolean(opts.confirm) && c.ALLOW_PAID_ENRICHMENT_CALLS;
  const result = await service.run(leadId, domain, candidates, caps, { performEnrichment });

  const prov = result.provenance as { previewPeopleCount?: number; matches?: Array<{ candidate: string; title: string; matchedTitle: string | null }> };
  console.log(`\n=== contact-enrich ${opts.preview && !opts.confirm ? 'PREVIEW' : 'RESULT'} (provider=${result.provider}) ===`);
  console.log(`  lead:            ${result.leadId}`);
  console.log(`  domain:          ${result.requestedDomain}`);
  console.log(`  outcome:         ${result.outcome}`);
  console.log(`  credits:         estimated=${String(result.creditsEstimated)}  provider-reported=${result.creditsReported === null ? 'none reported' : String(result.creditsReported)}`);
  console.log(`  domain coverage: ${String(prov.previewPeopleCount ?? 0)} people returned by preview/search`);
  const matches = prov.matches ?? [];
  console.log(`  matched people:  ${matches.length}`);
  for (const m of matches) console.log(`    - ${m.candidate} (requested: ${m.title}; provider title: ${m.matchedTitle ?? '—'})`);
  if (result.outcome === 'PREVIEW_MATCHED') {
    console.log(`  paid enrichment: JUSTIFIED for the matched person(s) above — not performed (${opts.confirm ? 'ALLOW_PAID_ENRICHMENT_CALLS is off' : 'preview mode'}).`);
  } else if (result.outcome === 'PREVIEW_NO_MATCH') {
    console.log(`  paid enrichment: NOT justified — ${(prov.previewPeopleCount ?? 0) === 0 ? 'domain has no coverage in this provider' : 'no requested candidate matched'}. Do not spend; consider Hunter next.`);
  }
  if (result.accepted) {
    console.log(`  decision-maker:  ${result.accepted.fullName} — ${result.accepted.title}`);
    console.log(`  email:           ${result.accepted.email}`);
    console.log(`  verification:    ${result.accepted.verificationStatus} (data quality: ${result.accepted.dataQuality ?? '-'}, confidence: ${result.accepted.confidence ?? '-'})`);
  } else if (result.outcome === 'NOT_FOUND' || result.outcome === 'CAPPED' || result.outcome === 'ERROR') {
    console.log(`  decision-maker:  none accepted — fail closed (no generic/guessed fallback).`);
  }
}
