import { type Logger } from 'pino';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';

/** Human review decision. */
export type HumanDecision = 'APPROVED' | 'REJECTED';

export type ReviewActionResult = 'DONE' | 'NOOP_ALREADY' | 'NOT_FOUND' | 'INVALID_STATE';

/** One row in the review queue. Demo and email decisions are shown SEPARATELY. */
export interface LeadReviewSummary {
  leadId: string;
  businessName: string | null;
  leadStatus: string;
  demoStatus: string | null;
  emailHumanDecision: string | null;
  hasEmail: boolean;
}

export interface LeadReviewDetail {
  leadId: string;
  businessName: string | null;
  city: string | null;
  leadStatus: string;
  facts: { factType: string; value: string }[];
  findings: { findingRef: string; category: string; severity: string; observation: string; recommendation: string }[];
  demo: { id: string; status: string; path: string; approvedAt: Date | null; approvedBy: string | null; approvalNotes: string | null } | null;
  email: {
    id: string; subject: string; body: string; ctaKind: string; hasDemoUrlPlaceholder: boolean;
    reviewerDecision: string | null; humanDecision: string | null; humanNotes: string | null;
  } | null;
}

/** Reads (outside the write transaction). */
export interface ReviewReadRepo {
  listAwaiting(): Promise<LeadReviewSummary[]>;
  detail(leadId: string): Promise<LeadReviewDetail | null>;
}

/** Transaction-scoped writes + minimal reads for guarding. */
export interface ReviewWriteRepo {
  latestDemo(leadId: string): Promise<{ id: string; status: string } | null>;
  latestEmail(leadId: string): Promise<{ id: string; humanDecision: string | null } | null>;
  setDemoDecision(demoId: string, decision: HumanDecision, notes: string | null, actor: string, now: Date): Promise<void>;
  setEmailHumanDecision(emailId: string, decision: HumanDecision, notes: string | null, actor: string, now: Date): Promise<void>;
}

export interface ReviewTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  write: ReviewWriteRepo;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface ReviewUnitOfWork {
  transaction<T>(fn: (repos: ReviewTxRepos) => Promise<T>): Promise<T>;
}

export interface ReviewServiceDeps {
  uow: ReviewUnitOfWork;
  read: ReviewReadRepo;
  logger: Logger;
  actor?: string;
}

const DEMO_DECIDABLE = new Set(['GENERATED_PENDING_REVIEW', 'APPROVED', 'REJECTED']);
const EMAIL_ACTIONABLE_LEAD_STATES = new Set(['READY_FOR_HUMAN_APPROVAL', 'WAITING_FOR_DEMO_URL']);

/**
 * Phase 10 human review actions. Demo and email approvals are INDEPENDENT: a demo decision
 * touches only the demo record; an email decision touches only the email's human-review fields
 * and (when applicable) the lead state. Email approval is NEVER inferred from demo approval or
 * vice-versa. An approved demo_link email whose lead is WAITING_FOR_DEMO_URL records the wording
 * approval but keeps the lead waiting (Phase 11 inserts + validates the deployed URL); it is not
 * treated as send-ready. All actions are idempotent and guarded by the current state.
 */
export class ReviewService {
  private readonly actor: string;
  constructor(private readonly deps: ReviewServiceDeps) {
    this.actor = deps.actor ?? 'local-reviewer';
  }

  listAwaiting(): Promise<LeadReviewSummary[]> {
    return this.deps.read.listAwaiting();
  }
  detail(leadId: string): Promise<LeadReviewDetail | null> {
    return this.deps.read.detail(leadId);
  }

  decideDemo(leadId: string, decision: HumanDecision, notes: string | null): Promise<ReviewActionResult> {
    return this.deps.uow.transaction(async (repos) => {
      const demo = await repos.write.latestDemo(leadId);
      if (!demo) return 'NOT_FOUND';
      if (demo.status === decision) return 'NOOP_ALREADY';
      if (!DEMO_DECIDABLE.has(demo.status)) return 'INVALID_STATE';
      const now = new Date();
      await repos.write.setDemoDecision(demo.id, decision, notes, this.actor, now);
      await repos.events.record({ leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null, message: `demo ${decision.toLowerCase()} (human review)`, data: { demoId: demo.id, decision } });
      return 'DONE';
    });
  }

  decideEmail(leadId: string, decision: HumanDecision, notes: string | null): Promise<ReviewActionResult> {
    return this.deps.uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(leadId);
      if (!lead) return 'NOT_FOUND';
      if (!EMAIL_ACTIONABLE_LEAD_STATES.has(lead.status)) return 'INVALID_STATE';
      const email = await repos.write.latestEmail(leadId);
      if (!email) return 'NOT_FOUND';
      if (email.humanDecision === decision) return 'NOOP_ALREADY';

      const now = new Date();
      await repos.write.setEmailHumanDecision(email.id, decision, notes, this.actor, now);

      if (decision === 'REJECTED') {
        await repos.leadService.transition(leadId, 'REJECTED');
      } else if (lead.status === 'READY_FOR_HUMAN_APPROVAL') {
        // Reply-CTA email (no pending demo URL): the human approval advances the lead.
        await repos.leadService.transition(leadId, 'HUMAN_APPROVED');
      }
      // WAITING_FOR_DEMO_URL + APPROVED: wording approved, but the lead stays waiting for the
      // deployed URL (Phase 11). Not send-ready; no transition.
      await repos.events.record({ leadId, runId: null, type: 'NOTE', fromStatus: null, toStatus: null, message: `email ${decision.toLowerCase()} (human review${lead.status === 'WAITING_FOR_DEMO_URL' && decision === 'APPROVED' ? ', wording only — awaiting demo URL' : ''})`, data: { emailId: email.id, decision } });
      return 'DONE';
    });
  }
}
