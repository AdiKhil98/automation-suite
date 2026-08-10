import { EMAIL_SCHEMA_VERSION } from '../../domain/email/email-schema.js';
import {
  OPERATOR_AUTHORSHIP,
  OPERATOR_EMAIL_RULES_VERSION,
  OPERATOR_SENTINEL,
} from '../../domain/email/operator-email.js';
import { type DbExecutor } from '../db.js';
import { emailDrafts } from '../schema.js';

/** A validated operator-authored email ready to persist into the existing email_drafts table. */
export interface OperatorEmailRow {
  id: string;
  leadId: string;
  subject: string;
  body: string;
}

/**
 * Persistence for operator-authored emails. It writes ONLY into the existing `email_drafts` table
 * (status `APPROVED`, `authorship='OPERATOR'`), never a parallel table. The AI-only NOT NULL columns
 * carry explicit `OPERATOR` sentinels, so provenance is honest (never represented as AI-generated).
 */
export class OperatorEmailRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Insert one operator-authored email. Exact subject/body bytes are preserved as supplied. */
  async insertApproved(row: OperatorEmailRow): Promise<void> {
    await this.db.insert(emailDrafts).values({
      id: row.id,
      leadId: row.leadId,
      demoId: null,
      runId: null,
      subject: row.subject,
      body: row.body,
      ctaKind: 'reply',
      hasDemoUrlPlaceholder: false,
      status: 'APPROVED',
      authorship: OPERATOR_AUTHORSHIP,
      // Legacy AI-writer/reviewer columns are NOT NULL; operator rows carry explicit honest sentinels.
      writerPromptVersion: OPERATOR_SENTINEL,
      reviewerPromptVersion: OPERATOR_SENTINEL,
      schemaVersion: EMAIL_SCHEMA_VERSION,
      rulesVersion: OPERATOR_EMAIL_RULES_VERSION,
      provider: 'operator',
      requestedWriterModel: OPERATOR_SENTINEL,
      requestedReviewerModel: OPERATOR_SENTINEL,
      totalCostUsd: 0,
    });
  }
}
