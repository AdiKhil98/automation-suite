import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveEmailLanguage } from '../../domain/email/email-language.js';
import {
  computeOperatorEmailHash,
  OPERATOR_AUTHORSHIP,
  OPERATOR_EMAIL_RULES_VERSION,
  validateOperatorEmail,
} from '../../domain/email/operator-email.js';
import { LeadService } from '../../domain/leads/lead-service.js';
import { DeterministicFindingRepository } from '../../persistence/repositories/deterministic-finding.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { LeadsRepository } from '../../persistence/repositories/leads.repo.js';
import { OperatorEmailRepository } from '../../persistence/repositories/operator-email.repo.js';
import { PipelineRepository } from '../../persistence/repositories/pipeline.repo.js';
import { AppError } from '../../utils/errors.js';
import { type CliContext } from '../context.js';

/** The only lead status an operator email may be approved from (fail-closed otherwise). */
const APPROVABLE_FROM = 'OUTREACH_READY_DETERMINISTIC';
/** The single supported target: the EXISTING human-approval queue (no new send state/edge). */
const APPROVE_TARGET = 'READY_FOR_HUMAN_APPROVAL';

export interface OperatorEmailApproveOptions {
  lead?: string;
  finding?: string;
  subject?: string;
  bodyFile?: string;
  by?: string;
  confirm?: boolean;
}

/**
 * Persist ONE operator-authored (human-written) outreach email into the EXISTING email_drafts workflow,
 * bound to a lead's ACTIVE deterministic finding. Zero LLM/network/Gmail/Sheets/send. Single-lead only.
 *
 * Behaviour:
 *  - Requires the lead to be OUTREACH_READY_DETERMINISTIC and the cited finding to be one of its ACTIVE
 *    deterministic findings (fail-closed otherwise).
 *  - Reads the EXACT subject (arg) and body (file) as supplied and runs the deterministic operator-email
 *    copy gate. On ANY violation it prints them and exits 1 — nothing is written.
 *  - Without `--confirm` it prints the exact email that WOULD be stored + the message hash and stops.
 *  - With `--confirm` it atomically inserts the email_drafts row (status APPROVED, authorship OPERATOR),
 *    transitions OUTREACH_READY_DETERMINISTIC -> READY_FOR_HUMAN_APPROVAL, and appends an operator NOTE
 *    (deterministic finding id, cited capture-evidence ids, authorship=OPERATOR, message hash).
 *
 * It never mutates the deterministic finding, never marks anything AI-generated, and never advances the
 * lead past READY_FOR_HUMAN_APPROVAL (human approval + Gmail/send stay gated by the existing checks).
 */
export async function operatorEmailApproveCommand(
  ctx: CliContext,
  opts: OperatorEmailApproveOptions,
): Promise<void> {
  const leadId = opts.lead?.trim();
  const findingId = opts.finding?.trim();
  const subject = opts.subject;
  const bodyFile = opts.bodyFile?.trim();
  const operator = opts.by?.trim();
  if (!leadId) throw new AppError('LEAD_REQUIRED', '--lead <id> is required (exactly one lead; no bulk fallback).');
  if (!findingId) throw new AppError('FINDING_REQUIRED', '--finding <deterministic-finding-id> is required.');
  if (subject === undefined || subject.trim().length === 0) throw new AppError('SUBJECT_REQUIRED', '--subject <text> is required.');
  if (!bodyFile) throw new AppError('BODY_FILE_REQUIRED', '--body-file <path> is required (exact body text).');
  if (!operator) throw new AppError('OPERATOR_REQUIRED', '--by <operator> is required.');

  let body: string;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch {
    throw new AppError('BODY_FILE_UNREADABLE', `Could not read --body-file ${bodyFile}.`);
  }

  const lead = await ctx.leads.getById(leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found; refusing to approve.`);
  if (lead.status !== APPROVABLE_FROM) {
    throw new AppError('LEAD_NOT_APPROVABLE', `Lead is ${lead.status}; an operator email can only be approved from ${APPROVABLE_FROM}.`);
  }

  // --- read-only approval context: verify the finding is ACTIVE for this lead + gather its evidence ---
  const findingRepo = new DeterministicFindingRepository(ctx.db);
  const activeFindings = await findingRepo.listActiveComposerFindings(leadId);
  const finding = activeFindings.find((f) => f.id === findingId);
  if (!finding) {
    throw new AppError('FINDING_NOT_ACTIVE', `Finding ${findingId} is not an ACTIVE deterministic finding for lead ${leadId}.`);
  }
  const evidenceIds = await findingRepo.listFindingEvidenceIds(findingId);

  const facts = await new LeadFactsRepository(ctx.db).listCurrentFacts(leadId);
  const language = resolveEmailLanguage(facts);

  const validation = validateOperatorEmail({ subject, body, language });
  if (!validation.ok) {
    console.error(`Operator email REFUSED (fail-closed). Violations:\n  - ${validation.violations.join('\n  - ')}`);
    console.error('\nNo email written. No state change. No side effects.');
    process.exitCode = 1;
    return;
  }

  const messageHash = computeOperatorEmailHash({
    leadId,
    deterministicFindingId: findingId,
    subject,
    body,
    evidenceIds,
    rulesVersion: OPERATOR_EMAIL_RULES_VERSION,
  });

  const emailId = randomUUID();
  printPreview({ emailId, leadId, findingId, subject, body, evidenceIds, messageHash, operator });

  if (!opts.confirm) {
    console.log('\n  Dry preview only. Re-run with --confirm to persist + transition the lead.');
    console.log('  No email written. No state change. No LLM/network/Gmail/Sheet/send.');
    return;
  }

  // --- persist atomically: email_drafts row + state transition + operator NOTE ---
  await ctx.db.transaction(async (tx) => {
    const leads = new LeadsRepository(tx);
    const events = new PipelineRepository(tx);
    const leadService = new LeadService(leads, events);
    await new OperatorEmailRepository(tx).insertApproved({ id: emailId, leadId, subject, body });
    await leadService.transition(leadId, APPROVE_TARGET);
    await events.record({
      leadId,
      runId: null,
      type: 'NOTE',
      fromStatus: APPROVABLE_FROM,
      toStatus: APPROVE_TARGET,
      message: `operator-authored email persisted: ${finding.category} (by ${operator})`,
      data: {
        authorship: OPERATOR_AUTHORSHIP,
        emailId,
        deterministicFindingId: findingId,
        evidenceIds,
        messageHash,
        rulesVersion: OPERATOR_EMAIL_RULES_VERSION,
        operator,
      },
    });
  });

  console.log(`\n  Persisted operator email ${emailId} (email_drafts, status APPROVED, authorship OPERATOR).`);
  console.log(`  Lead ${leadId}: ${APPROVABLE_FROM} -> ${APPROVE_TARGET} (existing human-approval queue).`);
  console.log('  Deterministic finding unchanged. No LLM/network/Gmail/Sheet/send. Human approval still required.');
}

function printPreview(p: {
  emailId: string;
  leadId: string;
  findingId: string;
  subject: string;
  body: string;
  evidenceIds: string[];
  messageHash: string;
  operator: string;
}): void {
  console.log(`\n=== Operator-authored email (lead ${p.leadId}) ===`);
  console.log(`  authorship:        ${OPERATOR_AUTHORSHIP}`);
  console.log(`  email id:          ${p.emailId}`);
  console.log(`  deterministic finding: ${p.findingId}`);
  console.log(`  cited evidence:    ${p.evidenceIds.join(', ')}`);
  console.log(`  rules version:     ${OPERATOR_EMAIL_RULES_VERSION}`);
  console.log(`  message hash:      ${p.messageHash}`);
  console.log(`  approved/created by: ${p.operator}`);
  console.log(`\n  Subject: ${p.subject}`);
  console.log(`\n${p.body.split('\n').map((l) => `  | ${l}`).join('\n')}`);
}
