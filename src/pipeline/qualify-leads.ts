import { type Logger } from 'pino';
import { type QualificationRules } from '../config/qualification-rules.js';
import { type Lead } from '../domain/leads/lead.js';
import { QualificationService } from '../domain/qualification/qualification-service.js';
import { type QualificationNiche } from '../domain/qualification/qualify.js';

export interface QualifyDeps {
  service: QualificationService;
  logger: Logger;
  now?: () => Date;
}

export interface QualifyOptions {
  campaign: string;
  niche: QualificationNiche;
  rules: QualificationRules;
  leads: Lead[];
}

export interface QualifySummary {
  evaluated: number;
  accepted: number;
  review: number;
  rejected: number;
  needsEnrichment: number;
  websiteDiscovery: number;
  audit: number;
  manualReview: number;
  failed: number;
}

/** Qualify a batch of leads. Each result is appended (history preserved). */
export async function qualifyLeads(deps: QualifyDeps, opts: QualifyOptions): Promise<QualifySummary> {
  const now = deps.now ?? ((): Date => new Date());
  const summary: QualifySummary = {
    evaluated: 0,
    accepted: 0,
    review: 0,
    rejected: 0,
    needsEnrichment: 0,
    websiteDiscovery: 0,
    audit: 0,
    manualReview: 0,
    failed: 0,
  };

  for (const lead of opts.leads) {
    if (!QualificationService.isQualifiable(lead.status)) continue;
    try {
      const r = await deps.service.qualify(lead.id, opts.campaign, opts.niche, opts.rules, now());
      summary.evaluated += 1;
      if (r.decision === 'ACCEPT') summary.accepted += 1;
      else if (r.decision === 'REVIEW') summary.review += 1;
      else summary.rejected += 1;
      if (r.nextStep === 'AUDIT') summary.audit += 1;
      else if (r.nextStep === 'WEBSITE_DISCOVERY') summary.websiteDiscovery += 1;
      else if (r.nextStep === 'NEEDS_ENRICHMENT') summary.needsEnrichment += 1;
      else if (r.nextStep === 'MANUAL_REVIEW') summary.manualReview += 1;
    } catch (err) {
      summary.failed += 1;
      deps.logger.error(
        { leadId: lead.id, err: err instanceof Error ? err.message : String(err) },
        'qualification failed',
      );
    }
  }
  return summary;
}
