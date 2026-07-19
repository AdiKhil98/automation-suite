import { z } from 'zod';

/**
 * The complete lead lifecycle. Order here is documentation only — legal movement
 * between states is defined by the transition map in state-machine.ts.
 */
export const LEAD_STATUSES = [
  'NEW',
  'NORMALIZED',
  'DUPLICATE',
  'REJECTED_AUTOMATICALLY',
  'READY_FOR_QUALIFICATION',
  'QUALIFIED',
  'READY_FOR_ENRICHMENT',
  'ENRICHED',
  'NEEDS_MANUAL_REVIEW',
  'REJECTED',
  'READY_FOR_CAPTURE',
  'CAPTURED',
  'READY_FOR_AUDIT',
  'AUDITED',
  'OPPORTUNITY_READY',
  'COMPETITOR_RESEARCH_READY',
  'DEMO_DECIDED',
  'DEMO_READY',
  'EMAIL_DRAFTED',
  'EMAIL_REVIEW_FAILED',
  'EMAIL_APPROVED',
  // Phase 9/11: an approved email using a demo_link CTA parks here until the {{DEMO_URL}}
  // placeholder is replaced with a verified deployed URL (Phase 11). Not send-ready.
  'WAITING_FOR_DEMO_URL',
  // Phase 11: a verified Netlify deploy exists and a URL-resolved finalized email was created;
  // it needs a SECOND human approval (distinct from the tokenized-draft approval).
  'FINALIZED_EMAIL_PENDING',
  'READY_FOR_HUMAN_APPROVAL',
  'HUMAN_APPROVED',
  'DRAFT_CREATED',
  // Phase 13: a deterministic send time is recorded for the created Gmail draft. NOT sent —
  // the schedule is an inert plan; Phase 14 (explicit) would act on it.
  'SCHEDULED',
  'SENT',
  'REPLIED',
  'UNSUBSCRIBED',
  'BOUNCED',
  'FAILED',
] as const;

export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof leadStatusSchema>;
