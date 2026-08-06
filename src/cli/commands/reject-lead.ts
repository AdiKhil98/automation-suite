import { canTransition } from '../../domain/leads/state-machine.js';
import { type LeadStatus } from '../../domain/leads/status.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

export interface RejectLeadCliOptions {
  lead?: string;
  reason?: string;
  by?: string;
}

/**
 * Pre-send lead states from which a rejection is allowed. Each reaches REJECTED
 * through the SUPPORTED state machine — directly, or via a single
 * NEEDS_MANUAL_REVIEW hop. Everything else (already-contacted, drafted, approved,
 * scheduled, sent, replied, bounced, unsubscribed, duplicate, or a terminal state)
 * is refused: a lead that has left the research/review phase is never rejected here.
 */
export const REJECTABLE_STATES: readonly LeadStatus[] = [
  'READY_FOR_QUALIFICATION',
  'READY_FOR_ENRICHMENT',
  'READY_FOR_CAPTURE',
  'READY_FOR_AUDIT',
  'AUDITED',
  'NEEDS_MANUAL_REVIEW',
];

/**
 * Pure: the supported transition steps to reject a lead in `from`. Fails closed
 * (throws) for any non-rejectable state. Never returns an unsupported edge —
 * every returned step satisfies `canTransition`.
 */
export function planRejectionPath(from: LeadStatus): LeadStatus[] {
  if (!REJECTABLE_STATES.includes(from)) {
    throw new AppError(
      'LEAD_NOT_REJECTABLE',
      `Lead is ${from}; only pre-send states can be rejected here (${REJECTABLE_STATES.join(', ')}).`,
    );
  }
  if (canTransition(from, 'REJECTED')) return ['REJECTED'];
  // Every remaining rejectable state can reach REJECTED via one NEEDS_MANUAL_REVIEW hop.
  return ['NEEDS_MANUAL_REVIEW', 'REJECTED'];
}

/**
 * Formally reject exactly one pre-send lead through the supported LeadService
 * transitions, appending an immutable rejection NOTE (reason + operator). Preserves
 * all prior evidence and history (append-only). Creates NO suppression, outreach,
 * email, Gmail, or competitor record; makes no provider/LLM call.
 */
export async function rejectLeadCommand(ctx: CliContext, opts: RejectLeadCliOptions): Promise<void> {
  const leadId = opts.lead?.trim();
  const reason = opts.reason?.trim();
  const by = opts.by?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead).');
  if (!reason) throw new AppError('REASON_REQUIRED', '--reason <text> is required.');
  if (!by) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found; refusing to reject.`);

  const from = lead.status;
  const path = planRejectionPath(from); // throws (fail-closed) on an ineligible state

  for (const to of path) {
    await ctx.service.transition(leadId, to); // supported transition + STATE_TRANSITION event
  }

  await ctx.events.record({
    leadId,
    runId: null,
    type: 'NOTE',
    fromStatus: 'REJECTED',
    toStatus: null,
    message: `rejected: ${reason} (by ${by})`,
    data: { reason, operator: by, fromState: from },
  });

  console.log(`Lead ${leadId} rejected: ${from} -> ${path.join(' -> ')}. reason="${reason}" by=${by}`);
}
