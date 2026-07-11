import { sampleLeads } from '../../fixtures/sample-leads.js';
import { type CliContext } from '../context.js';

export async function createSampleLeads(ctx: CliContext): Promise<void> {
  let created = 0;
  for (const input of sampleLeads) {
    const lead = await ctx.service.createLead(input);
    created += 1;

    console.log(`created  ${lead.id}  ${lead.businessName}`);
  }

  console.log(`\nCreated ${created} sample lead(s).`);
}
