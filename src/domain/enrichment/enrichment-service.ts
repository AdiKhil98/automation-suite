import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import {
  type CandidateProvider,
  type EnrichmentContextProvider,
  type LeadEnrichmentInput,
  type WebsiteVerifier,
} from '../../integrations/enrichment/provider.js';
import { type FactType, type LeadFact, type NewLeadFact } from '../lead-facts/lead-fact.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { normalizeDomain } from '../leads/normalize.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { resolveFactWrite } from './fact-conflict.js';
import { type EnrichmentOutcome, routeOutcome } from './outcome.js';
import { type CandidateVerification, type EnrichmentContext } from './types.js';
import { decideOutcome, type VerifyOptions } from './verify-domain.js';

/** Persisted enrichment attempt (no provider-restricted content). */
export interface NewEnrichmentAttempt {
  leadId: string;
  runId: string;
  outcome: EnrichmentOutcome;
  chosenDomain: string | null;
  chosenWebsiteUrl: string | null;
  chosenLocationPageUrl: string | null;
  confidence: number | null;
  candidateCount: number;
  contextProvider: string;
  candidateProvider: string;
  notes: string | null;
  startedAt: Date;
  completedAt: Date;
}

// Ports (domain-typed; persistence repositories satisfy these structurally).
export interface EnrichmentFactStore {
  getCurrentFact(leadId: string, factType: FactType): Promise<LeadFact | null>;
  writeCurrentFact(fact: NewLeadFact): Promise<string>;
}
export interface EnrichmentAttemptStore {
  recordAttempt(attempt: NewEnrichmentAttempt): Promise<string>;
  recordCandidates(
    attemptId: string,
    verifications: CandidateVerification[],
    linkFor: (matchedFactType: FactType | null) => string | null,
  ): Promise<void>;
}
export interface EnrichmentLeadStore extends LeadStore {
  updateProjection(id: string, patch: { domain?: string | null; normalizedDomain?: string | null }): Promise<void>;
}
export interface EnrichmentEventRecorder {
  record(event: NewPipelineEvent): Promise<void>;
}

export interface EnrichmentTxRepos {
  leads: EnrichmentLeadStore;
  leadService: LeadService;
  facts: EnrichmentFactStore;
  enrichment: EnrichmentAttemptStore;
  events: EnrichmentEventRecorder;
}
export interface EnrichmentUnitOfWork {
  transaction<T>(fn: (repos: EnrichmentTxRepos) => Promise<T>): Promise<T>;
}

export interface EnrichmentServiceDeps {
  contextProvider: EnrichmentContextProvider;
  factsContextProvider: EnrichmentContextProvider;
  candidateProvider: CandidateProvider;
  verifier: WebsiteVerifier;
  uow: EnrichmentUnitOfWork;
  logger: Logger;
}

export interface EnrichmentResult {
  leadId: string;
  outcome: EnrichmentOutcome;
  conflict: boolean;
  factsWritten: number;
}

const registrable = (host: string | null): string | null =>
  host ? host.toLowerCase().replace(/^www\./, '') : null;

function mergeContexts(a: EnrichmentContext | null, b: EnrichmentContext | null): EnrichmentContext | null {
  if (!a && !b) return null;
  return {
    businessName: a?.businessName ?? b?.businessName ?? null,
    phone: a?.phone ?? b?.phone ?? null,
    formattedAddress: a?.formattedAddress ?? b?.formattedAddress ?? null,
    city: a?.city ?? b?.city ?? null,
    country: a?.country ?? b?.country ?? null,
    candidateUrls: [...(a?.candidateUrls ?? []), ...(b?.candidateUrls ?? [])],
  };
}

function isParseableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export class EnrichmentService {
  constructor(private readonly deps: EnrichmentServiceDeps) {}

  async enrich(input: LeadEnrichmentInput, runId: string, opts: VerifyOptions): Promise<EnrichmentResult> {
    const startedAt = new Date();

    // ---- Phase A: discovery + verification (no DB transaction held) ----
    const base = await this.deps.factsContextProvider.contextFor(input);
    const primary =
      this.deps.contextProvider.name === this.deps.factsContextProvider.name
        ? base
        : await this.deps.contextProvider.contextFor(input);
    const context = mergeContexts(primary, base);

    let outcome: EnrichmentOutcome;
    let winner: CandidateVerification | null = null;
    let verifications: CandidateVerification[] = [];
    let candidateCount = 0;

    if (!context) {
      outcome = 'INSUFFICIENT_CONTEXT';
    } else {
      const candidates = await this.deps.candidateProvider.candidatesFor(input, context);
      candidateCount = candidates.length;
      if (candidates.length === 0) {
        outcome = 'NO_CANDIDATE';
      } else if (candidates.every((c) => !isParseableUrl(c.url))) {
        outcome = 'INVALID_INPUT';
      } else {
        const report = await this.deps.verifier.verify(candidates, context);
        verifications = report.verifications;
        if (verifications.length > 0) {
          const decided = decideOutcome(verifications, opts);
          outcome = decided.outcome;
          winner = decided.winner;
        } else if (report.fetchKinds.includes('policy_blocked')) {
          outcome = 'POLICY_BLOCKED';
        } else if (report.fetchKinds.includes('transient')) {
          outcome = 'TRANSIENT_ERROR';
        } else {
          outcome = 'NO_VERIFIED_CANDIDATE';
        }
      }
    }
    const completedAt = new Date();

    // ---- Phase B: one atomic transaction ----
    return this.deps.uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(input.leadId);
      if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead not found: ${input.leadId}`);
      if (lead.status !== 'READY_FOR_ENRICHMENT') {
        throw new AppError('NOT_ENRICHABLE', `Lead ${input.leadId} not in READY_FOR_ENRICHMENT`);
      }

      const factIdByType = new Map<FactType, string>();
      let conflict = false;
      let factsWritten = 0;
      let locationPageUrl: string | null = null;

      if (outcome === 'VERIFIED' && winner) {
        for (const f of winner.facts) {
          if (f.factType === 'official_location_page_url') locationPageUrl = f.value;
          const existing = await repos.facts.getCurrentFact(input.leadId, f.factType);
          const res = resolveFactWrite(existing, f, 'website');
          if (res.action === 'insert' || res.action === 'supersede') {
            const id = await repos.facts.writeCurrentFact({
              leadId: input.leadId,
              factType: f.factType,
              value: f.value,
              normalizedValue: f.normalizedValue,
              sourceType: 'website',
              sourceUrl: f.sourceUrl,
              confidence: f.confidence,
            });
            factIdByType.set(f.factType, id);
            factsWritten += 1;
          } else {
            if (existing) factIdByType.set(f.factType, existing.id);
            if (res.action === 'conflict') conflict = true;
          }
        }
      }

      const attemptId = await repos.enrichment.recordAttempt({
        leadId: input.leadId,
        runId,
        outcome,
        chosenDomain: outcome === 'VERIFIED' ? registrable(winner?.host ?? null) : null,
        chosenWebsiteUrl: outcome === 'VERIFIED' ? (winner?.finalUrl ?? null) : null,
        chosenLocationPageUrl: outcome === 'VERIFIED' ? locationPageUrl : null,
        confidence: winner?.confidence ?? null,
        candidateCount,
        contextProvider: this.deps.contextProvider.name,
        candidateProvider: this.deps.candidateProvider.name,
        notes: conflict ? 'manual/website fact conflict' : null,
        startedAt,
        completedAt,
      });

      await repos.enrichment.recordCandidates(attemptId, verifications, (t) =>
        t ? (factIdByType.get(t) ?? null) : null,
      );

      if (outcome === 'VERIFIED' && winner) {
        const domainFact = winner.facts.find((x) => x.factType === 'official_domain');
        if (domainFact) {
          await repos.leads.updateProjection(input.leadId, {
            domain: domainFact.value,
            normalizedDomain: normalizeDomain(domainFact.value),
          });
        }
      }

      let message = `enrichment: ${outcome}`;
      if (outcome === 'VERIFIED' && !conflict) {
        await repos.leadService.transition(input.leadId, 'ENRICHED');
        await repos.leadService.transition(input.leadId, 'READY_FOR_QUALIFICATION');
      } else {
        if (conflict) message = 'enrichment: VERIFIED with manual/website conflict — routed to manual review';
        if (outcome === 'BROWSER_REQUIRED') {
          message = 'enrichment: BROWSER_REQUIRED — Phase 5 browser verification required';
        }
        const target = conflict ? ('NEEDS_MANUAL_REVIEW' as const) : routeOutcome(outcome);
        if (target) await repos.leadService.transition(input.leadId, target);
      }

      await repos.events.record({
        leadId: input.leadId,
        runId,
        type: 'NOTE',
        fromStatus: null,
        toStatus: null,
        message,
        data: { attemptId, outcome, candidateCount, factsWritten },
      });

      return { leadId: input.leadId, outcome, conflict, factsWritten };
    });
  }
}
