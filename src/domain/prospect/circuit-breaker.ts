import { type ProspectCandidateResult } from './types.js';

export interface CircuitBreakerState { tripped: boolean; reason: string | null }

/** Stops after three consecutive matching verifier failures or three very-fast failures. */
export class ProspectCircuitBreaker {
  private sameSignature = 0;
  private lastSignature: string | null = null;
  private consecutiveFast = 0;
  constructor(private readonly fastFailureMs = 250) {}

  observe(result: ProspectCandidateResult): CircuitBreakerState {
    if (result.outcome !== 'WEBSITE_TRANSIENT' && result.outcome !== 'WEBSITE_INVALID') {
      this.reset(); return { tripped: false, reason: null };
    }
    const signature = `${result.failureStage ?? 'UNKNOWN'}|${result.failureCode ?? 'UNKNOWN'}`;
    this.sameSignature = signature === this.lastSignature ? this.sameSignature + 1 : 1;
    this.lastSignature = signature;
    this.consecutiveFast = result.failureElapsedMs !== null && result.failureElapsedMs !== undefined && result.failureElapsedMs <= this.fastFailureMs ? this.consecutiveFast + 1 : 0;
    if (this.sameSignature >= 3) return { tripped: true, reason: `repeated_verifier_failure:${signature}` };
    if (this.consecutiveFast >= 3) return { tripped: true, reason: 'repeated_extremely_fast_verifier_failure' };
    return { tripped: false, reason: null };
  }

  private reset(): void { this.sameSignature = 0; this.lastSignature = null; this.consecutiveFast = 0 }
}
