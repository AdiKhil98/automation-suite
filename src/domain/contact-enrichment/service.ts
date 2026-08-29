import { createHash, randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type ContactEnrichmentProvider } from './provider.js';
import { decideAcceptance } from './verification.js';
import {
  type CandidatePerson,
  type ContactEnrichmentResult,
  type EnrichmentQuery,
  type VerifiedContact,
} from './types.js';

/** Persistence port. Kept minimal so the service is unit-testable without a database. */
export interface ContactEnrichmentStore {
  findByInputHash(leadId: string, provider: string, inputHash: string): Promise<ContactEnrichmentResult | null>;
  save(result: ContactEnrichmentResult): Promise<void>;
}

export interface EnrichmentRunCaps {
  maxRequests: number;
  maxCredits: number;
  /** Conservative minimum credits assumed per lookup when deciding whether the next call fits the cap. */
  minCreditsPerLookup: number;
}

export interface ContactEnrichmentServiceDeps {
  provider: ContactEnrichmentProvider;
  store: ContactEnrichmentStore;
  logger: Logger;
}

/** A pure, side-effect-free plan of what a run WOULD do. No network, no spend. */
export interface EnrichmentPlan {
  leadId: string;
  provider: string;
  domain: string;
  inputHash: string;
  orderedCandidates: CandidatePerson[];
  projectedMaxRequests: number;
  projectedMaxCredits: number;
  alreadyResolved: ContactEnrichmentResult | null;
}

function queryFor(domain: string, p: CandidatePerson): EnrichmentQuery {
  return { domain, fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title };
}

/** Stable idempotency key over provider + domain + the ordered (name|title) candidate list. */
export function computeInputHash(provider: string, domain: string, candidates: CandidatePerson[]): string {
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
  const material = JSON.stringify({
    provider,
    domain: domain.trim().toLowerCase(),
    people: ordered.map((c) => ({ name: c.fullName.trim().toLowerCase(), title: c.title.trim().toLowerCase() })),
  });
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Orchestrates decision-maker work-email enrichment for ONE lead:
 *  - tries candidates strictly in priority order,
 *  - accepts ONLY a provider-VERIFIED, non-generic, syntactically valid address,
 *  - enforces per-run request AND credit caps (stops BEFORE exceeding either),
 *  - is idempotent (a persisted result for the same inputs is returned without spending),
 *  - fails closed (no verified email -> NOT_FOUND/CAPPED, never a generic/guessed fallback),
 *  - never retries a provider error and never writes lead_facts (so no manual fact is overwritten).
 */
export class ContactEnrichmentService {
  constructor(private readonly deps: ContactEnrichmentServiceDeps) {}

  plan(leadId: string, domain: string, candidates: CandidatePerson[], caps: EnrichmentRunCaps): Promise<EnrichmentPlan> {
    const provider = this.deps.provider.name;
    const inputHash = computeInputHash(provider, domain, candidates);
    const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
    return this.deps.store.findByInputHash(leadId, provider, inputHash).then((existing) => ({
      leadId,
      provider,
      domain,
      inputHash,
      orderedCandidates: ordered,
      projectedMaxRequests: Math.min(caps.maxRequests, ordered.length),
      projectedMaxCredits: Math.min(caps.maxCredits, ordered.length * Math.max(1, caps.minCreditsPerLookup)),
      alreadyResolved: existing,
    }));
  }

  async run(
    leadId: string,
    domain: string,
    candidates: CandidatePerson[],
    caps: EnrichmentRunCaps,
  ): Promise<ContactEnrichmentResult> {
    const provider = this.deps.provider.name;
    const inputHash = computeInputHash(provider, domain, candidates);

    // Idempotency: a prior terminal result for identical inputs is returned without spending.
    const existing = await this.deps.store.findByInputHash(leadId, provider, inputHash);
    if (existing) {
      this.deps.logger.info({ leadId, provider, outcome: existing.outcome }, 'contact-enrichment: idempotent hit; no spend');
      return existing;
    }

    const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
    const attempts: Array<Record<string, unknown>> = [];
    let creditsUsed = 0;
    let requestsUsed = 0;
    let accepted: VerifiedContact | null = null;
    let endpoint: string | null = null;
    let resourceId: string | null = null;
    let capped = false;
    let errored = false;

    for (const person of ordered) {
      if (requestsUsed >= caps.maxRequests) { capped = true; break; }
      if (creditsUsed + Math.max(1, caps.minCreditsPerLookup) > caps.maxCredits) { capped = true; break; }

      let outcome;
      try {
        outcome = await this.deps.provider.enrich(queryFor(domain, person));
      } catch (err) {
        // Never auto-retry a provider error; record and fail closed.
        errored = true;
        attempts.push({ person: person.fullName, error: err instanceof Error ? err.message : String(err) });
        this.deps.logger.error({ leadId, person: person.fullName }, 'contact-enrichment: provider error (no retry)');
        break;
      }

      requestsUsed += 1;
      creditsUsed += outcome.creditsUsed;
      endpoint = outcome.endpoint;
      if (outcome.resourceId) resourceId = outcome.resourceId;

      const decision = decideAcceptance(outcome, person, domain);
      attempts.push({
        person: person.fullName,
        title: person.title,
        verificationStatus: outcome.verificationStatus,
        accepted: decision.accepted,
        reason: decision.reason,
        match: decision.match,
        returnedIdentity: outcome.returnedIdentity,
        creditsUsed: outcome.creditsUsed,
        rawDigest: outcome.rawDigest,
      });

      if (decision.accepted && decision.contact) {
        accepted = decision.contact;
        break;
      }
    }

    const outcome = accepted ? 'VERIFIED' : errored ? 'ERROR' : capped ? 'CAPPED' : 'NOT_FOUND';
    const result: ContactEnrichmentResult = {
      id: randomUUID(),
      leadId,
      provider,
      inputHash,
      requestedDomain: domain,
      candidates: ordered,
      outcome,
      accepted,
      creditsUsed,
      providerResourceId: resourceId,
      endpoint,
      provenance: { attempts, requestsUsed, caps },
      createdAt: new Date(),
      completedAt: new Date(),
    };
    await this.deps.store.save(result);
    this.deps.logger.info({ leadId, provider, outcome, creditsUsed, requestsUsed }, 'contact-enrichment: run complete');
    return result;
  }
}
