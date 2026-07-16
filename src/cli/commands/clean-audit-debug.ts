import { LocalAuditDebugStore } from '../../integrations/audit/debug-store.js';
import { type CliContext } from '../context.js';

export interface CleanAuditDebugOptions {
  all?: boolean;
}

/**
 * Remove audit validation-debug envelopes. Default: expired records only (past their
 * retention window). `--all` purges every debug record (active + archived).
 */
export async function cleanAuditDebugCommand(ctx: CliContext, opts: CleanAuditDebugOptions): Promise<void> {
  const store = new LocalAuditDebugStore(ctx.config.AUDIT_DEBUG_DIR);
  const removed = opts.all ? await store.purgeAll() : await store.cleanupExpired();
  console.log(`Audit debug cleanup (${ctx.config.AUDIT_DEBUG_DIR}): removed ${removed} ${opts.all ? '(all)' : '(expired)'} record(s).`);
}
