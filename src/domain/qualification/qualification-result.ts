export type QualificationStage = 'PRE_AUDIT';
export type QualificationDecision = 'ACCEPT' | 'REVIEW' | 'REJECT';
export type QualificationPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNASSIGNED';
export type QualificationNextStep =
  | 'AUDIT'
  | 'WEBSITE_DISCOVERY'
  | 'NEEDS_ENRICHMENT'
  | 'MANUAL_REVIEW'
  | 'SKIP';

/**
 * PRE_AUDIT qualification result. `ACCEPT` means "worth enriching/auditing", NOT
 * outreach-ready. Scores are 0..100 or null. `opportunityScore` stays null until
 * the website audit (Phase 6). `inputFactIds` are persisted authoritatively via the
 * qualification_result_facts join table.
 */
export interface QualificationResult {
  leadId: string;
  campaign: string;
  qualificationStage: QualificationStage;
  rulesVersion: string;
  rulesConfigHash: string;
  evaluatedAt: Date;
  businessViabilityScore: number | null;
  auditabilityScore: number | null;
  contactabilityScore: number | null;
  opportunityScore: number | null;
  deterministicScore: number | null;
  decision: QualificationDecision;
  priority: QualificationPriority;
  nextStep: QualificationNextStep;
  triggeredRules: string[];
  missingRequiredFacts: string[];
  reasons: string[];
  inputFingerprint: string;
  inputFactIds: string[];
}
