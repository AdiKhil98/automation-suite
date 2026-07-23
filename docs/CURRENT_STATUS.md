# Current Status

## Current phase

Phases 0-16 are committed and tagged. Demo Engine V2 Milestones 1 and 2 are implemented and locally verified.
Milestone 2 populates the isolated Milestone 1 foundation through a mock-only Clinic Intelligence and design
orchestration path. V1 remains authoritative: `DEMO_ENGINE_VERSION=v1`, `DEMO_V2_ENABLED=false`, and every V2
provider defaults to mock. No rendering, screenshot review, deployment, email, Gmail, scheduling, sending, live
provider, or paid-call path was added.

## Demo Engine V2 Milestone 1

- Migration `0023_demo_engine_v2_foundation.sql` adds 21 isolated `demo_v2_*` tables and changes no V1 table.
- Versioned Clinic Intelligence, primary content, translation, asset, Creative Brief, ExperiencePlan, and
  approval snapshots use deterministic SHA-256 bindings and insert-only finalized/review persistence methods.
- German, English, French, Hebrew, and Arabic are supported with explicit LTR/RTL metadata. Any missing, stale,
  rejected, unreviewed, or fingerprint-mismatched translation triggers complete primary-language fallback.
- Final translation approval and final asset-reuse approval require identified human actors. Asset availability,
  layout selection (`SELECTED`), and legal/concept reuse approval remain separate.
- Approval packages bind render and complete screenshot-set hashes, quality-rubric version/hash, and the exact
  visual-review set. Automatic pass requires overall score ≥85, zero blockers, every required category ≥70,
  and exact binding matches. It is never human or deployment approval.
- The guarded reverse refuses populated V2 tables. V1 review/deployment code does not read V2 records.

## Demo Engine V2 Milestone 2

- Deterministic Clinic Intelligence accepts only current, explicitly accepted source records, records excluded
  and contradictory inputs, selects `de`/`en`/`fr`/`he`/`ar` with LTR/RTL metadata, and fails closed when
  identity, official-site, language, or critical-fact evidence is unsafe.
- Primary-language content is structured, claim-classified, and relationally bound to exact intelligence
  sources. English translation is mock-prepared only for non-English packages and remains unavailable for use
  until a human approves the exact source and translation hashes.
- Asset discovery parses first-party HTML metadata, validates every source/redirect/final URL through the
  existing SSRF guard, classifies MIME/dimensions/quality, deduplicates by content hash, and proposes crop,
  focal-point, overlay, contrast, and fallback guidance. Every proposal remains `REUSE_REVIEW_REQUIRED`.
- A bounded mock creative provider produces a validated Creative Brief and no-code ExperiencePlan from exact
  intelligence/content/asset/manifest fingerprints. One cached translation purpose and one cached creative
  purpose are allowed per fingerprint; mock cost is zero.
- The fixture CLI and PostgreSQL repository stop at `HUMAN_REVIEW_REQUIRED`. They cannot render, approve,
  deploy, draft, schedule, or send. The CLI is strictly read-only: it prints JSON, opens no database
  connection, and performs no write. Five positive language fixtures and negative safety fixtures use only
  fictional `.example` businesses and mock bytes.
- A deterministic FAQ concierge builds up to ten topics (booking, locations, opening hours, urgent contact,
  first visit, treatment discovery, anxious-patient support, children/family care, supported languages, and
  escalation). A topic exists only with specific verified evidence; each question and answer binds to source
  IDs and record hashes, carries an escalation target, and never diagnoses, recommends treatment, or invents
  hours, services, availability, or contact channels. Unsupported topics are omitted.
- The design reference family is selected once and shared by the asset selections, Creative Brief,
  ExperiencePlan, and report. Asset selections are retired unconditionally so no stale current row survives a
  version that proposes none. The design-library manifests were replaced, changing both manifest hashes;
  previously bound artifacts would be invalidated by design, with zero current impact.

## Completed work

- The Phase 9 email writer and reviewer now enforce Cold Email Copy Standard v2. Writer output carries exactly
  three subjects, explicit evidence IDs, business relevance, urgency basis, one CTA, style scans, and demo
  alignment. Deterministic validation and an independent reviewer both fail closed; unchanged revision requests
  are never approved. Human approval remains mandatory.
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
- 553 unit and 51 PostgreSQL integration tests pass; build passes.
- Integration tests run only against a dedicated loopback `outreach_test` database, accepted by the
  destructive-test guard. The operational `DATABASE_URL` (remote Supabase pooler) is never used by tests and
  was not touched.
- Migration `0023` apply, empty reverse, clean reapply, 21-table inventory, V1-table preservation, and populated
  reverse refusal pass on a dedicated loopback test database, which was removed afterward.
- Migration `0017` apply/reverse/reapply passes.
- Final diff whitespace check and full sensitive-value/security scan pass with zero findings.
- Tests used mocked/local providers only. No live Gmail call, OAuth reauthorization, real draft read or
  mutation, live schedule/readiness record, or email send occurred.
- Local database has zero leads, schedules, send attempts, Gmail-draft rows, readiness approvals, and
  suppressions; no real seed was restored.

## Out of scope

Inbox access or modification, contact discovery, draft create/update/delete/recreation, direct
`messages.send`, replacement MIME, bulk sending, automatic retry, reply detection, follow-up automation,
live production smoke testing, and all Demo Engine V2 rendering, screenshot review, revisions, approval,
deployment, or live-provider behavior beyond the Milestone 2 orchestration foundation.
