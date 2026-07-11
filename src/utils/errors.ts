/**
 * Typed application errors. Every thrown error in the system should be one of
 * these (or extend AppError) so callers can discriminate without string-matching.
 */

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Thrown when configuration/environment validation fails at startup. */
export class EnvValidationError extends AppError {
  constructor(message: string) {
    super('ENV_VALIDATION', message);
  }
}

/** Thrown when an invalid lead state transition is attempted. */
export class InvalidStateTransitionError extends AppError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `Invalid lead state transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

/**
 * Thrown when an outbound (external, prospect-facing) action is attempted while
 * the global kill switch is off or dry-run is enabled.
 */
export class OutboundDisabledError extends AppError {
  readonly action: string;

  constructor(action: string, reason: string) {
    super('OUTBOUND_DISABLED', `Outbound action "${action}" blocked: ${reason}`);
    this.action = action;
  }
}
