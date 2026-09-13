/**
 * Structured record of a Gmail READ that did not complete.
 *
 * WHY THIS EXISTS. Both read-only Gmail readers deliberately return an empty result when a read
 * fails, so that a transport error can never be mistaken for "a reply exists" or "a bounce
 * exists" — inferring an inbound event from an error would be the dangerous failure. The cost of
 * that choice is that a total Gmail outage is indistinguishable, at the return value, from
 * "checked the inbox, nothing new".
 *
 * When a caller needs to tell those two apart — an unattended pre-check that must refuse to let
 * follow-up automation reason about an inbox it could not actually read — it needs the failure as
 * DATA, not as a log line to scrape. Readers therefore record each failed read here, and callers
 * ask for them explicitly.
 *
 * Recording a failure NEVER changes what a read returns: default behaviour is untouched, and no
 * caller is forced to look. Strictness is the caller's decision.
 *
 * A read that succeeds and legitimately finds nothing is NOT a failure and is never recorded.
 */

export type GmailReadFailureReason =
  /** The request never produced a response: network error, DNS, TLS, timeout, aborted socket. */
  | 'transport'
  /** A response arrived with a non-2xx status: 401, 403, 429, 5xx, and so on. */
  | 'http_status'
  /** A 2xx response whose body was absent or unusable — read as "unknown", never as "empty". */
  | 'malformed_response';

/** Which read was attempted. Kept coarse so it stays provider-agnostic. */
export type GmailReadScope =
  /** Reading the messages of one known thread (reply sync). */
  | 'thread'
  /** The scoped delivery-notification search (bounce reconciliation). */
  | 'search'
  /** Fetching one candidate delivery notification by id. */
  | 'message';

export interface GmailReadFailure {
  scope: GmailReadScope;
  /** Thread or message id; null for a search-level failure. */
  id: string | null;
  reason: GmailReadFailureReason;
  /** HTTP status when a response arrived, else null. */
  status: number | null;
  /** Short, safe diagnostic. Never a token, header, or mailbox body. */
  detail: string;
}

/**
 * Collector held by a reader for the duration of a run. Append-only from the reader's side; the
 * caller reads the list once the run is over.
 */
export class GmailReadFailureLog {
  private readonly failures: GmailReadFailure[] = [];

  record(failure: GmailReadFailure): void {
    this.failures.push(failure);
  }

  /** Every read that failed during this run, in the order they were attempted. */
  list(): readonly GmailReadFailure[] {
    return [...this.failures];
  }

  get count(): number {
    return this.failures.length;
  }

  /** Reset between runs of the same reader instance. */
  clear(): void {
    this.failures.length = 0;
  }
}

/** Classify a non-2xx / unusable response into a reason + status. */
export function classifyHttpReadFailure(status: number, hasJson: boolean): { reason: GmailReadFailureReason; status: number } {
  if (status >= 200 && status < 300 && !hasJson) return { reason: 'malformed_response', status };
  return { reason: 'http_status', status };
}

/** One-line, operator-facing summary. Safe to print: ids and statuses only. */
export function summarizeGmailReadFailures(failures: readonly GmailReadFailure[]): string {
  return failures
    .map((f) => `${f.scope}${f.id === null ? '' : ` ${f.id}`}: ${f.reason}${f.status === null ? '' : ` (${String(f.status)})`}`)
    .join('; ');
}
