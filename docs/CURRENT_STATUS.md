# Current Status

## Current phase

Phase 16 is committed and tagged. Bounded niche + location + radius prospecting is committed, and a
non-sendable controlled end-to-end validation mode is implemented for final review. No Google, website,
OpenAI, Playwright, Netlify, or Gmail request was made during implementation; all outbound/sending defaults
remain disabled.

## Completed work

- Phases 0-16 are committed and tagged through `phase-16-production-safety-hardening` (`9092606`).
- Database test isolation is committed (`68a6ab3`), and website-verification observability plus independent
  Place Details persistence is committed (`6e3b591`).
- Phase 13 persists inert, deterministic, timezone-aware schedules only; it never schedules with Gmail.
- Phase 14 is the authoritative fail-closed safety controller for exactly one existing scheduled draft.
  It verifies immutable bindings twice, requires a valid expiring readiness approval and exact interactive
  confirmation, durably reserves the attempt, and permanently blocks automatic retry after uncertainty.
- Phase 14 does not claim provider-level exactly-once delivery because Gmail has no idempotency key for
  `drafts.send`.
- Migration `0015` and its reverse are committed. The verified Phase 14 suites passed before release.

## Phase 15 completed

- Added a separate `HttpGmailSendProvider` behind the existing `SendProvider`; mock remains the default.
- Allows only `users.getProfile`, `drafts.get` for one known draft id, and `drafts.send` for that same id.
- Strictly parses and compares the known draft; rejects ambiguous MIME, identity drift, Cc/Bcc, attachments,
  and any non-draft state.
- Added readiness create/revoke/status, send-attempt status, and manual uncertainty-reconciliation commands.
- Enforces an account daily cap twice, including an atomic account/day reservation lock that conservatively
  counts in-flight and unresolved attempts.
- Reuses the existing `gmail.compose` OAuth/token loading unchanged; insufficient access fails closed.
- Manual reconciliation requires an exact TTY phrase, operator identity, nonempty evidence note, exactly one
  `OUTCOME_UNKNOWN` attempt, no later/confirmed attempt, and full local binding revalidation. It never calls Gmail.
- The original attempt remains `OUTCOME_UNKNOWN`; reconciliation outcome/time/operator/note are separate audit
  metadata. Unresolved stays blocked. Confirmed-not-sent returns to `SCHEDULED` but requires fresh readiness.

## Default safety state

- `SENDING_ENABLED=false`
- `OUTBOUND_ACTIONS_ENABLED=false`
- `SENDING_PROVIDER=mock`
- `DRY_RUN=true`
- `GMAIL_DRAFT_ACTIONS_ENABLED=false`
- No live Gmail call, OAuth reauthorization, real draft read or mutation, real schedule/seed/readiness
  restoration, or email send is permitted during implementation and tests.

## Bounded prospecting implementation

- `prospect-run` accepts an approved niche, location or explicit coordinates, radius up to 50 km, qualified
  target, candidate cap up to 20, and POPULARITY/DISTANCE ranking.
- Operator niches map deterministically to an allowlist of Google Table A types; arbitrary types fail before
  provider construction.
- Location resolution is a single bounded Places Text Search and is cached; explicit coordinates bypass it.
- Nearby Search is one page/one request with `places.id` only and preserves provider order.
- Candidates are processed sequentially with existing collection deduplication, suppression, Place Details
  persistence, SSRF-hardened website verification, and deterministic qualification services.
- Candidate-specific failures are recorded and skipped. Repeated matching/very-fast verifier failures and
  provider/config/database failures stop the run as `SYSTEMIC_FAILURE`.
- `PROSPECT_DISCOVERY_ENABLED=false` and `PROSPECT_CONTINUE_PIPELINE=false` by default.
- Normal continuation still stops before deployment, Gmail, scheduling, or sending.
- `--controlled-test --test-recipient-env TEST_RECIPIENT_EMAIL --auto-approve-test-artifacts` is a separate
  exact-one-lead path that can continue through a verified preview, one test-addressed Gmail draft, read-only
  known-draft preflight, one inert schedule, and non-sendable readiness/dry-run records. It never calls send.
- Controlled approvals are short-lived and bound to run, lead, exact artifact ID/hash, and test-recipient
  fingerprint. They do not update normal human approvals or `sending_readiness_approvals`.
- The recipient override is stored separately from business facts and asserted again immediately before draft
  creation. The prospect's real email is never selected for the controlled draft.

## Phase 16 completed scope

- Reply-To integrity in every approved/provider envelope and fingerprint.
- A complete local-only dry-run readiness report and a separate structurally read-only Gmail verifier.
- Non-mutating preflight with explicit recovery separated from provider verification.
- Audited suppression add/status/revoke across email, domain, business, phone, and Place ID scopes.
- Credential-file ACL inspection/remediation tooling, tested only on temporary fictional files.
- Production retention, objection, complaint, bounce, reply, rollback, and uncertainty runbooks.

## Phase 16 implemented controls

- Reply-To is normalized, exact-or-absent, included in approved/provider hashes, and rejected when unexpected,
  duplicated, multiple, or malformed.
- `send-scheduled` dry-run reports every local readiness gate without provider access or writes.
- `gmail-send-preflight` is separately disabled by default and uses a provider boundary with profile/draft-read
  methods only; it has no send operation.
- Normal preflight is non-mutating. `recover-started-send` is the only audited path from crash-left
  `CALL_STARTED` to `OUTCOME_UNKNOWN`; retries remain blocked.
- Suppression add/status/revoke is TTY-confirmed and audited with redacted hashes. Email, domain/business,
  phone, and Place-ID scopes are rechecked before reservation.
- Credential ACL status/fix tooling is scoped to the configured Gmail files; real ACLs were not touched.
- Migration `0017` adds suppression operator/revocation metadata. Retention windows and the production runbook
  are documented in `docs/PRODUCTION_OPERATIONS.md`.

## Verification

- Lint and typecheck pass.
- 400 unit, 45 PostgreSQL integration, and 9 browser tests pass.
- Migration `0017` apply/reverse/reapply passes.
- Final diff whitespace check and full sensitive-value/security scan pass with zero findings.
- Tests used mocked/local providers only. No live Gmail call, OAuth reauthorization, real draft read or
  mutation, live schedule/readiness record, or email send occurred.
- Local database has zero leads, schedules, send attempts, Gmail-draft rows, readiness approvals, and
  suppressions; no real seed was restored.

## Out of scope

Inbox access or modification, contact discovery, draft create/update/delete/recreation, direct
`messages.send`, replacement MIME, bulk sending, automatic retry, reply detection, follow-up automation,
and live production smoke testing.
