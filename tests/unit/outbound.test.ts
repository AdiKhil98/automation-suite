import { describe, expect, it } from 'vitest';
import { assertOutboundAllowed, isOutboundAllowed } from '../../src/utils/outbound.js';
import { OutboundDisabledError } from '../../src/utils/errors.js';

describe('outbound guard', () => {
  it('blocks by default (outbound off, dry-run on)', () => {
    expect(isOutboundAllowed({ OUTBOUND_ACTIONS_ENABLED: false, DRY_RUN: true })).toBe(false);
    expect(() =>
      assertOutboundAllowed('send-email', { OUTBOUND_ACTIONS_ENABLED: false, DRY_RUN: true }),
    ).toThrow(OutboundDisabledError);
  });

  it('blocks when outbound is enabled but dry-run is still on', () => {
    expect(isOutboundAllowed({ OUTBOUND_ACTIONS_ENABLED: true, DRY_RUN: true })).toBe(false);
    expect(() =>
      assertOutboundAllowed('send-email', { OUTBOUND_ACTIONS_ENABLED: true, DRY_RUN: true }),
    ).toThrow(OutboundDisabledError);
  });

  it('blocks when dry-run is off but outbound is disabled', () => {
    expect(isOutboundAllowed({ OUTBOUND_ACTIONS_ENABLED: false, DRY_RUN: false })).toBe(false);
  });

  it('allows only when outbound is enabled AND dry-run is off', () => {
    const config = { OUTBOUND_ACTIONS_ENABLED: true, DRY_RUN: false };
    expect(isOutboundAllowed(config)).toBe(true);
    expect(() => assertOutboundAllowed('send-email', config)).not.toThrow();
  });
});
