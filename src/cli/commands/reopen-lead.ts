import { canTransition } from '../../domain/leads/state-machine.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface ReopenLeadCliOptions {
  lead?: string;
  reason?: string;
  by?: string;
}

/**
 * The ONLY state a lead may be reopened from. This is intentionally stricter than
 * rejection eligibility: reopen is a narrow recovery path for a lead that was
 * *already rejected* (e.g. a false rejection caused by a since-fixed bug). A lead
 * in any other state — active, sent, contacted, bounced, unsubscribed, duplicate,
 * or any non-REJECTED terminal state — is refused (fail-closed).
 */
export const REOPENABLE_STATE: LeadStatus = 'REJECTED';

/** Single supported recovery step: REJECTED back into manual review. */
const REOPEN_TARGET: LeadStatus = 'NEEDS_MANUAL_REVIEW';

/**
 * Reopen exactly one REJECTED lead back to NEEDS_MANUAL_REVIEW through the supported
 * LeadService transition, appending an immutable correction NOTE (reason + operator).
 * The original rejection and all prior evidence/history are preserved (append-only):
 * this adds events, it never erases, overwrites, or rewrites the rejection. Creates NO
 * suppression, outreach, email, Gmail, Sheet, or competitor record; makes no
 * provider/LLM call. Fails closed for unknown, non-REJECTED, or under-specified input.
 */
export async function reopenLeadCommand(ctx: CliContext, opts: ReopenLeadCliOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const reason = opts.reason?.trim();
  const by = opts.by?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead; no bulk fallback).');
  if (!reason) throw new AppError('REASON_REQUIRED', '--reason <text> is required.');
  if (!by) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found; refusing to reopen.`);

  const from = lead.status;
  if (from !== REOPENABLE_STATE) {
    throw new AppError(
      'LEAD_NOT_REOPENABLE',
      `Lead is ${from}; only a ${REOPENABLE_STATE} lead can be reopened.`,
    );
  }
  // Defence in depth: the supported edge must exist. Never emit an illegal transition.
  if (!canTransition(from, REOPEN_TARGET)) {
    throw new AppError('REOPEN_EDGE_MISSING', `No supported transition ${from} -> ${REOPEN_TARGET}.`);
  }

  await ctx.service.transition(leadId, REOPEN_TARGET); // supported transition + STATE_TRANSITION event

  await ctx.events.record({
    leadId,
    runId: null,
    type: 'NOTE',
    fromStatus: from,
    toStatus: REOPEN_TARGET,
    message: `reopened: ${reason} (by ${by})`,
    data: { reason, operator: by, correction: true, fromState: from },
  });

  console.log(`Lead ${leadId} reopened: ${from} -> ${REOPEN_TARGET}. reason="${reason}" by=${by}`);
}
