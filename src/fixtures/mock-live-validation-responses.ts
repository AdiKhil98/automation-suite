/**
 * Phase 7A4B — deterministic mock responder for the guarded live-model validation. Used for the default
 * offline (mock) run and for all automated tests; makes ZERO network calls. Terra (`email_write`) returns
 * the proven-good pinned base draft so the enriched path reproduces the 7A4A result; Sol
 * (`email_comparative_critique`) returns a clean advisory critique preferring the enriched email.
 */

import { type MockResponder } from '../integrations/llm/mock-llm.js';
import { SOL_CRITIQUE_SCHEMA_NAME } from '../domain/email/sol-critique-schema.js';
import { baseEmailDraft } from './competitor-email-validation/synthetic-dental-scenario.js';

const CLEAN_SOL_CRITIQUE = {
  preferredVersion: 'ENRICHED',
  baselineQualityScore: 80,
  enrichedQualityScore: 95,
  naturalnessAssessment: 'The competitor sentence reads as organic prose and does not feel bolted on.',
  credibilityAssessment: 'The cautious consequence is measured and stays within the verified evidence.',
  flowAssessment: 'Observation, competitor context, recommendation and CTA follow a natural order.',
  mechanicalWordingDetected: false,
  unsupportedClaimSuspected: false,
  criticalIssues: [] as string[],
  improvementSuggestions: [] as string[],
  advisoryVerdict: 'PASS',
};

export const defaultMockLiveValidationResponder: MockResponder = (request) => {
  if (request.task === 'email_write') {
    return { rawJson: { ...baseEmailDraft } };
  }
  if (request.schemaName === SOL_CRITIQUE_SCHEMA_NAME) {
    return { rawJson: { ...CLEAN_SOL_CRITIQUE } };
  }
  // Any other call is unexpected in this flow; return an obviously invalid body so it fails closed.
  return { rawJson: { unexpected: true } };
};
