import { canTransition } from '../../domain/leads/state-machine.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { DrizzleLeadRequeueUnitOfWork, type LeadRequeueUnitOfWork } from '../../persistence/lead-requeue-unit-of-work.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface RequeueLeadForAuditCliOptions {
  lead?: string;
  reason?: string;
  by?: string;
}

/**
 * The ONLY state a lead may be requeued for audit from. Deliberately narrow: this is
 * an operator recovery path for a lead parked in manual review by an audit outcome
 * that has since been addressed (e.g. a validator false positive fixed in code). A
 * lead in any other state — mid-pipeline, audited, drafted, sent, or terminal — is
 * refused (fail-closed).
 */
export const REQUEUEABLE_STATE: LeadStatus = 'NEEDS_MANUAL_REVIEW';

/** Single supported recovery step: manual review back into the audit queue. */
export const REQUEUE_TARGET: LeadStatus = 'READY_FOR_AUDIT';

/** Recorded on the NOTE so this recovery is distinguishable from any other requeue. */
export const REQUEUE_RECOVERY_TYPE = 'audit_requeue';

/**
 * Requeue exactly one NEEDS_MANUAL_REVIEW lead back to READY_FOR_AUDIT through the
 * supported LeadService transition, appending an immutable recovery NOTE (reason +
 * operator + recovery type + previous/target status). Transition and NOTE are written
 * in ONE transaction, with the eligibility re-read inside it. Append-only: prior audit
 * runs, findings, evidence, and events are preserved, never erased or rewritten.
 *
 * Makes NO network, provider, LLM, Gmail, email, draft, schedule, or send call, and
 * creates no suppression/outreach record. It only makes the lead eligible for a
 * subsequent `audit-websites` run — it never performs the audit itself.
 */
export async function requeueLeadForAuditCommand(
  ctx: CliContext,
  opts: RequeueLeadForAuditCliOptions,
  uow: LeadRequeueUnitOfWork = new DrizzleLeadRequeueUnitOfWork(ctx.db),
): Promise<void> {
  const leadId = opts.lead?.trim();
  const reason = opts.reason?.trim();
  const by = opts.by?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead; no bulk fallback).');
  if (!reason) throw new AppError('REASON_REQUIRED', '--reason <text> is required.');
  if (!by) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  const from = await uow.transaction(async (repos) => {
    const lead = await repos.leads.getById(leadId);
    if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found; refusing to requeue.`);

    const current = lead.status;
    if (current !== REQUEUEABLE_STATE) {
      throw new AppError(
        'LEAD_NOT_REQUEUEABLE',
        `Lead is ${current}; only a ${REQUEUEABLE_STATE} lead can be requeued for audit.`,
      );
    }
    // Defence in depth: the supported edge must exist. Never emit an illegal transition.
    if (!canTransition(current, REQUEUE_TARGET)) {
      throw new AppError('REQUEUE_EDGE_MISSING', `No supported transition ${current} -> ${REQUEUE_TARGET}.`);
    }

    await repos.leadService.transition(leadId, REQUEUE_TARGET); // supported transition + STATE_TRANSITION event

    await repos.events.record({
      leadId,
      runId: null,
      type: 'NOTE',
      fromStatus: current,
      toStatus: REQUEUE_TARGET,
      message: `requeued for audit: ${reason} (by ${by})`,
      data: {
        reason,
        operator: by,
        recoveryType: REQUEUE_RECOVERY_TYPE,
        fromState: current,
        toState: REQUEUE_TARGET,
      },
    });
    return current;
  });

  console.log(`Lead ${leadId} requeued for audit: ${from} -> ${REQUEUE_TARGET}. reason="${reason}" by=${by}`);
  console.log('No audit performed. Run audit-websites separately to audit this lead.');
}
