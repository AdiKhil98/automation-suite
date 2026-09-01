import { z } from 'zod';
import { type EnrichmentQuery, type EnrichmentVerificationStatus, type ReturnedIdentity } from '../../domain/contact-enrichment/types.js';

/**
 * Hunter API v2 — Email Finder + Email Verifier contract (fallback provider #2, used only after
 * Instantly preview/enrich have been tried). Verified against the current official docs:
 *
 *   1. GET /v2/email-finder    { domain, first_name, last_name }
 *      -> { data: { email, score, accept_all, verification: { status: valid|accept_all|unknown }, ... } }
 *      Free when no email is found; charges one credit only when an email is returned. The returned
 *      `verification` is ALREADY INCLUDED in that same credit — Finder's own bundled verification is
 *      the primary signal, not a separate step.
 *   2. GET /v2/email-verifier  { email }  -> { status, result, accept_all, block, disposable, ... }
 *      A SEPARATE credit-charging call, made ONLY when Finder's own verification is genuinely
 *      ambiguous/stale (its `verification.status` is `unknown`, or missing) — never automatically
 *      after every successful Finder match. When Finder's own verification is unambiguous (`valid`
 *      with accept_all=false, or `accept_all`), that signal is trusted directly and Verifier is
 *      skipped, saving the extra credit.
 *
 * The two calls are never mixed with a third "preview" endpoint: Hunter has no free domain-wide
 * search in this integration, so HunterContactEnrichmentProvider.preview() is a zero-network echo of
 * the already-known candidates (see provider.ts) — Finder/Verifier only ever run inside enrich().
 *
 * Auth: `Authorization: Bearer <HUNTER_API_KEY>` (never a query-string api_key, so the key can never
 * leak into a logged URL). Base URL: config HUNTER_API_BASE_URL (default https://api.hunter.io/v2).
 */

export const HUNTER_ENDPOINTS = {
  emailFinder: '/email-finder',
  emailVerifier: '/email-verifier',
} as const;

/** Build the email-finder query params for ONE known person at ONE company domain. */
export function buildEmailFinderParams(q: EnrichmentQuery): URLSearchParams {
  return new URLSearchParams({ domain: q.domain, first_name: q.firstName, last_name: q.lastName });
}

/** Build the email-verifier query params for ONE email address. */
export function buildEmailVerifierParams(email: string): URLSearchParams {
  return new URLSearchParams({ email });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const numv = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const boolv = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Email Finder response — the person/email guess (NOT yet independently verified). */
export const hunterFinderResponseSchema = z
  .object({
    data: z
      .object({
        first_name: z.string().nullable().optional(),
        last_name: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        score: z.number().nullable().optional(),
        domain: z.string().nullable().optional(),
        position: z.string().nullable().optional(),
        company: z.string().nullable().optional(),
        accept_all: z.boolean().nullable().optional(),
        verification: z
          .object({ status: z.string().nullable().optional(), date: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type HunterFinderResponse = z.infer<typeof hunterFinderResponseSchema>;

/** Email Verifier response. Tolerant of a `data`-wrapped or top-level shape. */
export const hunterVerifierResponseSchema = z
  .object({
    data: z
      .object({
        status: z.string().nullable().optional(),
        result: z.string().nullable().optional(),
        score: z.number().nullable().optional(),
        accept_all: z.boolean().nullable().optional(),
        block: z.boolean().nullable().optional(),
        webmail: z.boolean().nullable().optional(),
        disposable: z.boolean().nullable().optional(),
      })
      .passthrough()
      .optional(),
    status: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    accept_all: z.boolean().nullable().optional(),
    block: z.boolean().nullable().optional(),
    webmail: z.boolean().nullable().optional(),
    disposable: z.boolean().nullable().optional(),
  })
  .passthrough();
export type HunterVerifierResponse = z.infer<typeof hunterVerifierResponseSchema>;

export interface HunterVerifierFields {
  status: string | null;
  result: string | null;
  score: number | null;
  acceptAll: boolean | null;
  block: boolean | null;
  webmail: boolean | null;
  disposable: boolean | null;
}

/** Normalize the verifier response regardless of whether fields are `data`-wrapped or top-level. */
export function readVerifierFields(parsed: HunterVerifierResponse): HunterVerifierFields {
  const d = (parsed.data ?? parsed) as Record<string, unknown>;
  return {
    status: str(d['status']),
    result: str(d['result']),
    score: numv(d['score']),
    acceptAll: boolv(d['accept_all']),
    block: boolv(d['block']),
    webmail: boolv(d['webmail']),
    disposable: boolv(d['disposable']),
  };
}

/**
 * Map Hunter's verifier vocabulary to our normalized status. Fail-closed: only the unambiguous
 * deliverable+valid+non-catch-all+non-blocked combination is VERIFIED; every other signal (including
 * an unrecognized/missing status) is rejected rather than assumed safe.
 */
export function normalizeHunterVerification(f: HunterVerifierFields): EnrichmentVerificationStatus {
  if (f.block === true) return 'INVALID';
  if (f.disposable === true) return 'INVALID';
  if (f.acceptAll === true || f.status === 'accept_all') return 'CATCH_ALL';
  if (f.status === 'invalid' || f.result === 'undeliverable') return 'INVALID';
  if (f.result === 'risky') return 'RISKY';
  if (f.status === 'webmail') return 'UNKNOWN';
  // block/disposable/accept_all/invalid/risky are all ruled out above — only the unambiguous
  // deliverable+valid+non-catch-all combination is trusted.
  if (f.status === 'valid' && f.result === 'deliverable' && f.acceptAll === false) return 'VERIFIED';
  return 'UNKNOWN';
}

export interface ExtractedFinderResult {
  email: string | null;
  identity: ReturnedIdentity;
  finderScore: number | null;
  /** Finder's OWN bundled verification status, already included in the Finder credit: valid|accept_all|unknown (or null if absent). */
  finderVerificationStatus: string | null;
  acceptAll: boolean | null;
}

/** Extract the candidate email + returned identity + Finder's bundled verification from ONE Finder response (never throws — a miss is a normal, free outcome). */
export function extractFinderResult(parsed: HunterFinderResponse): ExtractedFinderResult {
  const d = (parsed.data ?? {}) as Record<string, unknown>;
  const verification = (d['verification'] && typeof d['verification'] === 'object') ? (d['verification'] as Record<string, unknown>) : {};
  return {
    email: str(d['email']),
    identity: {
      name: null,
      firstName: str(d['first_name']),
      lastName: str(d['last_name']),
      domain: str(d['domain']),
      title: str(d['position']),
    },
    finderScore: numv(d['score']),
    finderVerificationStatus: str(verification['status']),
    acceptAll: boolv(d['accept_all']),
  };
}

export type FinderVerificationDecision =
  | { kind: 'accepted'; status: 'VERIFIED' }
  | { kind: 'rejected'; status: 'CATCH_ALL' }
  | { kind: 'ambiguous' };

/**
 * Decide whether Finder's OWN bundled verification is clear enough to trust directly (no extra
 * Verifier credit), or is genuinely ambiguous/stale and needs a fresh Email Verifier call. Finder's
 * verification vocabulary is coarser than Verifier's (only valid|accept_all|unknown), so `unknown` or
 * a missing verification object is the ONLY case that triggers the extra call — fail-closed by
 * routing anything not unambiguously good or unambiguously bad through the dedicated Verifier.
 */
export function classifyFinderVerification(f: Pick<ExtractedFinderResult, 'finderVerificationStatus' | 'acceptAll'>): FinderVerificationDecision {
  if (f.acceptAll === true || f.finderVerificationStatus === 'accept_all') return { kind: 'rejected', status: 'CATCH_ALL' };
  if (f.finderVerificationStatus === 'valid' && f.acceptAll === false) return { kind: 'accepted', status: 'VERIFIED' };
  return { kind: 'ambiguous' };
}
