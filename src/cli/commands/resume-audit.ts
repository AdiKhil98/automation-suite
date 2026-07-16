import { recoverEnvelopes } from '../../domain/audit/envelope-recovery.js';
import { LocalEnvelopeStore } from '../../integrations/audit/envelope-store.js';
import { DrizzleAuditUnitOfWork } from '../../persistence/audit-unit-of-work.js';
import { type CliContext } from '../context.js';

/**
 * Replay paid-result recovery envelopes whose DB persistence failed. Idempotent and
 * free: NEVER makes model calls — it only re-runs the persistence transaction from
 * results already paid for.
 */
export async function resumeAuditCommand(ctx: CliContext): Promise<void> {
  const store = new LocalEnvelopeStore(ctx.config.AUDIT_ENVELOPE_DIR);
  const uow = new DrizzleAuditUnitOfWork(ctx.db);
  const summary = await recoverEnvelopes(uow, store, ctx.logger);

  console.log(`\nEnvelope recovery (${ctx.config.AUDIT_ENVELOPE_DIR}):`);
  console.log(`  scanned:            ${summary.scanned}`);
  console.log(`  replayed:           ${summary.replayed}`);
  console.log(`  already persisted:  ${summary.alreadyPersisted}`);
  console.log(`  failed (kept):      ${summary.failed}`);
  if (summary.failed > 0) process.exitCode = 1;
}
