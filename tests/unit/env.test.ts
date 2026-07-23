import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { EnvValidationError } from '../../src/utils/errors.js';

const base = { DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/outreach' };

describe('loadConfig', () => {
  it('applies default-safe values (dry-run on, outbound off)', () => {
    const config = loadConfig({ ...base });
    expect(config.DRY_RUN).toBe(true);
    expect(config.OUTBOUND_ACTIONS_ENABLED).toBe(false);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LLM_PROVIDER).toBe('mock');
    expect(config.DEMO_ENGINE_VERSION).toBe('v1');
    expect(config.DEMO_V2_ENABLED).toBe(false);
    expect(config.DEMO_V2_CREATIVE_PROVIDER).toBe('mock');
    expect(config.DEMO_V2_TRANSLATION_PROVIDER).toBe('mock');
    expect(config.DEMO_V2_VISUAL_REVIEW_PROVIDER).toBe('mock');
  });

  it('parses explicit boolean strings', () => {
    const config = loadConfig({ ...base, DRY_RUN: 'false', OUTBOUND_ACTIONS_ENABLED: 'true' });
    expect(config.DRY_RUN).toBe(false);
    expect(config.OUTBOUND_ACTIONS_ENABLED).toBe(true);
  });

  it('coerces numeric limits', () => {
    const config = loadConfig({ ...base, MAX_LEADS_PER_RUN: '10' });
    expect(config.MAX_LEADS_PER_RUN).toBe(10);
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(EnvValidationError);
  });

  it('rejects non-boolean flag values', () => {
    expect(() => loadConfig({ ...base, DRY_RUN: 'yes' })).toThrow(EnvValidationError);
  });

  it('requires the v2 engine selector before the V2 enable flag can be armed', () => {
    expect(() => loadConfig({ ...base, DEMO_V2_ENABLED: 'true' })).toThrow(EnvValidationError);
    expect(loadConfig({ ...base, DEMO_ENGINE_VERSION: 'v2', DEMO_V2_ENABLED: 'true' }).DEMO_V2_ENABLED)
      .toBe(true);
  });
});
