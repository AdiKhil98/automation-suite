import { sha256Hex } from '../../utils/hash.js';
import { SENDER_NAME_TOKEN } from '../gmail/mime.js';
import { DEMO_URL_TOKEN } from './email-types.js';

/**
 * Reply-email finalization (kind `REPLY_DIRECT`). A reply email carries no {{DEMO_URL}} to resolve, so
 * its finalized body is byte-identical to the approved draft body. This produces the `email_draft_
 * finalizations` record the Gmail eligibility gate requires, WITHOUT a demo/Netlify/deployment — reusing
 * the same table + downstream semantics (a second producer, not a parallel system).
 */
export const REPLY_FINALIZATION_KIND = 'REPLY_DIRECT' as const;

/** The approved draft fields a reply finalization validates against (read from email_drafts). */
export interface ReplyFinalizationDraft {
  id: string;
  leadId: string;
  status: string;
  humanDecision: string | null;
  ctaKind: string;
  body: string;
}

export interface ReplyFinalizationInput {
  requestedLeadId: string;
  leadStatus: string;
  draft: ReplyFinalizationDraft | null;
}

export interface ReplyFinalizationCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Deterministic, side-effect-free preconditions for a reply finalization (fail-closed). Intentionally
 * provenance-agnostic: it does NOT check `authorship`, so it works for any approved reply draft (operator
 * or AI). The token rules mirror `checkGmailEligibility` exactly (only {{SENDER_NAME}} may remain).
 */
export function validateReplyFinalization(input: ReplyFinalizationInput): ReplyFinalizationCheck {
  const v: string[] = [];
  if (input.leadStatus !== 'HUMAN_APPROVED') v.push(`lead_not_human_approved:${input.leadStatus}`);

  const d = input.draft;
  if (!d) {
    v.push('draft_not_found');
    return { ok: false, violations: v };
  }
  if (d.leadId !== input.requestedLeadId) v.push('draft_wrong_lead');
  if (d.status !== 'APPROVED') v.push(`draft_status_not_approved:${d.status}`);
  if (d.humanDecision !== 'APPROVED') v.push(`draft_human_decision_not_approved:${d.humanDecision ?? 'none'}`);
  if (d.ctaKind !== 'reply') v.push(`draft_cta_not_reply:${d.ctaKind}`);
  if (d.body.includes(DEMO_URL_TOKEN)) v.push('body_contains_demo_url');
  const stripped = d.body.split(SENDER_NAME_TOKEN).join('');
  if (/\{\{[A-Za-z0-9_]+\}\}/.test(stripped)) v.push('body_has_unresolved_token');

  return { ok: v.length === 0, violations: [...new Set(v)] };
}

export interface ReplyFinalizationHashes {
  resolvedBody: string;
  originalBodyHash: string;
  resolvedBodyHash: string;
}

/**
 * A reply finalization performs no substitution: resolvedBody === the approved body, so
 * originalBodyHash === resolvedBodyHash === sha256(body). Deterministic and recomputable.
 */
export function computeReplyFinalization(body: string): ReplyFinalizationHashes {
  const hash = sha256Hex(body);
  return { resolvedBody: body, originalBodyHash: hash, resolvedBodyHash: hash };
}
