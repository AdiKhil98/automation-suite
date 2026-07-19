import { sha256Hex } from '../../utils/hash.js';

/** The values a schedule is BOUND to (amendment 4). If the recipient, finalized-email content
 * hash, Gmail draft, or provider draft id changes, the recomputed fingerprint differs and the
 * schedule must be treated as invalid (not eligible for Phase 14 sending). */
export interface ScheduleBinding {
  leadId: string;
  gmailDraftId: string;
  providerDraftId: string;
  finalizedContentHash: string;
  recipientEmail: string;
  scheduledAtUtcMs: number;
  rulesVersion: string;
}

export function scheduleIntegrityFingerprint(b: ScheduleBinding): string {
  return sha256Hex([b.leadId, b.gmailDraftId, b.providerDraftId, b.finalizedContentHash, b.recipientEmail, String(b.scheduledAtUtcMs), b.rulesVersion].join('|'));
}
