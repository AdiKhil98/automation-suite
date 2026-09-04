import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildResultRecord,
  computeExtractionFingerprint,
  decideAttempt,
  emptyManifest,
  EXTRACTION_PIPELINE_VERSION,
  MAX_PAID_ATTEMPTS_PER_FINGERPRINT,
  readResultsManifestIfExists,
  saveResultsManifest,
  type ExtractionResultRecord,
} from '../../src/domain/decision-makers/results-manifest.js';
import { type ExtractionCallMetadata } from '../../src/domain/decision-makers/service.js';
import { type EvidencePage } from '../../src/domain/decision-makers/website-evidence.js';

let dir: string | null = null;
function tempPath(name = 'results.json'): string {
  dir = mkdtempSync(join(tmpdir(), 'dm-results-'));
  return join(dir, name);
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const PAGES: EvidencePage[] = [
  { role: 'home', url: 'https://example.com/', text: 'Example Dental.' },
  { role: 'team', url: 'https://example.com/team', text: 'Dr A B, Principal Dentist.' },
];

const BASE = {
  leadId: 'lead-1',
  officialDomain: 'example.com',
  pages: PAGES,
  promptVersion: 'decision-maker-extractor-2',
  schemaVersion: 'decision-maker-schema-2',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  minConfidence: 0.6,
};

const CALL: ExtractionCallMetadata = {
  provider: 'openai', requestedModel: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol',
  requestId: 'req_1', responseId: 'res_1', llmCalls: 1,
  inputTokens: 4000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 50, totalTokens: 4200,
  estimatedCostUsd: 0.0175, latencyMs: 900, failureCategory: 'none',
};

const AT = new Date('2026-09-05T10:00:00.000Z');

function record(over: Partial<ExtractionResultRecord> = {}): ExtractionResultRecord {
  return {
    fingerprint: 'fp-1', outcome: 'NO_CANDIDATE', attempts: 1,
    firstAttemptAt: AT.toISOString(), lastAttemptAt: AT.toISOString(),
    acceptedCount: 0, totalCostUsd: 0.0175, lastCall: null, note: null,
    ...over,
  };
}

describe('computeExtractionFingerprint', () => {
  it('is deterministic for identical input', () => {
    expect(computeExtractionFingerprint(BASE)).toBe(computeExtractionFingerprint(BASE));
  });

  it('is insensitive to page object identity but sensitive to page content', () => {
    const cloned = { ...BASE, pages: PAGES.map((p) => ({ ...p })) };
    expect(computeExtractionFingerprint(cloned)).toBe(computeExtractionFingerprint(BASE));

    const changedText = { ...BASE, pages: [PAGES[0]!, { ...PAGES[1]!, text: 'Dr C D, Principal Dentist.' }] };
    expect(computeExtractionFingerprint(changedText)).not.toBe(computeExtractionFingerprint(BASE));
  });

  it('changes when the page set, prompt, schema, pipeline, model, provider or threshold changes', () => {
    const base = computeExtractionFingerprint(BASE);
    expect(computeExtractionFingerprint({ ...BASE, pages: [PAGES[0]!] })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, promptVersion: 'decision-maker-extractor-3' })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, schemaVersion: 'decision-maker-schema-3' })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, model: 'gpt-5.6-other' })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, provider: 'mock' })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, minConfidence: 0.5 })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, officialDomain: 'other.com' })).not.toBe(base);
    expect(computeExtractionFingerprint({ ...BASE, leadId: 'lead-2' })).not.toBe(base);
  });

  it('normalizes domain case/whitespace so cosmetic differences do not re-charge', () => {
    expect(computeExtractionFingerprint({ ...BASE, officialDomain: ' Example.COM ' })).toBe(computeExtractionFingerprint(BASE));
  });

  it('embeds the pipeline version so deterministic-filter changes can invalidate records', () => {
    expect(EXTRACTION_PIPELINE_VERSION).toBe('dm-pipeline-1');
  });

  it('contains no timestamp or other nondeterministic material', async () => {
    const first = computeExtractionFingerprint(BASE);
    await new Promise((r) => setTimeout(r, 5));
    expect(computeExtractionFingerprint(BASE)).toBe(first);
  });
});

describe('decideAttempt', () => {
  it('attempts when nothing is recorded', () => {
    expect(decideAttempt(undefined, 'fp-1', false)).toEqual({ attempt: true, reason: 'no_record' });
  });

  it('FOUND and NO_CANDIDATE are terminal at the same fingerprint', () => {
    expect(decideAttempt(record({ outcome: 'FOUND' }), 'fp-1', false)).toEqual({ attempt: false, reason: 'already_found' });
    expect(decideAttempt(record({ outcome: 'NO_CANDIDATE' }), 'fp-1', false)).toEqual({ attempt: false, reason: 'no_candidate_recorded' });
  });

  it('SCHEMA_INVALID is blocked at the same fingerprint — no automatic repeat spend', () => {
    expect(decideAttempt(record({ outcome: 'SCHEMA_INVALID' }), 'fp-1', false)).toEqual({ attempt: false, reason: 'schema_invalid_blocked' });
  });

  it('PROVIDER_ERROR retries once more, then stops at the attempt cap', () => {
    expect(decideAttempt(record({ outcome: 'PROVIDER_ERROR', attempts: 1 }), 'fp-1', false)).toEqual({ attempt: true, reason: 'retry_provider_error' });
    expect(decideAttempt(record({ outcome: 'PROVIDER_ERROR', attempts: MAX_PAID_ATTEMPTS_PER_FINGERPRINT }), 'fp-1', false))
      .toEqual({ attempt: false, reason: 'provider_error_attempts_exhausted' });
  });

  it('any changed fingerprint re-opens every terminal outcome', () => {
    for (const outcome of ['FOUND', 'NO_CANDIDATE', 'SCHEMA_INVALID', 'PROVIDER_ERROR'] as const) {
      expect(decideAttempt(record({ outcome, attempts: 9 }), 'fp-CHANGED', false)).toEqual({ attempt: true, reason: 'fingerprint_changed' });
    }
  });

  it('--refresh overrides every terminal and exhausted state', () => {
    expect(decideAttempt(record({ outcome: 'FOUND' }), 'fp-1', true)).toEqual({ attempt: true, reason: 'operator_refresh' });
    expect(decideAttempt(record({ outcome: 'PROVIDER_ERROR', attempts: 99 }), 'fp-1', true)).toEqual({ attempt: true, reason: 'operator_refresh' });
  });
});

describe('buildResultRecord', () => {
  it('counts a paid attempt and accumulates spend at the same fingerprint', () => {
    const first = buildResultRecord({ previous: undefined, fingerprint: 'fp-1', outcome: 'PROVIDER_ERROR', acceptedCount: 0, call: CALL, note: 'rate_limited', now: AT });
    expect(first).toMatchObject({ attempts: 1, totalCostUsd: 0.0175, outcome: 'PROVIDER_ERROR' });

    const later = new Date('2026-09-05T11:00:00.000Z');
    const second = buildResultRecord({ previous: first, fingerprint: 'fp-1', outcome: 'PROVIDER_ERROR', acceptedCount: 0, call: CALL, note: 'rate_limited', now: later });
    expect(second.attempts).toBe(2);
    expect(second.totalCostUsd).toBeCloseTo(0.035, 6);
    expect(second.firstAttemptAt).toBe(AT.toISOString());
    expect(second.lastAttemptAt).toBe(later.toISOString());
  });

  it('resets attempts and spend when the fingerprint changes', () => {
    const first = buildResultRecord({ previous: undefined, fingerprint: 'fp-1', outcome: 'PROVIDER_ERROR', acceptedCount: 0, call: CALL, note: null, now: AT });
    const changed = buildResultRecord({ previous: first, fingerprint: 'fp-2', outcome: 'NO_CANDIDATE', acceptedCount: 0, call: CALL, note: null, now: AT });
    expect(changed).toMatchObject({ attempts: 1, totalCostUsd: 0.0175, fingerprint: 'fp-2' });
  });

  it('a request that never completed does not consume a paid attempt', () => {
    const rec = buildResultRecord({ previous: undefined, fingerprint: 'fp-1', outcome: 'PROVIDER_ERROR', acceptedCount: 0, call: null, note: 'timeout', now: AT });
    expect(rec).toMatchObject({ attempts: 0, totalCostUsd: 0, lastCall: null });
    // ...and stays eligible, because the attempt cap was never touched.
    expect(decideAttempt(rec, 'fp-1', false).attempt).toBe(true);
  });

  it('persists only safe call metadata — no raw output, prompt or secrets', () => {
    const rec = buildResultRecord({ previous: undefined, fingerprint: 'fp-1', outcome: 'FOUND', acceptedCount: 2, call: CALL, note: null, now: AT });
    expect(Object.keys(rec.lastCall ?? {}).sort()).toEqual([
      'estimatedCostUsd', 'failureCategory', 'inputTokens', 'outputTokens', 'provider',
      'requestId', 'requestedModel', 'resolvedModel', 'totalTokens',
    ]);
  });
});

describe('manifest IO', () => {
  it('returns an empty manifest when the file does not exist, and round-trips a write', () => {
    const path = tempPath();
    expect(readResultsManifestIfExists(path)).toEqual(emptyManifest());

    const m = emptyManifest();
    m.results['lead-1'] = record();
    saveResultsManifest(path, m);
    expect(readResultsManifestIfExists(path)).toEqual(m);
  });

  it('writes atomically: no .tmp file is left behind', () => {
    const path = tempPath();
    saveResultsManifest(path, emptyManifest());
    expect(() => readFileSync(`${path}.tmp`, 'utf8')).toThrow();
  });

  it('fails closed on a corrupt manifest rather than silently re-charging every lead it covers', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => readResultsManifestIfExists(path)).toThrow(/RESULTS_MANIFEST_INVALID_JSON|not valid JSON/);

    writeFileSync(path, JSON.stringify({ version: 1, results: { 'lead-1': { outcome: 'WAT' } } }), 'utf8');
    expect(() => readResultsManifestIfExists(path)).toThrow(/RESULTS_MANIFEST_INVALID_SHAPE|unexpected shape/);
  });
});
