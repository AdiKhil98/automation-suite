import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SuppressionAdminService } from '../../domain/suppression/admin-service.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { SuppressionRepository, type SuppressionScope } from '../../persistence/repositories/suppression.repo.js';
import { type CliContext } from '../context.js';

const scopes = new Set<SuppressionScope>(['email', 'domain', 'phone', 'place_id']);
function scopeOf(value: string): SuppressionScope { if (!scopes.has(value as SuppressionScope)) throw new Error('invalid_suppression_scope'); return value as SuppressionScope; }
function service(ctx: CliContext) { return new SuppressionAdminService(new SuppressionRepository(ctx.db), new PipelineRepository(ctx.db)); }

export async function addSuppressionCommand(ctx: CliContext, opts: { scope: string; value: string; reason: string; by: string }): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) { console.log('Interactive TTY confirmation is required. No suppression was added.'); return; }
  const scope = scopeOf(opts.scope); const svc = service(ctx); const hash = svc.previewHash(scope, opts.value);
  const phrase = `ADD SUPPRESSION ${scope} ${hash.slice(0, 12)}`; const rl = createInterface({ input: stdin, output: stdout });
  try { if ((await rl.question(`Type exactly: ${phrase}\n> `)) !== phrase) { console.log('Confirmation did not match. No suppression was added.'); return; }
    const id = await ctx.db.transaction(async (tx) => new SuppressionAdminService(new SuppressionRepository(tx), new PipelineRepository(tx))
      .add(scope, opts.value, opts.reason, opts.by));
    console.log(`Suppression added: id=${id}; scope=${scope}; valueHash=${hash}.`);
  } finally { rl.close(); }
}

export async function suppressionStatusCommand(ctx: CliContext, opts: { scope?: string }): Promise<void> {
  const scope = opts.scope ? scopeOf(opts.scope) : undefined; const rows = await service(ctx).list(scope);
  console.log(`Suppressions (redacted): ${rows.length}`);
  for (const row of rows) console.log(`  id=${row.id}; scope=${row.scope}; valueHash=${row.valueHash}; active=${row.active}`);
}

export async function revokeSuppressionCommand(ctx: CliContext, opts: { id: string; reason: string; by: string }): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) { console.log('Interactive TTY confirmation is required. No suppression was revoked.'); return; }
  const phrase = `REVOKE SUPPRESSION ${opts.id}`; const rl = createInterface({ input: stdin, output: stdout });
  try { if ((await rl.question(`Type exactly: ${phrase}\n> `)) !== phrase) { console.log('Confirmation did not match. No suppression was revoked.'); return; }
    const changed = await ctx.db.transaction(async (tx) => new SuppressionAdminService(new SuppressionRepository(tx), new PipelineRepository(tx))
      .revoke(opts.id, opts.reason, opts.by));
    console.log(changed ? 'Suppression revoked.' : 'No active suppression matched.');
  } finally { rl.close(); }
}
