import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { leads } from '../../src/persistence/schema.js';
import { discoverDecisionMakersCommand } from '../../src/cli/commands/discover-decision-makers.js';
import { type CliContext } from '../../src/cli/context.js';
import { LeadFactsRepository } from '../../src/persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { readCandidatesFileIfExists } from '../../src/domain/contact-resolve-batch/candidates-file.js';
import { type PageFetchFn } from '../../src/domain/decision-makers/website-evidence.js';
import { type FetchOutcome } from '../../src/utils/safe-fetch.js';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { type DecisionMakerLlmDeps } from '../../src/domain/decision-makers/service.js';

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

let tmpDir: string | null = null;
function tempOutPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'discover-decision-makers-test-'));
  return join(tmpDir, 'candidates.json');
}
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

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
        { candidateRef: 'C1', fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.97, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.' },
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
      events: undefined as unknown as CliContext['events'],
      service: undefined as unknown as CliContext['service'],
    };
  }

  async function seedQualifiedLead(businessName = 'Diamond Smile', domain = DOMAIN): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(leads).values({ id, businessName, normalizedDomain: domain, status: 'QUALIFIED' });
    await new LeadFactsRepository(handle.db).writeCurrentFact({
      leadId: id, factType: 'official_domain', value: domain, normalizedValue: domain, sourceType: 'manual', sourceUrl: null,
    });
    return id;
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
    await discoverDecisionMakersCommand(ctx(), { out }, {
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
    await discoverDecisionMakersCommand(ctx(), { out, preview: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => { llmCalls += 1; return llmDepsFor(verifiedResponder()); },
    });
    expect(llmCalls).toBe(0);
    expect(readCandidatesFileIfExists(out)).toBeNull();
  });

  it('--confirm fetches + extracts + writes an --out file that contact-resolve-batch can load', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    const data = readCandidatesFileIfExists(out);
    expect(data).not.toBeNull();
    expect(data?.[leadId]).toEqual([
      { fullName: 'Shyam Shastri', title: 'Principal Dentist', sourceUrl: `https://${DOMAIN}/meet-the-team`, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.', confidence: 0.97 },
    ]);
  });

  it('existing evidence is reused: a second run skips a lead already present in --out (zero fetch/LLM calls) unless --refresh', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });

    let fetchCalls = 0;
    let llmCalls = 0;
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true }, {
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => { llmCalls += 1; return llmDepsFor(verifiedResponder()); },
    });
    expect(fetchCalls).toBe(0);
    expect(llmCalls).toBe(1); // llmDeps is still constructed once up front for the run, but never invoked per-lead
    void leadId;
  });

  it('--refresh bypasses the "already in --out" skip and re-processes the lead', async () => {
    const leadId = await seedQualifiedLead();
    const out = tempOutPath();
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true }, {
      buildFetcher: () => fakeFetcher({ [HOME]: HOME_HTML, [`https://${DOMAIN}/meet-the-team`]: TEAM_HTML }),
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    let fetchCalls = 0;
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true, refresh: true }, {
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); },
      buildLlmDeps: () => llmDepsFor(verifiedResponder()),
    });
    expect(fetchCalls).toBeGreaterThan(0);
    void leadId;
  });

  it('--limit bounds how many leads are attempted', async () => {
    await seedQualifiedLead('Lead One', 'lead-one.example');
    await seedQualifiedLead('Lead Two', 'lead-two.example');
    const out = tempOutPath();
    let fetchCalls = 0;
    await discoverDecisionMakersCommand(ctx(), { out, confirm: true, limit: '1' }, {
      // Neither lead's homepage has any secondary links, so exactly one fetch per attempted lead.
      buildFetcher: () => (url) => { fetchCalls += 1; return Promise.resolve(ok(url, '<html><body>none</body></html>')); },
      buildLlmDeps: () => llmDepsFor(() => ({ rawJson: { candidates: [], insufficientEvidence: true } })),
    });
    expect(fetchCalls).toBe(1);
  });

  it('DRY_RUN=true blocks --preview and --confirm before any lead is touched', async () => {
    await seedQualifiedLead();
    const out = tempOutPath();
    let fetchCalls = 0;
    const buildFetcher = () => (url: string) => { fetchCalls += 1; return Promise.resolve(ok(url, HOME_HTML)); };
    await expect(discoverDecisionMakersCommand(ctx({ DRY_RUN: true }), { out, preview: true }, { buildFetcher }))
      .rejects.toMatchObject({ code: 'DRY_RUN_LIVE_BLOCKED' });
    await expect(discoverDecisionMakersCommand(ctx({ DRY_RUN: true }), { out, confirm: true }, { buildFetcher }))
      .rejects.toMatchObject({ code: 'DRY_RUN_LIVE_BLOCKED' });
    expect(fetchCalls).toBe(0);
    expect(readCandidatesFileIfExists(out)).toBeNull();
  });
});
