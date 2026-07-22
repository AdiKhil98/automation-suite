import { sha256Hex } from '../../utils/hash.js';

export const CONTROLLED_TEST_ACTOR = 'SYSTEM_CONTROLLED_TEST' as const;
export const CONTROLLED_TEST_REASON = 'operator-controlled end-to-end validation' as const;
export const CONTROLLED_TEST_RECIPIENT_ENV = 'TEST_RECIPIENT_EMAIL' as const;
export const CONTROLLED_TEST_OUTCOME = 'CONTROLLED_TEST_NOT_SENDABLE' as const;
export const CONTROLLED_TEST_TTL_MS = 15 * 60_000;

export type ControlledArtifactType = 'DEMO' | 'EMAIL_DRAFT' | 'FINALIZED_EMAIL';

export function normalizeControlledRecipient(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('controlled_test_recipient_invalid');
  return normalized;
}

export function controlledRecipientFingerprint(value: string): string {
  return sha256Hex(normalizeControlledRecipient(value));
}

export function assertControlledDraftRecipient(configuredRecipient: string, proposedRecipient: string): string {
  const configured = normalizeControlledRecipient(configuredRecipient);
  const proposed = normalizeControlledRecipient(proposedRecipient);
  if (configured !== proposed) throw new Error('controlled_test_recipient_changed_before_draft');
  return configured;
}

/** Bind the persisted draft row to the provider result without confusing its local
 * database UUID with Gmail's provider draft ID. */
export function assertControlledGmailDraftBinding(
  draft: { providerDraftId: string | null; recipientEmail: string },
  resultProviderDraftId: string | null,
  expectedRecipient: string,
): void {
  if (!resultProviderDraftId || draft.providerDraftId !== resultProviderDraftId
    || normalizeControlledRecipient(draft.recipientEmail) !== normalizeControlledRecipient(expectedRecipient)) {
    throw new Error('controlled_test_gmail_draft_binding_mismatch');
  }
}

export function controlledEmailArtifactHash(subject: string, body: string): string {
  return sha256Hex(`${subject.replace(/\r\n/g, '\n').trim()}\n${body.replace(/\r\n/g, '\n').trim()}`);
}

export function assertControlledTestPreflight(input: {
  controlledTest: boolean; continuePipeline: boolean; autoApproveTestArtifacts: boolean;
  recipientEnvName: string | undefined; recipientValue: string | undefined;
  targetQualified: number; dryRun: boolean; sendingEnabled: boolean; outboundActionsEnabled: boolean;
}): string {
  if (!input.controlledTest) throw new Error('controlled_test_not_requested');
  if (!input.continuePipeline) throw new Error('controlled_test_requires_continue_pipeline');
  if (!input.autoApproveTestArtifacts) throw new Error('controlled_test_requires_auto_approve_test_artifacts');
  if (input.recipientEnvName !== CONTROLLED_TEST_RECIPIENT_ENV) throw new Error('controlled_test_recipient_env_not_allowed');
  if (!input.recipientValue) throw new Error('controlled_test_recipient_missing');
  if (!input.dryRun) throw new Error('controlled_test_requires_dry_run');
  if (input.sendingEnabled) throw new Error('controlled_test_requires_sending_disabled');
  if (input.outboundActionsEnabled) throw new Error('controlled_test_requires_outbound_disabled');
  if (input.targetQualified !== 1) throw new Error('controlled_test_requires_one_qualified_lead');
  return normalizeControlledRecipient(input.recipientValue);
}

export function assertControlledExistingLeadPreflight(input: {
  stopAfterDraft: boolean; autoApproveTestArtifacts: boolean;
  recipientEnvName: string | undefined; recipientValue: string | undefined;
  dryRun: boolean; sendingEnabled: boolean; outboundActionsEnabled: boolean;
  schedulingEnabled: boolean;
}): string {
  if (!input.stopAfterDraft) throw new Error('controlled_existing_lead_requires_stop_after_draft');
  if (!input.autoApproveTestArtifacts) throw new Error('controlled_test_requires_auto_approve_test_artifacts');
  if (input.recipientEnvName !== CONTROLLED_TEST_RECIPIENT_ENV) throw new Error('controlled_test_recipient_env_not_allowed');
  if (!input.recipientValue) throw new Error('controlled_test_recipient_missing');
  if (input.dryRun) throw new Error('controlled_existing_lead_requires_live_artifact_mode');
  if (input.sendingEnabled) throw new Error('controlled_test_requires_sending_disabled');
  if (input.outboundActionsEnabled) throw new Error('controlled_test_requires_outbound_disabled');
  if (input.schedulingEnabled) throw new Error('controlled_existing_lead_requires_scheduling_disabled');
  return normalizeControlledRecipient(input.recipientValue);
}
