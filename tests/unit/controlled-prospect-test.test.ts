import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertControlledDraftRecipient, assertControlledTestPreflight, controlledEmailArtifactHash,
  controlledRecipientFingerprint } from '../../src/domain/prospect/controlled-test.js';
import { withControlledTestGates } from '../../src/cli/commands/prospect-controlled-test.js';

function preflight(over: Partial<Parameters<typeof assertControlledTestPreflight>[0]> = {}) {
  return assertControlledTestPreflight({ controlledTest: true, continuePipeline: true,
    autoApproveTestArtifacts: true, recipientEnvName: 'TEST_RECIPIENT_EMAIL',
    recipientValue: 'operator@controlled.example', targetQualified: 1, dryRun: true,
    sendingEnabled: false, outboundActionsEnabled: false, ...over });
}

describe('controlled prospect test preflight', () => {
  it('normalizes the configured test recipient without logging or business-fact mutation', () => {
    expect(preflight({ recipientValue: ' Operator@Controlled.Example ' })).toBe('operator@controlled.example');
  });

  it.each([
    [{ recipientValue: undefined }, 'controlled_test_recipient_missing'],
    [{ recipientEnvName: 'OTHER_EMAIL' }, 'controlled_test_recipient_env_not_allowed'],
    [{ targetQualified: 2 }, 'controlled_test_requires_one_qualified_lead'],
    [{ dryRun: false }, 'controlled_test_requires_dry_run'],
    [{ sendingEnabled: true }, 'controlled_test_requires_sending_disabled'],
    [{ outboundActionsEnabled: true }, 'controlled_test_requires_outbound_disabled'],
    [{ continuePipeline: false }, 'controlled_test_requires_continue_pipeline'],
    [{ autoApproveTestArtifacts: false }, 'controlled_test_requires_auto_approve_test_artifacts'],
  ] as const)('fails closed for %j', (patch, reason) => {
    expect(() => preflight(patch)).toThrow(reason);
  });

  it('binds recipient and email approvals to exact normalized content', () => {
    expect(controlledRecipientFingerprint('Operator@Controlled.Example')).toBe(controlledRecipientFingerprint('operator@controlled.example'));
    expect(controlledEmailArtifactHash('Subject', 'Body')).not.toBe(controlledEmailArtifactHash('Subject', 'Body changed'));
  });

  it('rejects a prospect address as the controlled draft recipient', () => {
    expect(() => assertControlledDraftRecipient('operator@controlled.example', 'contact@prospect.example'))
      .toThrow('controlled_test_recipient_changed_before_draft');
    expect(assertControlledDraftRecipient('Operator@Controlled.Example', 'operator@controlled.example'))
      .toBe('operator@controlled.example');
  });

  it('has no send invocation or live send-provider import in the coordinator', () => {
    const source = readFileSync(new URL('../../src/cli/commands/prospect-controlled-test.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('.send(');
    expect(source).not.toContain('HttpGmailSendProvider');
    expect(source).not.toContain('buildSendProvider');
  });
});

describe('controlled test temporary gates', () => {
  const base = () => ({
    PROSPECT_DISCOVERY_ENABLED: false, ALLOW_PAID_READS: false, ALLOW_PAID_LLM_CALLS: false,
    CAPTURE_PROVIDER: 'mock', DEMO_COMPOSER_ENABLED: false, EMAIL_GENERATION_ENABLED: false,
    NETLIFY_DEPLOYMENT_ENABLED: false, GMAIL_DRAFTS_ENABLED: false, GMAIL_DRAFT_ACTIONS_ENABLED: false,
    GMAIL_SEND_PREFLIGHT_ENABLED: false, SCHEDULING_ENABLED: false, PROSPECT_CONTINUE_PIPELINE: false,
    SENDING_ENABLED: false, OUTBOUND_ACTIONS_ENABLED: false, DRY_RUN: true,
  });

  it('enables only preparation gates and restores them after success', async () => {
    const config = base();
    const before = structuredClone(config);
    await withControlledTestGates(config as never, async () => {
      expect(config.GMAIL_DRAFT_ACTIONS_ENABLED).toBe(true);
      expect(config.GMAIL_SEND_PREFLIGHT_ENABLED).toBe(true);
      expect(config.SENDING_ENABLED).toBe(false);
      expect(config.OUTBOUND_ACTIONS_ENABLED).toBe(false);
      expect(config.DRY_RUN).toBe(true);
    });
    expect(config).toEqual(before);
  });

  it('restores every gate after a stage failure', async () => {
    const config = base();
    const before = structuredClone(config);
    await expect(withControlledTestGates(config as never, async () => { throw new Error('stage_failed'); }))
      .rejects.toThrow('stage_failed');
    expect(config).toEqual(before);
  });
});
