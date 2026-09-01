import { createHash, randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type ContactEnrichmentProvider } from './provider.js';
import { decideAcceptance, matchPreviewPerson } from './verification.js';
import {
  type CandidatePerson,
  type ContactEnrichmentResult,
  type EnrichmentMode,
  type EnrichmentQuery,
  type PreviewPerson,
  type ProviderEnrichmentOutcome,
  type VerifiedContact,
} from './types.js';

/** Persistence port. Kept minimal so the service is unit-testable without a database. */
export interface ContactEnrichmentStore {
  findByInputHash(leadId: string, provider: string, mode: EnrichmentMode, inputHash: string): Promise<ContactEnrichmentResult | null>;
  /** `overwrite: true` replaces an existing (lead_id, provider, mode, input_hash) row instead of inserting — used only for an explicit, operator-requested `forceRefresh` run. */
  save(result: ContactEnrichmentResult, opts?: { overwrite?: boolean }): Promise<void>;
}

export interface EnrichmentRunCaps {
  maxRequests: number;
  maxCredits: number;
  /** Conservative minimum credits assumed per enrichment call when checking the cap. */
  minCreditsPerLookup: number;
}

export interface EnrichmentRunOptions {
  /** When false, run preview + local match only and STOP before any paid enrichment (no credits). */
  performEnrichment: boolean;
  /**
   * Explicit, operator-requested, one-shot bypass of the idempotency cache lookup — used ONLY when a
   * provider's capability has genuinely changed since a prior run was cached (e.g. a new fallback tier
   * added) and a fresh attempt is deliberately wanted. Does NOT change the idempotency identity/hash;
   * it only skips the read and overwrites the existing row with the fresh result. Never set by default.
   */
  forceRefresh?: boolean;
}

export interface ContactEnrichmentServiceDeps {
  provider: ContactEnrichmentProvider;
  store: ContactEnrichmentStore;
  logger: Logger;
}

export interface EnrichmentPlan {
  leadId: string;
  provider: string;
  domain: string;
  previewInputHash: string;
  enrichInputHash: string;
  orderedCandidates: CandidatePerson[];
  projectedMaxRequests: number;
  projectedMaxCredits: number;
  /** Existing idempotent row keyed to the PREVIEW mode's input hash, if any. */
  previewAlreadyResolved: ContactEnrichmentResult | null;
  /** Existing idempotent row keyed to the ENRICH mode's input hash, if any. */
  enrichAlreadyResolved: ContactEnrichmentResult | null;
}

function queryFor(domain: string, p: CandidatePerson): EnrichmentQuery {
  return { domain, fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title };
}

/**
 * Stable idempotency key over MODE + provider + domain + the ordered (name|title) candidate list.
 * Mode is part of the identity: a non-paid PREVIEW and a paid ENRICH for the same lead/domain/
 * candidates are distinct operations and must never satisfy each other's idempotency check.
 */
export function computeInputHash(mode: EnrichmentMode, provider: string, domain: string, candidates: CandidatePerson[]): string {
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
  const material = JSON.stringify({
    mode,
    provider,
    domain: domain.trim().toLowerCase(),
    people: ordered.map((c) => ({ name: c.fullName.trim().toLowerCase(), title: c.title.trim().toLowerCase() })),
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Non-secret preview-person view for provenance (name + title + domain; no email — preview has none). */
function safePreviewView(p: PreviewPerson): Record<string, unknown> {
  return { name: p.name, title: p.title, domain: p.domain };
}

/**
 * Orchestrates decision-maker work-email discovery for ONE lead using a preview-first strategy:
 *  1. NON-ENRICHING preview/search of the domain (no credit),
 *  2. local identity match (name + domain + non-conflicting title) against the priority candidates,
 *  3. PAID work-email enrichment ONLY of a matched person (when performEnrichment), accepting ONLY a
 *     provider-VERIFIED, non-generic, host-matching, identity-matching address.
 * Enforces request + credit caps, is idempotent, fails closed, never retries a provider error, never
 * writes lead_facts, and reports provider-credits separately from an internal estimate.
 */
export class ContactEnrichmentService {
  constructor(private readonly deps: ContactEnrichmentServiceDeps) {}

  async plan(leadId: string, domain: string, candidates: CandidatePerson[], caps: EnrichmentRunCaps): Promise<EnrichmentPlan> {
    const provider = this.deps.provider.name;
    const previewInputHash = computeInputHash('PREVIEW', provider, domain, candidates);
    const enrichInputHash = computeInputHash('ENRICH', provider, domain, candidates);
    const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
    const [previewAlreadyResolved, enrichAlreadyResolved] = await Promise.all([
      this.deps.store.findByInputHash(leadId, provider, 'PREVIEW', previewInputHash),
      this.deps.store.findByInputHash(leadId, provider, 'ENRICH', enrichInputHash),
    ]);
    return {
      leadId, provider, domain, previewInputHash, enrichInputHash, orderedCandidates: ordered,
      projectedMaxRequests: Math.min(caps.maxRequests, ordered.length),
      projectedMaxCredits: Math.min(caps.maxCredits, ordered.length * Math.max(1, caps.minCreditsPerLookup)),
      previewAlreadyResolved, enrichAlreadyResolved,
    };
  }

  async run(
    leadId: string,
    domain: string,
    candidates: CandidatePerson[],
    caps: EnrichmentRunCaps,
    opts: EnrichmentRunOptions,
  ): Promise<ContactEnrichmentResult> {
    const provider = this.deps.provider.name;
    const mode: EnrichmentMode = opts.performEnrichment ? 'ENRICH' : 'PREVIEW';
    const inputHash = computeInputHash(mode, provider, domain, candidates);

    if (opts.forceRefresh) {
      this.deps.logger.warn({ leadId, provider, mode }, 'contact-enrichment: force-refresh — bypassing idempotency cache lookup (explicit operator request)');
    } else {
      const existing = await this.deps.store.findByInputHash(leadId, provider, mode, inputHash);
      if (existing) {
        this.deps.logger.info({ leadId, provider, mode, outcome: existing.outcome }, 'contact-enrichment: idempotent hit; no spend');
        return existing;
      }
    }

    const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName));
    let reportedCredits: number | null = null;
    const addReported = (v: number | null): void => { if (v !== null) reportedCredits = (reportedCredits ?? 0) + v; };

    const finish = (
      outcome: ContactEnrichmentResult['outcome'],
      accepted: VerifiedContact | null,
      creditsEstimated: number,
      resourceId: string | null,
      endpoint: string | null,
      provenance: Record<string, unknown>,
    ): Promise<ContactEnrichmentResult> => {
      const result: ContactEnrichmentResult = {
        id: randomUUID(), leadId, provider, mode, inputHash, requestedDomain: domain, candidates: ordered,
        outcome, accepted, creditsEstimated, creditsReported: reportedCredits, providerResourceId: resourceId,
        endpoint, provenance, createdAt: new Date(), completedAt: new Date(),
      };
      return this.deps.store.save(result, { overwrite: opts.forceRefresh }).then(() => {
        this.deps.logger.info({ leadId, provider, outcome, creditsEstimated, creditsReported: reportedCredits }, 'contact-enrichment: run complete');
        return result;
      });
    };

    // ---- Step 1: NON-ENRICHING preview/search (no credit) ----
    let preview;
    try {
      preview = await this.deps.provider.preview(domain, ordered);
    } catch (err) {
      this.deps.logger.error({ leadId, err: err instanceof Error ? err.message : String(err) }, 'contact-enrichment: preview error (no retry)');
      return finish('ERROR', null, 0, null, null, { stage: 'preview', error: err instanceof Error ? err.message : String(err) });
    }
    addReported(preview.creditsReported);

    // ---- Step 2: local identity match against priority candidates ----
    const matches: Array<{ person: CandidatePerson; previewPerson: PreviewPerson; match: ReturnType<typeof matchPreviewPerson> }> = [];
    for (const person of ordered) {
      for (const pp of preview.people) {
        const m = matchPreviewPerson(pp, person, domain);
        if (m.isMatch) { matches.push({ person, previewPerson: pp, match: m }); break; }
      }
    }
    const previewProvenance = {
      stage: 'preview',
      previewPeopleCount: preview.people.length,
      previewPeople: preview.people.map(safePreviewView),
      matches: matches.map((m) => ({ candidate: m.person.fullName, title: m.person.title, matchedTitle: m.previewPerson.title, match: m.match })),
      creditsReportedPreview: preview.creditsReported,
    };

    if (matches.length === 0) {
      return finish('PREVIEW_NO_MATCH', null, 0, preview.resourceId, preview.endpoint, previewProvenance);
    }
    if (!opts.performEnrichment) {
      // Matched in preview, but paid enrichment not requested/allowed — report justification, spend nothing.
      return finish('PREVIEW_MATCHED', null, 0, preview.resourceId, preview.endpoint, { ...previewProvenance, enrichmentJustified: true });
    }

    // ---- Step 3: PAID work-email enrichment of matched people (priority order, within caps) ----
    const attempts: Array<Record<string, unknown>> = [];
    let creditsEstimated = 0;
    let requestsUsed = 0;
    let accepted: VerifiedContact | null = null;
    let endpoint: string | null = preview.endpoint;
    let resourceId: string | null = preview.resourceId;
    let capped = false, errored = false;

    for (const { person } of matches) {
      if (requestsUsed >= caps.maxRequests) { capped = true; break; }
      if (creditsEstimated + Math.max(1, caps.minCreditsPerLookup) > caps.maxCredits) { capped = true; break; }
      let outcome;
      try {
        outcome = await this.deps.provider.enrich(queryFor(domain, person));
      } catch (err) {
        errored = true;
        attempts.push({ person: person.fullName, error: err instanceof Error ? err.message : String(err) });
        this.deps.logger.error({ leadId, person: person.fullName }, 'contact-enrichment: enrich error (no retry)');
        break;
      }
      // Providers report actual operation/credit counts (e.g. Hunter: 1 for Finder alone, 2 when a
      // secondary Verifier call was genuinely needed); default to 1 for a provider that is always a
      // single logical operation per attempt.
      requestsUsed += outcome.requestsUsed ?? 1;
      creditsEstimated += outcome.creditsUsed ?? 1;
      addReported(outcome.creditsReported);
      endpoint = outcome.endpoint;
      if (outcome.resourceId) resourceId = outcome.resourceId;
      const decision = decideAcceptance(outcome, person, domain);
      attempts.push({
        person: person.fullName, title: person.title, verificationStatus: outcome.verificationStatus,
        accepted: decision.accepted, reason: decision.reason, match: decision.match,
        returnedIdentity: outcome.returnedIdentity, creditsReported: outcome.creditsReported, rawDigest: outcome.rawDigest,
      });
      if (decision.accepted && decision.contact) { accepted = decision.contact; break; }
    }

    // ---- Step 4: OPTIONAL final domain-wide fallback (e.g. Hunter Domain Search), AT MOST ONCE ----
    // Only reached once every matched candidate has been tried via enrich() with none accepted, and
    // only for a provider that implements this capability at all.
    let domainSearchProvenance: Record<string, unknown> | undefined;
    if (!accepted && !errored && !capped && this.deps.provider.domainSearch) {
      // Gated by BOTH caps, same as every other HTTP call this run makes: the request cap counts this
      // as one more actual HTTP call (so reaching it requires sizing maxRequests for candidates + 1,
      // e.g. 3 known candidates + 1 domain-wide call = maxRequests >= 4), and the credit cap still
      // applies to its own estimated spend on top of whatever the per-candidate loop already used.
      if (requestsUsed >= caps.maxRequests || creditsEstimated + Math.max(1, caps.minCreditsPerLookup) > caps.maxCredits) {
        capped = true;
      } else {
        try {
          const ds = await this.deps.provider.domainSearch(domain);
          requestsUsed += 1;
          creditsEstimated += ds.creditsUsed;
          addReported(ds.creditsReported);
          endpoint = ds.endpoint;
          const personalPeople = ds.people.filter((p) => p.emailType === 'personal');
          const dsAttempts: Array<Record<string, unknown>> = [];
          for (const person of ordered) {
            const match = personalPeople.find((p) => matchPreviewPerson(p, person, domain).isMatch);
            if (!match) { dsAttempts.push({ person: person.fullName, found: false }); continue; }
            const syntheticOutcome: ProviderEnrichmentOutcome = {
              query: queryFor(domain, person), email: match.email, returnedIdentity: match,
              verificationStatus: match.verificationStatus, dataQuality: null, confidence: match.confidence,
              creditsReported: null, resourceId: null, endpoint: ds.endpoint, rawDigest: ds.rawDigest,
            };
            const decision = decideAcceptance(syntheticOutcome, person, domain);
            dsAttempts.push({
              person: person.fullName, title: person.title, verificationStatus: match.verificationStatus,
              accepted: decision.accepted, reason: decision.reason, match: decision.match,
            });
            if (decision.accepted && decision.contact) { accepted = decision.contact; break; }
          }
          domainSearchProvenance = { peopleCount: ds.people.length, personalCount: personalPeople.length, attempts: dsAttempts, endpoint: ds.endpoint, rawDigest: ds.rawDigest };
        } catch (err) {
          errored = true;
          domainSearchProvenance = { error: err instanceof Error ? err.message : String(err) };
          this.deps.logger.error({ leadId, err: err instanceof Error ? err.message : String(err) }, 'contact-enrichment: domain-search error (no retry)');
        }
      }
    }

    const outcome = accepted ? 'VERIFIED' : errored ? 'ERROR' : capped ? 'CAPPED' : 'NOT_FOUND';
    return finish(outcome, accepted, creditsEstimated, resourceId, endpoint, { ...previewProvenance, stage: 'enrich', attempts, requestsUsed, caps, domainSearch: domainSearchProvenance });
  }
}
