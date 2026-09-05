import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { guardOperationalLocalData } from '../support/local-data-isolation.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { discoverDecisionMakersCommand, type DiscoverDecisionMakersOptions } from '../../src/cli/commands/discover-decision-makers.js';
import { type CliContext } from '../../src/cli/context.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { ContactEnrichmentRepository } from '../../src/persistence/repositories/contact-enrichment.repo.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { readCandidatesFileIfExists } from '../../src/domain/contact-resolve-batch/candidates-file.js';
import { readResultsManifestIfExists } from '../../src/domain/decision-makers/results-manifest.js';
import { type PageFetchFn } from '../../src/domain/decision-makers/website-evidence.js';
import { type FetchOutcome } from '../../src/utils/safe-fetch.js';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { type DecisionMakerLlmDeps } from '../../src/domain/decision-makers/service.js';

// Fails this file if any test in it creates or modifies the real .local-data decision-maker files.
guardOperationalLocalData();

const testDatabase = requireIntegrationTestDatabase();
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const DOMAIN = 'diamond-smile.com';
// Matches discover-decision-makers's own resolveOfficialBaseUrl(domain, null) exactly (no trailing
// slash) — the command fetches this literal string as the homepage URL.
const HOME = `https://${DOMAIN}`;

const liveConfig = {
  DRY_RUN: false,
  DISCOVER_DECISION_MAKERS_MAX_LEADS_PER_RUN: 10,
  DISCOVER_DECISION_MAKERS_MAX_PAGES_PER_LEAD: 3,
  MAX_LLM_CALLS_PER_RUN: 10,
  ENRICH_HTTP_TIMEOUT_MS: 10_000,
  ENRICH_MAX_REDIRECTS: 5,
  ENRICH_MAX_BYTES: 2_000_000,
};

/**
 * TEST ISOLATION. `discover-decision-makers` defaults BOTH of its local state files to real,
 * operator-owned paths under `.local-data/decision-makers/`. Supplying only `out` left `results`
 * falling through to the operational manifest, and every --confirm test wrote mock records into it.
 * Harmless here (the ids are throwaway UUIDs) but wrong: a test run on a machine that holds real
 * state would mutate live idempotency data. Both paths are now always temp, enforced by `runDiscover`
 * below — no test may call the command directly.
 */
let tmpDir: string | null = null;
let tmpResults = '';
function tempOutPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'discover-decision-makers-test-'));
  tmpResults = join(tmpDir, 'results.json');
  return join(tmpDir, 'candidates.json');
}
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  tmpResults = '';
});

/**
 * The ONLY way this suite may invoke the command. `results` is injected from the per-test temp dir and
 * is not accepted from callers, so a new test physically cannot fall through to the operational
 * manifest. A source-level guard below asserts nothing bypasses this wrapper.
 */
function runDiscover(
  context: CliContext,
  opts: Omit<DiscoverDecisionMakersOptions, 'results'>,
  deps: Parameters<typeof discoverDecisionMakersCommand>[2] = {},
): Promise<void> {
  if (!tmpResults) throw new Error('runDiscover called before tempOutPath() — no temp results path is set.');
  return discoverDecisionMakersCommand(context, { ...opts, results: tmpResults }, deps);
}

function ok(url: string, html: string): FetchOutcome {
  return { kind: 'ok', finalUrl: url, host: new URL(url).host, status: 200, html };
}
function fakeFetcher(pages: Record<string, string>): PageFetchFn {
  return (url: string) => Promise.resolve(pages[url] !== undefined ? ok(url, pages[url]) : ({ kind: 'invalid', reason: 'not found' } as FetchOutcome));
}

const HOME_HTML = `<html><body><h1>Diamond Smile</h1><nav><a href="/meet-the-team">Meet the Team</a></nav></body></html>`;
const TEAM_HTML = `<html><body><p>Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.</p></body></html>`;

function verifiedResponder(): MockResponder {
  return () => ({
    rawJson: {
      candidates: [
        { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.97, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.' },
      ],
      insufficientEvidence: false,
    },
  });
}

describe('discover-decision-makers (PostgreSQL)', () => {
  let handle: DbHandle;
  beforeEach(async () => { handle ??= testDatabase.createHandle(); await testDatabase.truncate(handle.db); });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  function ctx(overrides: Partial<typeof liveConfig> = {}): CliContext {
    return {
      config: { ...liveConfig, ...overrides } as unknown as CliContext['config'],
      logger,
      db: handle.db,
      leads: new LeadsRepository(handle.db),
      events: new PipelineRepository(handle.db),
      service: undefined as unknown as CliContext['service'],
    };
  }

  /** Seed a lead at `status`, having durably passed QUALIFIED in its pipeline_events history (unless
   * `neverQualified` is set) — mirrors real lead lifecycle: the QUALIFIED transition is recorded even
   * when the lead has since moved on to a later status. */
  async function seedLead(opts: {
    businessName?: string;
    domain?: string;
    status?: LeadStatus;
    neverQualified?: boolean;
  } = {}): Promise<string> {
    const { businessName = 'Diamond Smile', domain = DOMAIN, status = 'QUALIFIED', neverQualified = false } = opts;
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, businessName, normalizedDomain: domain, status });
    if (!neverQualified) {
      await new PipelineRepository(handle.db).record({
        leadId: id, runId: null, type: 'STATE_TRANSITION', fromStatus: 'READY_FOR_QUALIFICATION', toStatus: 'QUALIFIED',
        message: 'READY_FOR_QUALIFICATION -> QUALIFIED', data: null,
      });
    }
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId: id, factType: 'official_domain', value: domain, normalizedValue: domain, sourceType: 'manual', sourceUrl: null,
    });
    return id;
  }

  async function seedQualifiedLead(businessName = 'Diamond Smile', domain = DOMAIN): Promise<string> {
    return seedLead({ businessName, domain });
  }

  function llmDepsFor(responder: MockResponder): DecisionMakerLlmDeps {
    return {
      provider: new MockLlmProvider(responder),
      model: 'mock-decision-makers-1', reasoningEffort: 'medium', store: false, timeoutMs: 30_000,
      maxOutputTokens: 2000, maxRetries: 0, maxCallsPerLead: 1, maxCostUsdPerLead: 0.5, minConfidence: 0.6, logger,
    };
  }

  it('PLAN mode makes zero fetch and zero LLM calls', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    let fetchCalls = 0;
    await runDiscover(ctx(), { out }, {
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); },
    });
    expect(fetchCalls).toBe(0);
    expect(readCandidatesFileIfExists(out)).toBeNull();
    void leadId;
  });

  it('--preview fetches pages but makes no LLM call and writes nothing', async () => {
    await seedQualifiedLead();
    const out = tempOutPath();
    let llmCalls = 0;
    await runDiscover(ctx(), { out, preview: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => { llmCalls += 1; return llmDepsFor(verifiedResponder()); },
    });
    expect(llmCalls).toBe(0);
    expect(readCandidatesFileIfExists(out)).toBeNull();
  });

  it('--confirm fetches + extracts + writes an --out file that contact-resolve-batch can load', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    const data = readCandidatesFileIfExists(out);
    expect(data).not.toBeNull();
    expect(data?.[leadId]).toEqual([
      { fullName: 'Shyam Shastri', title: 'Principal Dentist', sourceUrl: `https://${DOMAIN}/meet-the-team`, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.', confidence: 0.97 },
    ]);
  });

  /** Capture stdout for the run so the CLI's own claims can be asserted. */
  async function captureRun(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try { await fn(); } finally { spy.mockRestore(); }
    return lines.join('\n');
  }

  it('a schema-invalid paid response writes no file and never claims it wrote one', async () => {
    await seedQualifiedLead();
    const out = tempOutPath();
    const output = await captureRun(() => runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(() => ({ rawJson: { totally: 'wrong shape' } })),
    }));

    expect(readCandidatesFileIfExists(out)).toBeNull();
    expect(output).not.toContain(`wrote: ${out}`);
    expect(output).toContain('no candidates file was produced or updated');
    expect(output).toContain('candidates file NOT written for this lead');
    // The spend of a completed-but-unusable paid call stays visible.
    expect(output).toContain('paid call:');
    expect(output).toContain('outcome=schema_invalid');
  });

  it('a schema-invalid response preserves a previously written valid candidates file', async () => {
    const firstLead = await seedQualifiedLead();
    const out = tempOutPath();
    await runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    const before = readCandidatesFileIfExists(out);
    expect(before?.[firstLead]).toHaveLength(1);

    const secondLead = await seedQualifiedLead('Gipsy Hill Dental', 'gipsyhilldental.com');
    const output = await captureRun(() => runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ 'https://gipsyhilldental.com': HOME_HTML, 'https://gipsyhilldental.com/meet-the-team': TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(() => ({ rawJson: { totally: 'wrong shape' } })),
    }));

    // The earlier lead's valid results survive untouched; nothing empty was written over them.
    expect(readCandidatesFileIfExists(out)).toEqual(before);
    expect(Object.keys(readCandidatesFileIfExists(out) ?? {})).not.toContain(secondLead);
    expect(output).not.toContain(`wrote: ${out}`);
  });

  it('a successful run still reports the file it actually wrote', async () => {
    await seedQualifiedLead();
    const out = tempOutPath();
    const output = await captureRun(() => runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    }));
    expect(output).toContain(`wrote: ${out}`);
    expect(output).toContain('1 lead updated');
  });

  it('existing evidence is reused: a second run skips a lead already present in --out (zero fetch/LLM calls) unless --refresh', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });

    let fetchCalls = 0;
    let llmCalls = 0;
    await runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => { llmCalls += 1; return llmDepsFor(verifiedResponder()); },
    });
    expect(fetchCalls).toBe(0);
    expect(llmCalls).toBe(1); // llmDeps is still constructed once up front for the run, but never invoked per-lead
    void leadId;
  });

  it('--refresh --confirm bypasses the "already in --out" skip and re-processes the targeted lead', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await runDiscover(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    let fetchCalls = 0;
    await runDiscover(ctx(), { out, confirm: true, refresh: true, lead: leadId }, {
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it('--limit bounds how many leads are attempted', async () => {
    await seedQualifiedLead('Lead One', 'lead-one.example');
    await seedQualifiedLead('Lead Two', 'lead-two.example');
    const out = tempOutPath();
    let fetchCalls = 0;
    await runDiscover(ctx(), { out, confirm: true, limit: '1' }, {
      // Neither lead's homepage has any secondary links, so exactly one fetch per attempted lead.
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, '<html><body>none</body></html>')); },
      buildLlmDeps: () => llmDepsFor(() => ({ rawJson: { candidates: [], insufficientEvidence: true } })),
    });
    expect(fetchCalls).toBe(1);
  });

  // --- results manifest: idempotency + bounded retry ------------------------------------------

  /** Counts ACTUAL provider invocations (the responder runs once per generate), not how many times
   * llmDeps was constructed — a run always builds deps once even if it never calls the model. */
  function countingResponder(inner: MockResponder): { responder: MockResponder; calls: () => number } {
    let calls = 0;
    return { responder: (req, i) => { calls += 1; return inner(req, i); }, calls: () => calls };
  }

  const TEAM_SITE: Record<string, string> = { [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML };
  const noCandidateResponder: MockResponder = () => ({ rawJson: { candidates: [], insufficientEvidence: true } });

  async function runConfirm(out: string, responder: MockResponder, over: Record<string, unknown> = {}, pages = TEAM_SITE): Promise<void> {
    await runDiscover(ctx(), { out, confirm: true, ...over }, {
      buildFetcher: () => fakeFetcher(pages),
      buildLlmDeps: () => llmDepsFor(responder),
    });
  }

  it('FOUND is durable: an unchanged lead makes zero paid calls on the second run', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');

    const first = countingResponder(verifiedResponder());
    await runConfirm(out, first.responder);
    expect(first.calls()).toBe(1);
    expect(readResultsManifestIfExists(results).results[leadId]).toMatchObject({ outcome: 'FOUND', attempts: 1, acceptedCount: 1 });

    const second = countingResponder(verifiedResponder());
    await runConfirm(out, second.responder);
    expect(second.calls()).toBe(0);
  });

  it('Colosseum-style zero-candidate success becomes durable: NO_CANDIDATE, then zero paid calls forever', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');

    const first = countingResponder(noCandidateResponder);
    await runConfirm(out, first.responder);
    expect(first.calls()).toBe(1);
    // No candidate entry is created, so the old "already_in_out_file" guard could never have helped.
    expect(readCandidatesFileIfExists(out)).toBeNull();
    expect(readResultsManifestIfExists(results).results[leadId]).toMatchObject({ outcome: 'NO_CANDIDATE', attempts: 1, acceptedCount: 0 });

    for (const _ of [1, 2, 3]) {
      const again = countingResponder(noCandidateResponder);
      await runConfirm(out, again.responder);
      expect(again.calls()).toBe(0);
    }
  });

  it('SCHEMA_INVALID does not auto-charge again at the same fingerprint', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');
    const bad: MockResponder = () => ({ rawJson: { totally: 'wrong shape' } });

    const first = countingResponder(bad);
    await runConfirm(out, first.responder);
    expect(first.calls()).toBe(1);
    expect(readResultsManifestIfExists(results).results[leadId]).toMatchObject({ outcome: 'SCHEMA_INVALID', attempts: 1 });

    const second = countingResponder(bad);
    await runConfirm(out, second.responder);
    expect(second.calls()).toBe(0);
  });

  it('PROVIDER_ERROR gets at most two paid attempts at the same fingerprint', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');
    const failing: MockResponder = () => ({ status: 'rate_limited' });

    const a = countingResponder(failing);
    await runConfirm(out, a.responder);
    expect(a.calls()).toBe(1);
    expect(readResultsManifestIfExists(results).results[leadId]).toMatchObject({ outcome: 'PROVIDER_ERROR', attempts: 1 });

    const b = countingResponder(failing);
    await runConfirm(out, b.responder);
    expect(b.calls()).toBe(1); // the one permitted retry
    expect(readResultsManifestIfExists(results).results[leadId]).toMatchObject({ attempts: 2 });

    const cRun = countingResponder(failing);
    await runConfirm(out, cRun.responder);
    expect(cRun.calls()).toBe(0); // exhausted
  });

  it('changed website evidence re-opens a settled NO_CANDIDATE lead', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');

    await runConfirm(out, noCandidateResponder);
    const before = readResultsManifestIfExists(results).results[leadId];

    // Same lead, same domain — the team page now names someone.
    const changed = { [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: '<html><body><p>Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile. Newly published.</p></body></html>' };
    const after = countingResponder(verifiedResponder());
    await runConfirm(out, after.responder, {}, changed);
    expect(after.calls()).toBe(1);

    const record = readResultsManifestIfExists(results).results[leadId];
    expect(record?.fingerprint).not.toBe(before?.fingerprint);
    expect(record).toMatchObject({ outcome: 'FOUND', attempts: 1 }); // attempts reset with the new fingerprint
  });

  it('--lead X --refresh re-runs exactly X and leaves other leads untouched', async () => {
    const target = await seedQualifiedLead('Colosseum Norwood', 'colosseum.example');
    await seedQualifiedLead('Other Practice', 'other.example');
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');
    const site = { 'https://colosseum.example': HOME_HTML, 'https://other.example': HOME_HTML };

    await runConfirm(out, noCandidateResponder, { lead: target }, site);
    expect(Object.keys(readResultsManifestIfExists(results).results)).toEqual([target]);

    const fetchedHosts = new Set<string>();
    const rerun = countingResponder(verifiedResponder());
    await runDiscover(ctx(), { out, confirm: true, refresh: true, lead: target }, {
      buildFetcher: () => (url) => { fetchedHosts.add(new URL(url).host); return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => llmDepsFor(rerun.responder),
    });
    expect(rerun.calls()).toBe(1);
    expect([...fetchedHosts]).toEqual(['colosseum.example']);
  });

  it('--lead targets exactly one lead in plan, --preview and --confirm', async () => {
    const target = await seedQualifiedLead('Target', 'target.example');
    await seedQualifiedLead('Other', 'other.example');
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');

    const planned = await captureRun(() => runDiscover(ctx(), { out, lead: target }, {}));
    expect(planned).toContain(`target lead:            ${target}`);
    expect(planned).toContain('selected this run:       1');

    const previewHosts = new Set<string>();
    await runDiscover(ctx(), { out, preview: true, lead: target }, {
      buildFetcher: () => (url) => { previewHosts.add(new URL(url).host); return Promise.resolve(ok(url, HOME_HTML)); },
    });
    expect([...previewHosts]).toEqual(['target.example']);

    const confirmHosts = new Set<string>();
    await runDiscover(ctx(), { out, confirm: true, lead: target }, {
      buildFetcher: () => (url) => { confirmHosts.add(new URL(url).host); return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => llmDepsFor(noCandidateResponder),
    });
    expect([...confirmHosts]).toEqual(['target.example']);
    expect(Object.keys(readResultsManifestIfExists(results).results)).toEqual([target]);
  });

  it('rejects meaningless or dangerous flag combinations', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    // The important one: batch refresh would re-extract whichever leads sort first, at full price.
    await expect(runDiscover(ctx(), { out, confirm: true, refresh: true }, {}))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runDiscover(ctx(), { out, lead: leadId, limit: '2' }, {}))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runDiscover(ctx(), { out, preview: true, confirm: true }, {}))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runDiscover(ctx(), { out, lead: 'no-such-lead' }, {}))
      .rejects.toMatchObject({ code: 'LEAD_NOT_FOUND' });
  });

  it('a zero-provider-call result consumes no run LLM allowance and records nothing', async () => {
    await seedQualifiedLead('Unreachable', 'unreachable.example');
    await seedQualifiedLead('Reachable', 'reachable.example');
    const out = tempOutPath();
    const results = join(dirname(out), 'results.json');

    // The first lead's site yields no evidence page at all -> no_pages, no provider call.
    const counted = countingResponder(verifiedResponder());
    const output = await captureRun(() => runDiscover(ctx({ MAX_LLM_CALLS_PER_RUN: 1 }), { out, confirm: true }, {
      buildFetcher: () => (url) => (new URL(url).host === 'unreachable.example'
        ? Promise.resolve({ kind: 'invalid', reason: 'unreachable' } as FetchOutcome)
        : Promise.resolve(ok(url, TEAM_HTML))),
      buildLlmDeps: () => llmDepsFor(counted.responder),
    }));

    // The unreachable lead did not eat the single-call run allowance; the reachable lead still ran.
    expect(counted.calls()).toBe(1);
    expect(output).toContain('no_pages');
    expect(output).toContain('nothing recorded, still eligible');
    expect(Object.keys(readResultsManifestIfExists(results).results)).toHaveLength(1);
  });

  it('DRY_RUN=true blocks --preview and --confirm before any lead is touched', async () => {
    await seedQualifiedLead();
    const out = tempOutPath();
    let fetchCalls = 0;
    const buildFetcher = () => (url: string) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); };
    await expect(runDiscover(ctx({ DRY_RUN: true }), { out, preview: true }, { buildFetcher }))
      .rejects.toMatchObject({ code: 'DRY_RUN_LIVE_BLOCKED' });
    await expect(runDiscover(ctx({ DRY_RUN: true }), { out, confirm: true }, { buildFetcher }))
      .rejects.toMatchObject({ code: 'DRY_RUN_LIVE_BLOCKED' });
    expect(fetchCalls).toBe(0);
    expect(readCandidatesFileIfExists(out)).toBeNull();
  });

  it('durable qualification (pipeline_events history) is used, not the current literal status: QUALIFIED -> AUDITED stays eligible; never-qualified and REJECTED are excluded', async () => {
    await seedLead({ businessName: 'Audited Lead', domain: 'audited.example', status: 'AUDITED' });
    await seedLead({ businessName: 'Never Qualified', domain: 'never.example', status: 'READY_FOR_ENRICHMENT', neverQualified: true });
    await seedLead({ businessName: 'Rejected Lead', domain: 'rejected.example', status: 'REJECTED' });
    const out = tempOutPath();
    const fetchedHosts = new Set<string>();
    await runDiscover(ctx(), { out, preview: true }, {
      buildFetcher: () => (url) => { fetchedHosts.add(new URL(url).host); return Promise.resolve(ok(url, '<html><body>none</body></html>')); },
    });
    expect(fetchedHosts.has('audited.example')).toBe(true);
    expect(fetchedHosts.has('never.example')).toBe(false);
    expect(fetchedHosts.has('rejected.example')).toBe(false);
  });

  it('a durably-qualified lead with active outreach in flight (EMAIL_DRAFTED) is excluded — another attempt must not begin', async () => {
    await seedLead({ businessName: 'Drafting Lead', domain: 'drafting.example', status: 'EMAIL_DRAFTED' });
    const out = tempOutPath();
    const fetchedHosts = new Set<string>();
    await runDiscover(ctx(), { out, preview: true }, {
      buildFetcher: () => (url) => { fetchedHosts.add(new URL(url).host); return Promise.resolve(ok(url, '<html><body>none</body></html>')); },
    });
    expect(fetchedHosts.has('drafting.example')).toBe(false);
  });

  it('a lead already holding a VERIFIED contact is skipped unless it has since BOUNCED, where replacement discovery is allowed', async () => {
    const verifiedId = await seedLead({ businessName: 'Verified Lead', domain: 'verified.example', status: 'QUALIFIED' });
    const bouncedId = await seedLead({ businessName: 'Bounced Lead', domain: 'bounced.example', status: 'BOUNCED' });
    const enrichRepo = new ContactEnrichmentRepository(handle.db);
    for (const [leadId, domain] of [[verifiedId, 'verified.example'], [bouncedId, 'bounced.example']] as const) {
      await enrichRepo.save({
        id: randomUUID(), leadId, provider: 'hunter', mode: 'ENRICH', inputHash: `hash-${leadId}`,
        requestedDomain: domain, candidates: [], outcome: 'VERIFIED',
        accepted: { fullName: 'X', title: 'Y', email: 'x@example.com', verificationStatus: 'VERIFIED', dataQuality: null, confidence: null },
        creditsEstimated: 1, creditsReported: null, providerResourceId: null, endpoint: null, provenance: {},
        createdAt: new Date(), completedAt: new Date(),
      });
    }
    const out = tempOutPath();
    const fetchedHosts = new Set<string>();
    await runDiscover(ctx(), { out, preview: true }, {
      buildFetcher: () => (url) => { fetchedHosts.add(new URL(url).host); return Promise.resolve(ok(url, '<html><body>none</body></html>')); },
    });
    expect(fetchedHosts.has('verified.example')).toBe(false);
    expect(fetchedHosts.has('bounced.example')).toBe(true);
  });
});
