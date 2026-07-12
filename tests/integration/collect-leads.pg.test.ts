import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { collectLeads, type CollectOptions } from '../../src/pipeline/collect-leads.js';
import { MockLeadSource, type MockBusiness } from '../../src/integrations/lead-source/mock-lead-source.js';
import { createDb, type DbHandle } from '../../src/persistence/db.js';
import { truncateAll } from '../../src/persistence/maintenance.js';
import { DrizzleUnitOfWork } from '../../src/persistence/unit-of-work.js';
import { PipelineRunsRepository } from '../../src/persistence/repositories/runs.repo.js';
import { SourceRequestsRepository } from '../../src/persistence/repositories/source.repo.js';
import { leads, sourceEntities, sourceObservations } from '../../src/persistence/schema.js';
import { type CollectTxRepos, type UnitOfWork } from '../../src/pipeline/ports.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = pino({ level: 'silent' });

function biz(id: string, over: Partial<MockBusiness> = {}): MockBusiness {
  return {
    sourcePlaceId: id,
    businessName: `Biz ${id}`,
    domain: `${id}.example`,
    phone: null,
    city: 'Manchester',
    country: 'GB',
    formattedAddress: `${id} High Street, Manchester`,
    latitude: 53.48,
    longitude: -2.24,
    ...over,
  };
}

function baseOpts(runId: string, over: Partial<CollectOptions> = {}): CollectOptions {
  return {
    runId,
    campaign: 'pg-test',
    query: { textQuery: 'dentist' },
    caps: { maxLeads: 100, pageSize: 20, maxPages: 5 },
    nearMeters: 40,
    factsSource: 'mock',
    ...over,
  };
}

// Skips entirely when no database is configured (keeps `pnpm test` unit-only).
describe.skipIf(!DATABASE_URL)('collectLeads (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= createDb(DATABASE_URL as string);
    await truncateAll(handle.db);
  });

  afterAll(async () => {
    if (handle) await handle.pool.end();
  });

  async function run(provider: MockLeadSource, uow: UnitOfWork, opts: CollectOptions): Promise<void> {
    const runs = new PipelineRunsRepository(handle.db);
    const runId = await runs.start('collect-leads:pg-test', true);
    await collectLeads(
      { provider, requests: new SourceRequestsRepository(handle.db), uow, logger },
      { ...opts, runId },
    );
    await runs.finish(runId, 'COMPLETED');
  }

  it('enforces source uniqueness and idempotent reruns', async () => {
    const uow = new DrizzleUnitOfWork(handle.db);
    const provider = new MockLeadSource([biz('a'), biz('b')]);

    await run(provider, uow, baseOpts('r1'));
    await run(provider, uow, baseOpts('r2'));

    const leadRows = await handle.db.select().from(leads);
    const entityRows = await handle.db.select().from(sourceEntities);
    expect(leadRows).toHaveLength(2);
    expect(entityRows).toHaveLength(2); // one per Place ID, not per run
  });

  it('appends observation history across runs (never overwrites)', async () => {
    const uow = new DrizzleUnitOfWork(handle.db);
    const provider = new MockLeadSource([biz('a')]);

    await run(provider, uow, baseOpts('r1'));
    await run(provider, uow, baseOpts('r2'));

    const obs = await handle.db.select().from(sourceObservations);
    expect(obs).toHaveLength(2); // CREATED then REFRESHED
    const results = obs.map((o) => o.processingResult).sort();
    expect(results).toEqual(['CREATED', 'REFRESHED']);
  });

  it('flags ambiguous matches without merging', async () => {
    const uow = new DrizzleUnitOfWork(handle.db);
    const a = biz('a', {
      businessName: 'Central Dental',
      domain: null,
      formattedAddress: null,
      latitude: null,
      longitude: null,
    });
    const b = biz('b', {
      businessName: 'Central Dental',
      domain: null,
      formattedAddress: null,
      latitude: null,
      longitude: null,
    });
    await run(new MockLeadSource([a, b]), uow, baseOpts('r1'));

    const leadRows = await handle.db.select().from(leads);
    expect(leadRows).toHaveLength(2);
    const ambiguous = leadRows.filter((l) => l.dedupStatus === 'AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.duplicateOf).toBeTruthy();
  });

  it('rolls back a failed candidate transaction without affecting siblings', async () => {
    // Wrap the real unit of work; make observations.create throw for the 2nd candidate
    // AFTER its lead + entity were inserted in the same transaction.
    const inner = new DrizzleUnitOfWork(handle.db);
    let index = 0;
    const failOnIndex = 1;
    const failing: UnitOfWork = {
      async transaction<T>(fn: (repos: CollectTxRepos) => Promise<T>): Promise<T> {
        const idx = index++;
        return inner.transaction((repos) => {
          const wrapped: CollectTxRepos =
            idx === failOnIndex
              ? {
                  ...repos,
                  observations: {
                    async create(): Promise<void> {
                      throw new Error('injected failure after lead+entity insert');
                    },
                  },
                }
              : repos;
          return fn(wrapped);
        });
      },
    };

    const provider = new MockLeadSource([biz('a'), biz('b'), biz('c')]);
    await run(provider, failing, baseOpts('r1'));

    const leadRows = await handle.db.select().from(leads);
    const entityRows = await handle.db.select().from(sourceEntities);
    // 2nd candidate rolled back entirely; 1st and 3rd persisted.
    expect(leadRows).toHaveLength(2);
    expect(entityRows).toHaveLength(2);
    const placeIds = entityRows.map((e) => e.sourcePlaceId).sort();
    expect(placeIds).toEqual(['a', 'c']);
  });
});
