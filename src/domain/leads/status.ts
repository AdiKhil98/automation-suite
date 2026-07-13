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
  'READY_FOR_AUDIT',
  'AUDITED',
  'OPPORTUNITY_READY',
  'COMPETITOR_RESEARCH_READY',
  'DEMO_DECIDED',
  'DEMO_READY',
  'EMAIL_DRAFTED',
  'EMAIL_REVIEW_FAILED',
  'EMAIL_APPROVED',
  'READY_FOR_HUMAN_APPROVAL',
  'HUMAN_APPROVED',
  'DRAFT_CREATED',
  'SENT',
  'REPLIED',
  'UNSUBSCRIBED',
  'BOUNCED',
  'FAILED',
] as const;

export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof leadStatusSchema>;
