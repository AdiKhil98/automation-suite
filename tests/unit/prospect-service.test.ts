import { describe, expect, it, vi } from 'vitest';
import { ProspectService, type ProspectCandidateProcessor, type ProspectStore } from '../../src/domain/prospect/prospect-service.js';
import { type ProspectCandidateResult, type ProspectInput } from '../../src/domain/prospect/types.js';

const base: ProspectInput = { niche: 'dentists', location: 'Berlin, Germany', radiusKm: 10, targetQualified: 1, maxCandidates: 5, rankPreference: 'POPULARITY', continuePipeline: false };
const result = (outcome: ProspectCandidateResult['outcome'], overrides: Partial<ProspectCandidateResult> = {}): ProspectCandidateResult => ({ outcome, leadId: outcome === 'QUALIFIED' ? 'lead.example' : null, reason: outcome.toLowerCase(), detailsRequests: ['DUPLICATE', 'SUPPRESSED'].includes(outcome) ? 0 : 1, websiteVerifications: ['WEBSITE_TRANSIENT', 'WEBSITE_INVALID', 'QUALIFIED'].includes(outcome) ? 1 : 0, ...overrides });

function harness(results: ProspectCandidateResult[], placeIds = ['p1.example', 'p2.example', 'p3.example', 'p4.example', 'p5.example']) {
  const updates: ProspectCandidateResult[] = [];
  const store: ProspectStore = {
    start: vi.fn(async () => undefined), recordDiscoveryRequest: vi.fn(async () => 'request.example'), saveCandidates: vi.fn(async () => undefined),
    updateCandidate: vi.fn(async (_run, _position, candidate) => { updates.push(candidate) }), finish: vi.fn(async () => undefined),
  };
  let index = 0;
  const processor: ProspectCandidateProcessor = { process: vi.fn(async () => results[index++] as ProspectCandidateResult) };
  const locationResolver = { resolve: vi.fn(async () => ({ latitude: 52.52, longitude: 13.405, formattedLocation: 'Berlin, Germany', provider: 'google_places' as const, resolvedAt: new Date('2026-01-01'), externalRequests: 1 })) };
  const nearby = { discover: vi.fn(async () => ({ placeIds, requests: 1 as const })) };
  return { service: new ProspectService({ locationResolver, nearby, processor, store, limits: { maxDetails: 5, maxWebsiteVerifications: 5 } }), updates, store, processor, locationResolver, nearby };
}

describe('prospect candidate fallback', () => {
  it('skips duplicate, suppressed, failed, and no-website candidates then qualifies the next', async () => {
    const h = harness([result('DUPLICATE'), result('SUPPRESSED'), result('WEBSITE_INVALID', { failureStage: 'HTTP', failureCode: 'HTTP_404', failureElapsedMs: 800 }), result('NO_WEBSITE'), result('QUALIFIED')]);
    const summary = await h.service.run(base, 'pipeline.example');
    expect(summary.result).toBe('TARGET_REACHED'); expect(summary.processed).toBe(5); expect(summary.qualifiedLeadIds).toEqual(['lead.example']);
    expect(summary.externalCalls).toEqual({ locationResolution: 1, nearbySearch: 1, placeDetails: 3, websiteVerification: 2 });
  });

  it('stops early after targetQualified and preserves candidate order', async () => {
    const h = harness([result('QUALIFIED'), result('QUALIFIED')]);
    const summary = await h.service.run(base, 'pipeline.example');
    expect(summary.processed).toBe(1); expect(h.updates.map((x) => x.outcome)).toEqual(['QUALIFIED']);
  });

  it('stops after the candidate budget is exhausted', async () => {
    const h = harness([result('NO_WEBSITE'), result('DISQUALIFIED')], ['p1.example', 'p2.example']);
    const summary = await h.service.run({ ...base, maxCandidates: 2 }, 'pipeline.example');
    expect(summary.result).toBe('CANDIDATE_BUDGET_EXHAUSTED'); expect(summary.processed).toBe(2);
  });

  it('trips on three identical verifier failures', async () => {
    const failure = () => result('WEBSITE_TRANSIENT', { failureStage: 'DNS', failureCode: 'EAI_AGAIN', failureElapsedMs: 700 });
    const summary = await harness([failure(), failure(), failure(), result('QUALIFIED')]).service.run(base, 'pipeline.example');
    expect(summary.result).toBe('SYSTEMIC_FAILURE'); expect(summary.processed).toBe(3); expect(summary.circuitBreakerReason).toContain('DNS|EAI_AGAIN');
  });

  it('does not trip for distinct candidate-specific failures', async () => {
    const summary = await harness([
      result('WEBSITE_TRANSIENT', { failureStage: 'DNS', failureCode: 'ENOTFOUND', failureElapsedMs: 900 }),
      result('WEBSITE_INVALID', { failureStage: 'HTTP', failureCode: 'HTTP_404', failureElapsedMs: 800 }),
      result('WEBSITE_TRANSIENT', { failureStage: 'TLS', failureCode: 'CERT_EXPIRED', failureElapsedMs: 700 }), result('QUALIFIED'),
    ]).service.run(base, 'pipeline.example');
    expect(summary.result).toBe('TARGET_REACHED'); expect(summary.processed).toBe(4);
  });

  it('manual coordinates bypass location resolution', async () => {
    const h = harness([result('QUALIFIED')]);
    const summary = await h.service.run({ ...base, latitude: 52.52, longitude: 13.405 }, 'pipeline.example');
    expect(h.locationResolver.resolve).not.toHaveBeenCalled(); expect(summary.externalCalls.locationResolution).toBe(0);
  });

  it('passes only the first qualified lead to continuation and has no Gmail/send dependency', async () => {
    const continuation = { continueFirstQualified: vi.fn(async () => undefined) };
    const h = harness([result('QUALIFIED', { leadId: 'lead.one.example' })]);
    const service = new ProspectService({ locationResolver: h.locationResolver, nearby: h.nearby, processor: h.processor, store: h.store, limits: { maxDetails: 5, maxWebsiteVerifications: 5 }, continuation });
    await service.run({ ...base, continuePipeline: true }, 'pipeline.example');
    expect(continuation.continueFirstQualified).toHaveBeenCalledOnce();
    expect(continuation.continueFirstQualified).toHaveBeenCalledWith('lead.one.example', {
      prospectRunId: expect.any(String), pipelineRunId: 'pipeline.example',
    });
    expect(Object.keys(continuation)).not.toContain('send');
  });

  it('records a Nearby provider failure as systemic with the attempted call counted', async () => {
    const h = harness([]);
    h.nearby.discover.mockRejectedValueOnce(new Error('provider unavailable'));
    const summary = await h.service.run(base, 'pipeline.example');
    expect(summary).toMatchObject({ result: 'SYSTEMIC_FAILURE', discovered: 0, processed: 0, circuitBreakerReason: 'nearby_provider_failure' });
    expect(summary.externalCalls.nearbySearch).toBe(1);
    expect(h.store.finish).toHaveBeenCalledWith(expect.objectContaining({ result: 'SYSTEMIC_FAILURE', circuitBreakerReason: 'nearby_provider_failure' }));
  });
});
