import { type CliContext } from '../context.js';

export async function leadState(ctx: CliContext, id: string): Promise<void> {
  const lead = await ctx.leads.getById(id);
  if (!lead) {
    console.log(`Lead not found: ${id}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Lead:     ${lead.businessName ?? `(candidate: place ${lead.placeId ?? '?'})`}`);

  console.log(`Id:       ${lead.id}`);

  console.log(`Status:   ${lead.status}`);

  console.log(`City:     ${lead.city ?? '-'}`);

  console.log(`Updated:  ${lead.updatedAt.toISOString()}`);

  const events = await ctx.events.listByLead(id);

  console.log(`\nEvent history (${events.length}):`);
  for (const event of events) {
    const transition =
      event.fromStatus || event.toStatus
        ? `  [${event.fromStatus ?? '·'} -> ${event.toStatus ?? '·'}]`
        : '';

    console.log(
      `  ${event.createdAt.toISOString()}  ${event.type}${transition}  ${event.message ?? ''}`,
    );
  }
}
