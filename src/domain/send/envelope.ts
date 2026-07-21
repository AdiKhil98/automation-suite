import { type ProviderDraftEnvelope } from '../../integrations/send/provider.js';
import { sha256Hex } from '../../utils/hash.js';
import { hasUnresolvedTokens, resolveSenderName } from '../gmail/mime.js';

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
export function recipientHash(email: string): string { return sha256Hex(`recipient|${normalizeEmail(email)}`); }

export interface ApprovedEnvelope {
  gmailAccount: string; recipientEmail: string; subject: string; finalizedContentHash: string;
  scheduleId: string; scheduledAtUtcMs: number; replyTo?: string | null;
}
export function approvedEnvelopeHash(e: ApprovedEnvelope): string {
  return sha256Hex([normalizeEmail(e.gmailAccount), normalizeEmail(e.recipientEmail), e.subject,
    e.finalizedContentHash, e.replyTo ? normalizeEmail(e.replyTo) : '', e.scheduleId, String(e.scheduledAtUtcMs)].join('|'));
}

export interface SendFingerprintInput { scheduleId: string; gmailDraftId: string; approvedEnvelopeHash: string; readinessApprovalId: string }
export function sendFingerprint(i: SendFingerprintInput): string {
  return sha256Hex([i.scheduleId, i.gmailDraftId, i.approvedEnvelopeHash, i.readinessApprovalId].join('|'));
}
export interface ConfirmationInput { approvedEnvelopeHash: string; confirmedBy: string; observedEnvelopeHash: string }
export function confirmationFingerprint(i: ConfirmationInput): string {
  return sha256Hex([i.approvedEnvelopeHash, i.confirmedBy, i.observedEnvelopeHash].join('|'));
}

export function expectedDraftEnvelope(input: {
  senderName: string; senderEmail: string; recipientEmail: string; subject: string; resolvedBody: string;
  replyTo?: string | null;
}): ProviderDraftEnvelope {
  const body = resolveSenderName(input.resolvedBody, input.senderName);
  if (hasUnresolvedTokens(body)) throw new Error('approved email contains unresolved tokens');
  return { fromName: input.senderName, fromEmail: normalizeEmail(input.senderEmail),
    to: [normalizeEmail(input.recipientEmail)], cc: [], bcc: [], replyTo: input.replyTo ? normalizeEmail(input.replyTo) : null, subject: input.subject,
    body, attachmentCount: 0 };
}

export function providerEnvelopeHash(e: ProviderDraftEnvelope): string {
  return sha256Hex(JSON.stringify({ fromName: e.fromName, fromEmail: normalizeEmail(e.fromEmail),
    to: e.to.map(normalizeEmail), cc: e.cc.map(normalizeEmail), bcc: e.bcc.map(normalizeEmail),
    replyTo: e.replyTo ? normalizeEmail(e.replyTo) : null,
    subject: e.subject, bodyHash: sha256Hex(e.body), attachmentCount: e.attachmentCount }));
}

export function compareProviderEnvelope(expected: ProviderDraftEnvelope, actual: ProviderDraftEnvelope): string[] {
  const problems: string[] = [];
  if (actual.fromName !== expected.fromName) problems.push('sender_name_changed');
  if (normalizeEmail(actual.fromEmail) !== normalizeEmail(expected.fromEmail)) problems.push('sender_changed');
  if (actual.to.length !== 1 || normalizeEmail(actual.to[0] ?? '') !== normalizeEmail(expected.to[0] ?? '')) problems.push('recipient_changed');
  if (actual.cc.length > 0) problems.push('unexpected_cc');
  if (actual.bcc.length > 0) problems.push('unexpected_bcc');
  if ((actual.replyTo ? normalizeEmail(actual.replyTo) : null) !== (expected.replyTo ? normalizeEmail(expected.replyTo) : null)) problems.push('reply_to_changed');
  if (actual.attachmentCount !== 0) problems.push('unexpected_attachment');
  if (actual.subject !== expected.subject) problems.push('subject_changed');
  if (actual.body !== expected.body) problems.push('body_changed');
  return problems;
}

export function preflightProofHash(sendFp: string, observedEnvelopeHash: string, checkedAtMs: number): string {
  return sha256Hex(['preflight-v1', sendFp, observedEnvelopeHash, String(checkedAtMs)].join('|'));
}
