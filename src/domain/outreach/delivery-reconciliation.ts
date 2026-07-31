import { type GmailBounceReader } from '../../integrations/gmail/bounce-reader.js';
import {
  classifyDeliveryPermanence,
  correlateDsn,
  isDeliveryNotification,
  parseDsn,
  permanenceToDeliveryStatus,
  rejectionCode,
  type CorrelationSignal,
  type DeliveryPermanence,
  type DeliveryStatus,
  type ParsedDsn,
  type TrackedOutbound,
} from './delivery.js';
import { type DeliveryFailureOutcome, type OutreachService } from './outreach-service.js';

/**
 * Phase 17C delivery-failure reconciliation. Read-only detection of Gmail Delivery Status
 * Notifications (DSNs) connected to tracked outbound messages, correlated to EXACTLY ONE
 * outbound (fail-closed on ambiguity), classified permanent/temporary, and — unless this
 * is a dry report — applied through {@link OutreachService.applyDeliveryFailure}. Nothing
 * here sends, drafts, labels, archives, or modifies Gmail.
 */

/** A proposed reconciliation for one DSN (what a dry report shows before any write). */
export interface DeliveryProposal {
  dsnGmailMessageId: string;
  dsnGmailThreadId: string;
  outreachRecordId: string;
  outreachMessageId: string;
  correlationSignal: CorrelationSignal;
  permanence: DeliveryPermanence;
  deliveryStatus: DeliveryStatus;
  rejectionCode: string | null;
  finalRecipient: string | null;
  preview: string;
}

/** A DSN that was seen but deliberately NOT applied, with the reason. */
export interface DeliverySkip {
  dsnGmailMessageId: string;
  reason: 'NOT_A_DSN' | 'NO_CORRELATION' | 'AMBIGUOUS_CORRELATION' | 'BEFORE_SENT' | 'OUTSIDE_WINDOW';
  detail?: string;
}

export interface DeliveryReconciliationReport {
  reader: string;
  readExternally: boolean;
  dryRun: boolean;
  notificationsChecked: number;
  proposals: DeliveryProposal[];
  /** Applied outcomes (empty in a dry report). */
  applied: { dsnGmailMessageId: string; outreachRecordId: string; outcome: DeliveryFailureOutcome }[];
  skipped: DeliverySkip[];
}

/** Build the proposal for a correlated, DSN-classified notification. */
function toProposal(dsn: ParsedDsn, outbound: TrackedOutbound, signal: DeliveryProposal['correlationSignal']): DeliveryProposal {
  const permanence = classifyDeliveryPermanence(dsn);
  return {
    dsnGmailMessageId: dsn.dsnGmailMessageId,
    dsnGmailThreadId: dsn.dsnGmailThreadId,
    outreachRecordId: outbound.outreachRecordId,
    outreachMessageId: outbound.outreachMessageId,
    correlationSignal: signal,
    permanence,
    deliveryStatus: permanenceToDeliveryStatus(permanence),
    rejectionCode: rejectionCode(dsn),
    finalRecipient: dsn.finalRecipient,
    preview: dsn.preview,
  };
}

/**
 * Run delivery reconciliation across the tracked outbounds. In `dryRun` mode it returns
 * the proposed correlations and state changes WITHOUT any write. Otherwise it applies
 * each proposal atomically through the service (idempotent per DSN Gmail message id).
 */
export async function runDeliveryReconciliation(args: {
  reader: GmailBounceReader;
  service: OutreachService;
  outbounds: readonly TrackedOutbound[];
  dryRun: boolean;
}): Promise<DeliveryReconciliationReport> {
  const raw = await args.reader.findDeliveryNotifications({ outbounds: args.outbounds });
  const proposals: DeliveryProposal[] = [];
  const skipped: DeliverySkip[] = [];
  const applied: DeliveryReconciliationReport['applied'] = [];

  for (const n of raw) {
    // Only ever treat a message as a DSN when its envelope actually looks like one — an
    // ordinary mailbox message is never classified.
    const isDsn = isDeliveryNotification({
      fromEmail: n.fromEmail,
      subject: n.subject,
      contentType: n.contentType,
      hasXFailedRecipients: !!n.xFailedRecipients,
    });
    if (!isDsn) {
      skipped.push({ dsnGmailMessageId: n.gmailMessageId, reason: 'NOT_A_DSN' });
      continue;
    }

    const dsn = parseDsn(n);
    const correlation = correlateDsn(dsn, args.outbounds);
    if (correlation.kind === 'none') {
      const reason = correlation.reason === 'BEFORE_SENT' ? 'BEFORE_SENT' : correlation.reason === 'OUTSIDE_WINDOW' ? 'OUTSIDE_WINDOW' : 'NO_CORRELATION';
      skipped.push({ dsnGmailMessageId: dsn.dsnGmailMessageId, reason });
      continue;
    }
    if (correlation.kind === 'ambiguous') {
      skipped.push({
        dsnGmailMessageId: dsn.dsnGmailMessageId,
        reason: 'AMBIGUOUS_CORRELATION',
        detail: `${correlation.signal} matches records ${correlation.matchedRecordIds.join(', ')}`,
      });
      continue;
    }

    const proposal = toProposal(dsn, correlation.outbound, correlation.signal);
    proposals.push(proposal);
    if (args.dryRun) continue;

    const result = await args.service.applyDeliveryFailure({
      outreachRecordId: correlation.outbound.outreachRecordId,
      outreachMessageId: correlation.outbound.outreachMessageId,
      deliveryStatus: proposal.deliveryStatus,
      permanence: proposal.permanence,
      rejectionCode: proposal.rejectionCode,
      diagnosticText: dsn.diagnosticCode,
      dsnStatus: dsn.status,
      dsnAction: dsn.action,
      finalRecipient: dsn.finalRecipient,
      originalRecipient: dsn.originalRecipient,
      bounceAtMs: dsn.receivedAtMs,
      originalGmailMessageId: correlation.outbound.gmailMessageId,
      originalGmailThreadId: correlation.outbound.gmailThreadId,
      dsnGmailMessageId: dsn.dsnGmailMessageId,
      dsnGmailThreadId: dsn.dsnGmailThreadId,
      preview: dsn.preview,
    });
    applied.push({
      dsnGmailMessageId: dsn.dsnGmailMessageId,
      outreachRecordId: correlation.outbound.outreachRecordId,
      outcome: result.outcome,
    });
  }

  return {
    reader: args.reader.name,
    readExternally: args.reader.readsExternally,
    dryRun: args.dryRun,
    notificationsChecked: raw.length,
    proposals,
    applied,
    skipped,
  };
}
