import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { type ScheduledSendAuthorization } from '../../domain/send/scheduled-send-authorization.js';
import { type Database } from '../db.js';
import { leads, outreachMessages, scheduledSendAuthorizations, sendAttempts, sendSchedules, sendingReadinessApprovals } from '../schema.js';
import { SendRepository } from './send.repo.js';

/**
 * The automated runner's send store: identical to {@link SendRepository} except it reads only the
 * SCHEDULED readiness lineage. `SendService` is unchanged — only the injected store differs, so the
 * manual (INTERACTIVE) readiness/TTY path is untouched.
 */
export class ScheduledSendRepository extends SendRepository {
  protected override readonly readinessSource = 'SCHEDULED' as const;
}

function toAuthorization(r: typeof scheduledSendAuthorizations.$inferSelect): ScheduledSendAuthorization {
  return {
    id: r.id,
    gmailAccount: r.gmailAccount,
    policyVersion: r.policyVersion,
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    maxPerDay: r.maxPerDay,
    createdBy: r.createdBy,
    revokedAt: r.revokedAt,
  };
}

export interface AuthorizationStatus extends ScheduledSendAuthorization {
  note: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdAt: Date;
}

/**
 * Durable scheduled-send authorization lifecycle + the derived session-readiness minting and the
 * candidate/attempt reads the automated runner needs. All writes here are additive to the existing
 * send tables; nothing mutates the manual send path.
 */
export class ScheduledSendAuthorizationRepository {
  constructor(private readonly db: Database) {}

  /** Create a durable authorization, superseding any prior non-revoked one for the account/policy. */
  async create(input: {
    gmailAccount: string;
    policyVersion: string;
    createdBy: string;
    startsAt: Date;
    expiresAt: Date;
    maxPerDay: number;
    note: string | null;
  }): Promise<AuthorizationStatus> {
    return this.db.transaction(async (tx) => {
      await tx.update(scheduledSendAuthorizations).set({
        revokedAt: input.startsAt, revokedBy: input.createdBy, revokeReason: 'superseded_by_new_authorization',
      }).where(and(
        eq(scheduledSendAuthorizations.gmailAccount, input.gmailAccount),
        eq(scheduledSendAuthorizations.policyVersion, input.policyVersion),
        isNull(scheduledSendAuthorizations.revokedAt),
      ));
      const row = (await tx.insert(scheduledSendAuthorizations).values({ id: randomUUID(), ...input }).returning())[0];
      if (!row) throw new Error('scheduled_send_authorization_insert_failed');
      return { ...toAuthorization(row), note: row.note, revokedBy: row.revokedBy, revokeReason: row.revokeReason, createdAt: row.createdAt };
    });
  }

  async revoke(input: { id: string; revokedBy: string; reason: string; revokedAt: Date }): Promise<boolean> {
    const rows = await this.db.update(scheduledSendAuthorizations).set({
      revokedAt: input.revokedAt, revokedBy: input.revokedBy, revokeReason: input.reason,
    }).where(and(eq(scheduledSendAuthorizations.id, input.id), isNull(scheduledSendAuthorizations.revokedAt)))
      .returning({ id: scheduledSendAuthorizations.id });
    return rows.length > 0;
  }

  /** The single non-revoked authorization for the account/policy (validity checked by the domain). */
  async getActive(gmailAccount: string, policyVersion: string): Promise<ScheduledSendAuthorization | null> {
    const row = (await this.db.select().from(scheduledSendAuthorizations).where(and(
      eq(scheduledSendAuthorizations.gmailAccount, gmailAccount),
      eq(scheduledSendAuthorizations.policyVersion, policyVersion),
      isNull(scheduledSendAuthorizations.revokedAt),
    )).orderBy(desc(scheduledSendAuthorizations.createdAt)).limit(1))[0];
    return row ? toAuthorization(row) : null;
  }

  async latest(gmailAccount: string, policyVersion: string): Promise<AuthorizationStatus | null> {
    const row = (await this.db.select().from(scheduledSendAuthorizations).where(and(
      eq(scheduledSendAuthorizations.gmailAccount, gmailAccount),
      eq(scheduledSendAuthorizations.policyVersion, policyVersion),
    )).orderBy(desc(scheduledSendAuthorizations.createdAt)).limit(1))[0];
    return row ? { ...toAuthorization(row), note: row.note, revokedBy: row.revokedBy, revokeReason: row.revokeReason, createdAt: row.createdAt } : null;
  }

  /**
   * Mint a short-lived SCHEDULED session readiness derived from a valid durable authorization,
   * superseding any prior active SCHEDULED readiness for the account/policy. This satisfies the
   * existing readiness gate + attempt FK without any human action and without touching INTERACTIVE
   * readiness (the manual path). Returns the new readiness id.
   */
  async mintSessionReadiness(input: {
    gmailAccount: string;
    policyVersion: string;
    authorizationId: string;
    approvedAt: Date;
    expiresAt: Date;
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      await tx.update(sendingReadinessApprovals).set({
        revokedAt: input.approvedAt, revokedBy: `scheduler:${input.authorizationId}`, revokeReason: 'superseded_by_fresh_session_readiness',
      }).where(and(
        eq(sendingReadinessApprovals.gmailAccount, input.gmailAccount),
        eq(sendingReadinessApprovals.policyVersion, input.policyVersion),
        eq(sendingReadinessApprovals.source, 'SCHEDULED'),
        isNull(sendingReadinessApprovals.revokedAt),
      ));
      const id = randomUUID();
      await tx.insert(sendingReadinessApprovals).values({
        id,
        gmailAccount: input.gmailAccount,
        policyVersion: input.policyVersion,
        approvedBy: `scheduler:${input.authorizationId}`,
        approvedAt: input.approvedAt,
        expiresAt: input.expiresAt,
        source: 'SCHEDULED',
        scheduledAuthorizationId: input.authorizationId,
      });
      return id;
    });
  }

  /** Lead ids whose active schedule is due now, oldest-slot-first, capped to `limit`. */
  async dueScheduledLeadIds(nowMs: number, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await this.db.select({ leadId: sendSchedules.leadId })
      .from(sendSchedules)
      .innerJoin(leads, eq(leads.id, sendSchedules.leadId))
      .where(and(
        eq(sendSchedules.status, 'SCHEDULED'),
        eq(leads.status, 'SCHEDULED'),
        lte(sendSchedules.scheduledAtUtc, new Date(nowMs)),
      ))
      .orderBy(asc(sendSchedules.scheduledAtUtc))
      .limit(limit);
    return rows.map((r) => r.leadId);
  }

  /** The most recent confirmed send_attempt id for a lead (to feed the enrollment bridge). */
  async latestConfirmedAttemptId(leadId: string): Promise<string | null> {
    const row = (await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(
      eq(sendAttempts.leadId, leadId),
      or(eq(sendAttempts.status, 'SENT_CONFIRMED'), eq(sendAttempts.reconciledOutcome, 'CONFIRMED_SENT')),
    )).orderBy(desc(sendAttempts.reservedAt)).limit(1))[0];
    return row?.id ?? null;
  }

  /**
   * Confirmed production sends (SENT_CONFIRMED or reconciled CONFIRMED_SENT) that have a Gmail message
   * id but NO matching outreach message yet — the self-healing recovery worklist. OUTCOME_UNKNOWN and
   * DEFINITIVE_FAILURE attempts are excluded by construction, so recovery can never enroll an uncertain
   * or failed send. Oldest-confirmed-first, bounded.
   */
  async unenrolledConfirmedSends(limit: number): Promise<Array<{ leadId: string; attemptId: string }>> {
    if (limit <= 0) return [];
    const rows = await this.db.select({ leadId: sendAttempts.leadId, attemptId: sendAttempts.id })
      .from(sendAttempts)
      .where(and(
        or(eq(sendAttempts.status, 'SENT_CONFIRMED'), eq(sendAttempts.reconciledOutcome, 'CONFIRMED_SENT')),
        isNotNull(sendAttempts.providerMessageId),
        notExists(this.db.select({ x: sql`1` }).from(outreachMessages)
          .where(eq(outreachMessages.gmailMessageId, sendAttempts.providerMessageId))),
      ))
      .orderBy(asc(sendAttempts.completedAt))
      .limit(limit);
    return rows.map((r) => ({ leadId: r.leadId, attemptId: r.attemptId }));
  }

  /** The most recent OUTCOME_UNKNOWN send_attempt id for a lead (for the run summary). */
  async latestUnknownAttemptId(leadId: string): Promise<string | null> {
    const row = (await this.db.select({ id: sendAttempts.id }).from(sendAttempts).where(and(
      eq(sendAttempts.leadId, leadId),
      eq(sendAttempts.status, 'OUTCOME_UNKNOWN'),
    )).orderBy(desc(sendAttempts.reservedAt)).limit(1))[0];
    return row?.id ?? null;
  }
}
