import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeFileAtomicSync } from '../../utils/atomic-write.js';
import { hashCanonical, sha256Hex } from '../../utils/hash.js';
import { AppError } from '../../utils/errors.js';
import { type ExtractionCallMetadata } from './service.js';
import { type EvidencePage } from './website-evidence.js';

/**
 * Execution/idempotency record for `discover-decision-makers`. Deliberately SEPARATE from
 * `candidates.json`:
 *
 *   candidates.json — WHAT WE FOUND. Only leads with >=1 usable decision-maker. Consumed by
 *                     `contact-resolve-batch`. Its `.min(1)` fail-closed invariant is untouched, so a
 *                     hand-written `{"lead": []}` remains an operator error, not a silent result.
 *   results.json    — WHAT WE DID. Every completed extraction attempt, including the zero-candidate
 *                     ones. Consumed ONLY by `discover-decision-makers`, to decide whether spending
 *                     money on this lead again would tell us anything new.
 *
 * Without this file a valid "we looked and there is no qualifying decision-maker" answer leaves no
 * trace, so the lead stays eligible and is re-extracted at full price on every subsequent run.
 */

/** Bump when the DETERMINISTIC filter/ranking rules change in a way that could turn a previously
 * recorded outcome into a different one. Prompt and schema versions are tracked separately; this
 * covers `filterAndRankCandidates` itself, which has no version string of its own. */
export const EXTRACTION_PIPELINE_VERSION = 'dm-pipeline-1';

/** Paid attempts allowed at ONE fingerprint before an automatic run stops spending on it. Only
 * PROVIDER_ERROR consumes more than one; every other outcome is terminal at the first attempt. */
export const MAX_PAID_ATTEMPTS_PER_FINGERPRINT = 2;

export const EXTRACTION_OUTCOMES = ['FOUND', 'NO_CANDIDATE', 'SCHEMA_INVALID', 'PROVIDER_ERROR'] as const;
export type ExtractionOutcomeKind = (typeof EXTRACTION_OUTCOMES)[number];

/** Safe subset of ExtractionCallMetadata. No raw model output, no prompt text, no evidence, no keys. */
const callSchema = z.object({
  provider: z.string(),
  requestedModel: z.string(),
  resolvedModel: z.string().nullable(),
  requestId: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
  failureCategory: z.string(),
});

const resultRecordSchema = z.object({
  /** Fingerprint of the effective extraction input this record describes — see `computeExtractionFingerprint`. */
  fingerprint: z.string().min(1),
  outcome: z.enum(EXTRACTION_OUTCOMES),
  /** Paid provider requests made at THIS fingerprint. Resets when the fingerprint changes. */
  attempts: z.number().int().nonnegative(),
  firstAttemptAt: z.string().min(1),
  lastAttemptAt: z.string().min(1),
  /** Candidates written to candidates.json by the recorded attempt (0 for every non-FOUND outcome). */
  acceptedCount: z.number().int().nonnegative(),
  /** Cumulative estimated spend across attempts at this fingerprint. */
  totalCostUsd: z.number().nonnegative(),
  lastCall: callSchema.nullable(),
  /** Short, non-sensitive failure summary (Zod issue paths / provider status). Never model output. */
  note: z.string().nullable(),
});
export type ExtractionResultRecord = z.infer<typeof resultRecordSchema>;

const manifestSchema = z.object({
  version: z.literal(1),
  results: z.record(z.string(), resultRecordSchema),
});
export type ResultsManifest = z.infer<typeof manifestSchema>;

export function emptyManifest(): ResultsManifest {
  return { version: 1, results: {} };
}

// --- Fingerprint -----------------------------------------------------------------------------

export interface FingerprintInput {
  leadId: string;
  officialDomain: string;
  pages: readonly EvidencePage[];
  promptVersion: string;
  schemaVersion: string;
  provider: string;
  model: string;
  minConfidence: number;
}

/**
 * Deterministic fingerprint of the effective extraction input. Two runs that would send the model the
 * same evidence under the same contract produce the same fingerprint; anything that could legitimately
 * change the answer produces a different one.
 *
 * Contains NO timestamps, no run ids, no random values — re-running an unchanged lead must reproduce
 * the same hash exactly. Page text is digested per page (role + url + sha256 of the text) rather than
 * embedded, so the material stays small while remaining sensitive to any content change.
 *
 * `minConfidence` and EXTRACTION_PIPELINE_VERSION are included because both change which candidates
 * survive the deterministic filter, and the model output is never persisted — so a threshold or rule
 * change can only be re-evaluated by extracting again.
 */
export function computeExtractionFingerprint(input: FingerprintInput): string {
  return hashCanonical({
    pipelineVersion: EXTRACTION_PIPELINE_VERSION,
    leadId: input.leadId,
    domain: input.officialDomain.trim().toLowerCase(),
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    provider: input.provider,
    model: input.model,
    minConfidence: input.minConfidence,
    evidence: input.pages.map((p) => ({ role: p.role, url: p.url, textSha: sha256Hex(p.text) })),
  });
}

// --- Retry policy ----------------------------------------------------------------------------

export type SkipReason =
  | 'already_found'
  | 'no_candidate_recorded'
  | 'schema_invalid_blocked'
  | 'provider_error_attempts_exhausted';

export type AttemptDecision =
  | { attempt: true; reason: 'no_record' | 'fingerprint_changed' | 'retry_provider_error' | 'operator_refresh' }
  | { attempt: false; reason: SkipReason };

/**
 * Should we spend money on this lead at this fingerprint?
 *
 * FOUND / NO_CANDIDATE  -> terminal. Both are complete, valid answers; repeating them buys nothing.
 * SCHEMA_INVALID        -> blocked, NOT terminal-forever. The same evidence through the same contract
 *                          will fail the same way, so an automatic retry is deterministic waste. A
 *                          contract fix bumps the schema/prompt/pipeline version, which changes the
 *                          fingerprint and makes the lead eligible again on its own.
 * PROVIDER_ERROR        -> genuinely transient (rate limit, incomplete, refusal, upstream fault), so
 *                          worth one more paid attempt, then bounded.
 *
 * `--refresh` bypasses all of it — that is the operator's explicit override.
 */
export function decideAttempt(record: ExtractionResultRecord | undefined, fingerprint: string, refresh: boolean): AttemptDecision {
  if (refresh) return { attempt: true, reason: 'operator_refresh' };
  if (!record) return { attempt: true, reason: 'no_record' };
  if (record.fingerprint !== fingerprint) return { attempt: true, reason: 'fingerprint_changed' };
  switch (record.outcome) {
    case 'FOUND':
      return { attempt: false, reason: 'already_found' };
    case 'NO_CANDIDATE':
      return { attempt: false, reason: 'no_candidate_recorded' };
    case 'SCHEMA_INVALID':
      return { attempt: false, reason: 'schema_invalid_blocked' };
    case 'PROVIDER_ERROR':
      return record.attempts < MAX_PAID_ATTEMPTS_PER_FINGERPRINT
        ? { attempt: true, reason: 'retry_provider_error' }
        : { attempt: false, reason: 'provider_error_attempts_exhausted' };
  }
}

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  already_found: 'already extracted (candidates recorded) for this exact evidence + contract',
  no_candidate_recorded: 'already extracted: no qualifying decision-maker for this exact evidence + contract',
  schema_invalid_blocked: 'previous attempt failed local schema validation; blocked until the contract or evidence changes (or --refresh)',
  provider_error_attempts_exhausted: `provider error on ${String(MAX_PAID_ATTEMPTS_PER_FINGERPRINT)} paid attempts; blocked until the evidence changes (or --refresh)`,
};

// --- Record construction ---------------------------------------------------------------------

export interface RecordAttemptInput {
  previous: ExtractionResultRecord | undefined;
  fingerprint: string;
  outcome: ExtractionOutcomeKind;
  acceptedCount: number;
  call: ExtractionCallMetadata | null;
  note: string | null;
  now: Date;
}

/**
 * Build the record for a completed attempt. `attempts` and `totalCostUsd` accumulate only across
 * attempts at the SAME fingerprint, and only when a provider request actually completed (`call` is
 * non-null) — a request that threw before producing a billable response must not consume the budget.
 */
export function buildResultRecord(input: RecordAttemptInput): ExtractionResultRecord {
  const sameFingerprint = input.previous?.fingerprint === input.fingerprint;
  const priorAttempts = sameFingerprint ? (input.previous?.attempts ?? 0) : 0;
  const priorCost = sameFingerprint ? (input.previous?.totalCostUsd ?? 0) : 0;
  const paid = input.call !== null;
  const at = input.now.toISOString();
  return {
    fingerprint: input.fingerprint,
    outcome: input.outcome,
    attempts: priorAttempts + (paid ? 1 : 0),
    firstAttemptAt: sameFingerprint ? (input.previous?.firstAttemptAt ?? at) : at,
    lastAttemptAt: at,
    acceptedCount: input.acceptedCount,
    totalCostUsd: priorCost + (input.call?.estimatedCostUsd ?? 0),
    lastCall: input.call
      ? {
          provider: input.call.provider,
          requestedModel: input.call.requestedModel,
          resolvedModel: input.call.resolvedModel,
          requestId: input.call.requestId,
          inputTokens: input.call.inputTokens,
          outputTokens: input.call.outputTokens,
          totalTokens: input.call.totalTokens,
          estimatedCostUsd: input.call.estimatedCostUsd,
          failureCategory: input.call.failureCategory,
        }
      : null,
    note: input.note,
  };
}

// --- IO --------------------------------------------------------------------------------------

function parseManifest(path: string, text: string): ResultsManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new AppError('RESULTS_MANIFEST_INVALID_JSON', `results manifest "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError('RESULTS_MANIFEST_INVALID_SHAPE', `results manifest "${path}" has an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Returns an empty manifest when the file does not exist. A present-but-corrupt file still throws —
 * silently treating it as "nothing recorded" would re-charge every lead it covers. */
export function readResultsManifestIfExists(path: string): ResultsManifest {
  if (!existsSync(path)) return emptyManifest();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AppError('RESULTS_MANIFEST_UNREADABLE', `Could not read results manifest "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseManifest(path, text);
}

/** Atomic write, so an interrupted run can never leave a truncated manifest that would fail closed on
 * the next read. */
export function saveResultsManifest(path: string, data: ResultsManifest): void {
  writeFileAtomicSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
