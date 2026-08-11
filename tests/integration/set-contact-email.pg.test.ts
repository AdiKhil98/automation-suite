import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireIntegrationTestDatabase } from '../support/test-database.js';
import { setContactEmailCommand } from '../../src/cli/commands/set-contact-email.js';
import { buildCandidateLead } from '../../src/domain/leads/lead-factory.js';
import { LeadService } from '../../src/domain/leads/lead-service.js';
import { type CliContext } from '../../src/cli/context.js';
import { type DbHandle } from '../../src/persistence/db.js';
import { LeadsRepository } from '../../src/persistence/repositories/leads.repo.js';
import { PipelineRepository } from '../../src/persistence/repositories/pipeline.repo.js';
import { leadFacts } from '../../src/persistence/schema.js';

const testDatabase = requireIntegrationTestDatabase();
const logger = pino({ level: 'silent' });

describe('setContactEmail (PostgreSQL)', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle ??= testDatabase.createHandle();
    await testDatabase.truncate(handle.db);
    process.exitCode = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
  afterAll(async () => { if (handle) await handle.pool.end(); });

  function ctx(): CliContext {
    const leads = new LeadsRepository(handle.db);
    const events = new PipelineRepository(handle.db);
    return { db: handle.db, leads, events, service: new LeadService(leads, events), logger } as unknown as CliContext;
  }

  async function seedLead(): Promise<string> {
    const leads = new LeadsRepository(handle.db);
    const lead = buildCandidateLead({ sourcePlaceId: `place-${randomUUID()}`, source: 'mock' });
    await leads.create(lead);
    return lead.id;
  }

  async function currentContactEmail(leadId: string) {
    return (await handle.db.select().from(leadFacts)
      .where(and(eq(leadFacts.leadId, leadId), eq(leadFacts.factType, 'contact_email'), eq(leadFacts.isCurrent, true))).limit(1))[0];
  }

  it('confirm: stores the BARE address (mailto/query stripped) with website provenance', async () => {
    const leadId = await seedLead();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await setContactEmailCommand(ctx(), {
      lead: leadId, email: 'mailto:Info@Mayfield-Dental.co.uk?subject=New%20Enquiry:',
      sourceType: 'website', sourceUrl: 'https://www.mayfield-dental.co.uk/', confirm: true,
    });
    const fact = await currentContactEmail(leadId);
    expect(fact?.value).toBe('info@mayfield-dental.co.uk');
    expect(fact?.normalizedValue).toBe('info@mayfield-dental.co.uk');
    expect(fact?.sourceType).toBe('website');
    expect(fact?.sourceUrl).toBe('https://www.mayfield-dental.co.uk/');
  });

  it('dry preview writes nothing', async () => {
    const leadId = await seedLead();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await setContactEmailCommand(ctx(), { lead: leadId, email: 'info@mayfield-dental.co.uk', sourceType: 'website', sourceUrl: 'https://www.mayfield-dental.co.uk/', confirm: false });
    expect(await currentContactEmail(leadId)).toBeUndefined();
  });

  it('rejects an invalid source type and a non-email value', async () => {
    const leadId = await seedLead();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(setContactEmailCommand(ctx(), { lead: leadId, email: 'info@mayfield-dental.co.uk', sourceType: 'guessed', sourceUrl: 'https://x', confirm: true })).rejects.toThrow(/SOURCE_TYPE_INVALID/);
    await setContactEmailCommand(ctx(), { lead: leadId, email: 'not-an-email', sourceType: 'website', sourceUrl: 'https://x', confirm: true });
    expect(process.exitCode).toBe(1);
    expect(await currentContactEmail(leadId)).toBeUndefined();
  });
});
