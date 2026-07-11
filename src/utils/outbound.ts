import { OutboundDisabledError } from './errors.js';

/**
 * Guard for any external, prospect-facing action (sending email, creating Gmail
 * drafts, publishing demos, etc.). In Phase 1 nothing calls it yet, but the guard
 * exists and is tested so later phases cannot forget it.
 *
 * An outbound action is permitted only when the global kill switch is on AND
 * dry-run is off. Default configuration (outbound off, dry-run on) blocks everything.
 */
export interface OutboundGuardConfig {
  readonly OUTBOUND_ACTIONS_ENABLED: boolean;
  readonly DRY_RUN: boolean;
}

export function isOutboundAllowed(config: OutboundGuardConfig): boolean {
  return config.OUTBOUND_ACTIONS_ENABLED && !config.DRY_RUN;
}

export function assertOutboundAllowed(action: string, config: OutboundGuardConfig): void {
  if (!config.OUTBOUND_ACTIONS_ENABLED) {
    throw new OutboundDisabledError(action, 'OUTBOUND_ACTIONS_ENABLED is not true');
  }
  if (config.DRY_RUN) {
    throw new OutboundDisabledError(action, 'DRY_RUN is enabled');
  }
}
