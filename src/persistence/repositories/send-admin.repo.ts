import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { type AttemptStatusView, type ReadinessStatus, type SendAdminStore } from '../../domain/send/send-admin-service.js';
import { scheduleIntegrityFingerprint } from '../../domain/schedule/fingerprint.js';
import { approvedEnvelopeHash, recipientHash, sendFingerprint } from '../../domain/send/envelope.js';
import { type Database } from '../db.js';
import { emailDraftFinalizations, emailDrafts, gmailDrafts, leadFacts, leads, sendAttempts,
  sendSchedules, sendingReadinessApprovals } from '../schema.js';
import { PipelineRepository } from './pipeline.repo.js';

export class SendAdminRepository implements SendAdminStore {
  constructor(private readonly db: Database) {}

  createReadiness(input: { gmailAccount: string; policyVersion: string; approvedBy: string; approvedAt: Date; expiresAt: Date }): Promise<ReadinessStatus> {
    return this.db.transaction(async (tx) => {
      await tx.update(sendingReadinessApprovals).set({ revokedAt: input.approvedAt,
        revokedBy: input.approvedBy, revokeReason: 'superseded_by_fresh_readiness' }).where(and(
        eq(sendingReadinessApprovals.gmailAccount, input.gmailAccount),
        eq(sendingReadinessApprovals.policyVersion, input.policyVersion), isNull(sendingReadinessApprovals.revokedAt)));
      const row = (await tx.insert(sendingReadinessApprovals).values({ id: randomUUID(), ...input }).returning())[0];
      if (!row) throw new Error('readiness_insert_failed');
      await new PipelineRepository(tx).record({ leadId: null, runId: null, type: 'NOTE',
        fromStatus: null, toStatus: null, message: 'Expiring sending readiness created',
        data: { eventKind: 'SENDING_READINESS_CREATED', readinessId: row.id, policyVersion: row.policyVersion, expiresAt: row.expiresAt.toISOString() } });
      return toReadiness(row);
    });
  }

  async revokeReadiness(input: { id: string; revokedBy: string; reason: string; revokedAt: Date }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.update(sendingReadinessApprovals).set({ revokedAt: input.revokedAt,
        revokedBy: input.revokedBy, revokeReason: input.reason }).where(and(
        eq(sendingReadinessApprovals.id, input.id), isNull(sendingReadinessApprovals.revokedAt))).returning({ id: sendingReadinessApprovals.id });
      if (!rows[0]) return false;
      await new PipelineRepository(tx).record({ leadId: null, runId: null, type: 'NOTE',
        fromStatus: null, toStatus: null, message: 'Sending readiness revoked', data: { eventKind: 'SENDING_READINESS_REVOKED', readinessId: input.id } });
      return true;
    });
  }

  async latestReadiness(gmailAccount: string, policyVersion: string): Promise<ReadinessStatus | null> {
    const row = (await this.db.select().from(sendingReadinessApprovals).where(and(
      eq(sendingReadinessApprovals.gmailAccount, gmailAccount), eq(sendingReadinessApprovals.policyVersion, policyVersion)))
      .orderBy(desc(sendingReadinessApprovals.approvedAt)).limit(1))[0];
    return row ? toReadiness(row) : null;
  }

  async listAttempts(leadId?: string): Promise<AttemptStatusView[]> {
    const base = this.db.select().from(sendAttempts);
    const rows = leadId
      ? await base.where(eq(sendAttempts.leadId, leadId)).orderBy(desc(sendAttempts.reservedAt)).limit(20)
      : await base.orderBy(desc(sendAttempts.reservedAt)).limit(20);
    return rows.map((r) => ({ id: r.id, leadId: r.leadId, status: r.status, errorClass: r.errorClass,
      reservedAt: r.reservedAt, callStartedAt: r.callStartedAt, completedAt: r.completedAt,
      reconciledOutcome: r.reconciledOutcome, reconciledBy: r.reconciledBy,
      reconciledAt: r.reconciledAt, reconciliationNote: r.reconciliationNote }));
  }

  reconcile(input: { attemptId: string; outcome: 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT'; reconciledBy: string;
    note: string; reconciledAt: Date; gmailAccount: string; policyVersion: string }): Promise<'SENT_CONFIRMED' | 'DEFINITIVE_FAILURE'> {
    return this.db.transaction(async (tx) => {
      const attempt = (await tx.select().from(sendAttempts).where(eq(sendAttempts.id, input.attemptId)).for('update').limit(1))[0];
      if (!attempt) throw new Error('send_attempt_not_found');
      if (attempt.status !== 'OUTCOME_UNKNOWN' || attempt.reconciledOutcome !== null) throw new Error('send_attempt_not_unresolved_unknown');
      const relevantAttempts = await tx.select({ id: sendAttempts.id, status: sendAttempts.status,
        reconciledOutcome: sendAttempts.reconciledOutcome }).from(sendAttempts).where(eq(sendAttempts.scheduleId, attempt.scheduleId));
      if (relevantAttempts.length !== 1 || relevantAttempts[0]?.id !== attempt.id) throw new Error('reconciliation_requires_exactly_one_attempt');
      if (relevantAttempts.some((a) => a.status === 'SENT_CONFIRMED' || a.reconciledOutcome === 'CONFIRMED_SENT')) throw new Error('confirmed_send_already_exists');
      const lead = (await tx.select().from(leads).where(eq(leads.id, attempt.leadId)).for('update').limit(1))[0];
      const schedule = (await tx.select().from(sendSchedules).where(eq(sendSchedules.id, attempt.scheduleId)).for('update').limit(1))[0];
      const draft = (await tx.select().from(gmailDrafts).where(eq(gmailDrafts.id, attempt.gmailDraftId)).limit(1))[0];
      const readiness = (await tx.select().from(sendingReadinessApprovals).where(eq(sendingReadinessApprovals.id, attempt.readinessApprovalId)).limit(1))[0];
      const recipients = await tx.select({ value: leadFacts.value }).from(leadFacts).where(and(
        eq(leadFacts.leadId, attempt.leadId), eq(leadFacts.factType, 'contact_email'), eq(leadFacts.isCurrent, true)));
      if (!lead || lead.status !== 'NEEDS_MANUAL_REVIEW') throw new Error('lead_not_in_manual_review');
      if (!schedule || schedule.status !== 'SCHEDULED' || schedule.leadId !== lead.id) throw new Error('schedule_not_active');
      if (!draft || draft.leadId !== lead.id || draft.id !== schedule.gmailDraftId || draft.outcome !== 'DRAFT_CREATED' ||
          !draft.providerDraftId || draft.providerDraftId !== schedule.providerDraftId) throw new Error('gmail_draft_binding_changed');
      if (!readiness || readiness.gmailAccount.toLowerCase() !== input.gmailAccount || readiness.policyVersion !== input.policyVersion) throw new Error('readiness_binding_changed');
      if (recipients.length !== 1 || !recipients[0]?.value) throw new Error('verified_recipient_not_unique');
      const recipient = recipients[0].value.trim().toLowerCase();
      if (schedule.recipientEmail.toLowerCase() !== recipient || draft.recipientEmail.toLowerCase() !== recipient ||
          attempt.recipientHash !== recipientHash(recipient)) throw new Error('recipient_binding_changed');
      if (draft.gmailAccount.toLowerCase() !== input.gmailAccount || attempt.gmailAccount.toLowerCase() !== input.gmailAccount) throw new Error('account_binding_changed');
      if (!draft.finalizedEmailId) throw new Error('finalized_email_binding_missing');
      const finalization = (await tx.select({ id: emailDraftFinalizations.id, contentHash: emailDraftFinalizations.resolvedBodyHash,
        decision: emailDraftFinalizations.finalHumanDecision, reviewedAt: emailDraftFinalizations.finalReviewedAt,
        subject: emailDrafts.subject }).from(emailDraftFinalizations)
        .innerJoin(emailDrafts, eq(emailDrafts.id, emailDraftFinalizations.originalDraftId))
        .where(eq(emailDraftFinalizations.id, draft.finalizedEmailId)).limit(1))[0];
      if (!finalization || finalization.decision !== 'APPROVED' || !finalization.reviewedAt ||
          finalization.contentHash !== schedule.finalizedContentHash || finalization.contentHash !== attempt.finalizedContentHash) throw new Error('content_binding_changed');
      const scheduleFp = scheduleIntegrityFingerprint({ leadId: lead.id, gmailDraftId: draft.id,
        providerDraftId: draft.providerDraftId, finalizedContentHash: finalization.contentHash,
        recipientEmail: recipient, scheduledAtUtcMs: schedule.scheduledAtUtc.getTime(), rulesVersion: schedule.rulesVersion });
      if (scheduleFp !== schedule.integrityFingerprint || scheduleFp !== attempt.scheduleIntegrityFingerprint) throw new Error('schedule_fingerprint_changed');
      const envelopeHash = approvedEnvelopeHash({ gmailAccount: input.gmailAccount, recipientEmail: recipient,
        subject: finalization.subject, finalizedContentHash: finalization.contentHash, scheduleId: schedule.id,
        scheduledAtUtcMs: schedule.scheduledAtUtc.getTime() });
      if (envelopeHash !== attempt.approvedEnvelopeHash || sendFingerprint({ scheduleId: schedule.id,
        gmailDraftId: draft.id, approvedEnvelopeHash: envelopeHash,
        readinessApprovalId: readiness.id }) !== attempt.sendFingerprint) throw new Error('send_fingerprint_changed');
      const status = input.outcome === 'CONFIRMED_SENT' ? 'SENT_CONFIRMED' : 'DEFINITIVE_FAILURE';
      await tx.update(sendAttempts).set({ reconciledOutcome: input.outcome, reconciledBy: input.reconciledBy,
        reconciledAt: input.reconciledAt, reconciliationNote: input.note }).where(eq(sendAttempts.id, input.attemptId));
      const events = new PipelineRepository(tx);
      if (status === 'SENT_CONFIRMED') {
        await tx.update(sendSchedules).set({ status: 'FULFILLED', fulfilledAt: input.reconciledAt,
          updatedAt: input.reconciledAt }).where(eq(sendSchedules.id, attempt.scheduleId));
        const changed = await tx.update(leads).set({ status: 'SENT', updatedAt: input.reconciledAt }).where(and(
          eq(leads.id, attempt.leadId), eq(leads.status, 'NEEDS_MANUAL_REVIEW'))).returning({ id: leads.id });
        if (!changed[0]) throw new Error('manual_reconciliation_transition_failed');
      } else {
        const changed = await tx.update(leads).set({ status: 'SCHEDULED', updatedAt: input.reconciledAt }).where(and(
          eq(leads.id, attempt.leadId), eq(leads.status, 'NEEDS_MANUAL_REVIEW'))).returning({ id: leads.id });
        if (!changed[0]) throw new Error('manual_reconciliation_transition_failed');
      }
      await events.record({ leadId: attempt.leadId, runId: null, type: 'NOTE',
        fromStatus: 'NEEDS_MANUAL_REVIEW', toStatus: status === 'SENT_CONFIRMED' ? 'SENT' : 'SCHEDULED',
        message: 'Uncertain send attempt manually reconciled', data: { eventKind: 'SEND_ATTEMPT_RECONCILED',
          attemptId: attempt.id, originalAttemptStatus: 'OUTCOME_UNKNOWN', reconciliationOutcome: input.outcome } });
      return status;
    });
  }

  recordUnresolved(input: { attemptId: string; reconciledBy: string; note: string; reconciledAt: Date }): Promise<void> {
    return this.db.transaction(async (tx) => {
      const attempt = (await tx.select().from(sendAttempts).where(eq(sendAttempts.id, input.attemptId)).for('update').limit(1))[0];
      if (!attempt || attempt.status !== 'OUTCOME_UNKNOWN' || attempt.reconciledOutcome !== null) throw new Error('send_attempt_not_unresolved_unknown');
      const lead = (await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, attempt.leadId)).limit(1))[0];
      if (lead?.status !== 'NEEDS_MANUAL_REVIEW') throw new Error('lead_not_in_manual_review');
      await new PipelineRepository(tx).record({ leadId: attempt.leadId, runId: null, type: 'NOTE',
        fromStatus: null, toStatus: null, message: 'Send outcome remains unresolved; retry stays blocked',
        data: { eventKind: 'SEND_RECONCILIATION_UNRESOLVED', attemptId: attempt.id,
          reviewedBy: input.reconciledBy, reviewedAt: input.reconciledAt.toISOString(), evidenceNote: input.note } });
    });
  }
}

function toReadiness(row: typeof sendingReadinessApprovals.$inferSelect): ReadinessStatus {
  return { id: row.id, policyVersion: row.policyVersion, approvedBy: row.approvedBy,
    approvedAt: row.approvedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
    revokedBy: row.revokedBy, revokeReason: row.revokeReason };
}
