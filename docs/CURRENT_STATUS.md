# Current Status

## Current phase

Phases 0-16 are committed and tagged. Demo Engine V2 fictional validation is complete: the fictional
acceptance package reached a live Sol score of 79 with zero blockers. Phase 3C-A — a guarded, read-only KU64
evidence export — is approved and implemented (details below). Phase 3C-B — a private, local-only review
package rendered from that exported evidence — is approved and implemented (details below); the KU64 render
itself is git-ignored and never committed, and no Sol scoring, visual review, deployment, or outreach is
authorized. Demo Engine V2 Milestones 1, 2, 3A, 3B1, and 3B2A are implemented and locally
verified. Milestone 3A adds a deterministic, code-native renderer that turns an approved fictional
ExperiencePlan into a self-contained, responsive, bilingual (DE/EN) local website bundle with a chatbot-style
FAQ concierge, plus deterministic structural quality checks, mock-only visual-review and revision contracts,
and local render/preview/screenshot/review-package tooling. V1 remains authoritative:
`DEMO_ENGINE_VERSION=v1`, `DEMO_V2_ENABLED=false`, and every V2 provider defaults to mock. No live provider,
paid call, deployment, screenshot-review model, email, Gmail, or scheduling path was added; the lifecycle
still cannot reach a real AUTO_REVIEW_PASSED, HUMAN_APPROVED, or deployment-eligible state.

## Phase 3C-A — guarded read-only KU64 evidence export

- A new `ku64-v2-export-evidence` CLI exports exactly ONE lead's already-stored, redacted pipeline evidence
  into `.local-data/ku64-v2/evidence.json` for private V2 preparation. `.local-data/` is git-ignored and is
  never staged or committed.
- Fail-closed gates (all required): `--confirm-production-read`, `ALLOW_PRODUCTION_READ_EXPORT=true`, an
  existing `--lead-id`, an `--expected-domain` that normalizes to exactly `ku64.de` (www accepted), the lead's
  own normalized domain matching that domain, a single-lead result, and an output path inside
  `.local-data/ku64-v2/`. Any unrelated/dangling record fails the export closed.
- Database access is SELECT-only. The pool opens every session `default_transaction_read_only=on` (the
  authoritative write barrier), and a Proxy guard additionally throws if any write-capable executor method
  (`insert`/`update`/`delete`/`execute`) is even reached. No INSERT/UPDATE/DELETE/DDL, migration, lock,
  mutation callback, or export-timestamp write occurs under any path.
- Exported source record types: `lead`, `lead_fact`, `qualification_result` (+ supporting lead-fact ids),
  `audit_run`, `audit_finding` (+ bound capture-evidence ids), `audit_review`, `audit_review_finding`,
  `opportunity_assessment`, `evidence` (metadata + normalized factual fields only), `capture_run`,
  `captured_page`, and `capture_evidence` (metadata only).
- Excluded by construction (never selected or emitted): raw HTML, copied page bodies, long verbatim website
  text, screenshot binaries and paths, KU64 image/media URLs, secrets/credentials, unrelated leads, and all
  email drafts/approvals/bodies, Gmail ids, and scheduling data.
- The export format is deterministic: `schemaVersion`, `leadId`, `normalizedDomain`, `exportedAt`, per-record
  `recordId`/`sourceType`/canonical `payload`/`payloadSha256`, and an aggregate `recordsSha256`. Hashing uses
  canonical (stable-sorted key) JSON over stable-sorted records and excludes `exportedAt`, so the payload and
  aggregate hashes are identical across runs.
- Status: implemented, unit-tested (21 focused cases), lint/typecheck/build green. The one authorized live
  read-only export against the operational database is an operator-run step (production read + remote target);
  the exact command is in `docs/OPERATIONS.md`.

## Phase 3C-B — private, local-only review package from exported evidence

- The committed, reusable code is business-agnostic: a generic exported-evidence → render-input adapter
  (`src/domain/demo-v2/render/evidence-render-input.ts`), a general additive `assetDisclosure` render field
  (per-language illustrative/provenance notice; absent by default, so existing renders and their hashes are
  byte-identical), a general `demo-v2-render-evidence` CLI command, and unit tests. The general renderer gained
  no business-specific conditional. No new schema, migration, provider, or persisted lifecycle state was added.
- The adapter parses the immutable export envelope and maps whitelisted records onto the existing Milestone 2
  mock orchestration, so every rendered factual claim stays bound to the exact exported record that authorized
  it. It fabricates nothing: a section is planned only when the evidence supports its required content, so
  sparse evidence yields a shorter, honest page. It performs no database, network, live-site, Sol, deployment,
  Gmail, email, or scheduling work, and makes zero paid calls (bounded mock orchestration only).
- Imagery is never taken from the export (which carries none). The caller supplies an explicit ILLUSTRATIVE
  image pool plus a per-language disclosure that is shown in the concept bar; the render therefore states, on
  the page, that its images are illustrative and do not depict the business, its premises, or its staff.
- Renders are deterministic: the adapter uses the export's own `exportedAt` timestamp as its clock (never the
  wall clock), so a given evidence file always produces a byte-identical bundle and stable hashes.
- The KU64 review package (`demos/ku64-v2/`, git-ignored) was generated locally as the one authorized use of
  the exported KU64 evidence. It renders KU64's verified identity, the six verified services (presented with
  clean spacing — the concatenated `ÄsthetischeZahnmedizin` is de-glued to `Ästhetische Zahnmedizin`, directly
  addressing finding F1 — and otherwise paraphrase-free), the verified address, the verified phone as the
  appointment/contact channel, and an evidence-gated FAQ (locations, first visit, treatment discovery,
  escalation). The two persisted audit findings F1 (READABILITY) and F2 (CTA_CLARITY) inform the build but are
  never rendered as visitor text; F3 was not restored (it does not exist in the export). The five tracked
  synthetic clinic assets form the illustrative pool (four placed; the team photograph is not placed because no
  verified person exists), all disclosed as illustrative.
- The render is primary-language (German) only: an English package is mock-prepared but withheld because it is
  not human-reviewed. Deterministic quality checks report zero blockers and `structurallyEligible: true`. The
  review package records `deploymentEligible: false`. Nothing was deployed, scored by Sol, drafted, scheduled,
  or sent, and no Gmail, OAuth, real-data, or credential state was touched.
- Still blocked pending separate explicit approval: Sol scoring, visual review/revision, human approval,
  deployment, and any outreach use of this render.

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
- 603 unit and 56 PostgreSQL integration tests pass; build passes.
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
