import { type CliContext } from '../context.js';

export async function listLeads(ctx: CliContext): Promise<void> {
  const leads = await ctx.leads.list();
  if (leads.length === 0) {
    console.log('No leads found. Run: pnpm cli create-sample-leads');
    return;
  }

  console.log(`${leads.length} lead(s):\n`);
  for (const lead of leads) {
    const city = lead.city ?? '-';

    console.log(`${lead.id}  ${lead.status.padEnd(24)}  ${city.padEnd(12)}  ${lead.businessName}`);
  }
}
