# Current Status

## Current phase

Phases 0-16 are committed and tagged. Phase 17A (outreach tracking & follow-up operations) is implemented —
tracking/synchronization infrastructure only; it sends nothing and modifies no Gmail draft (details below).
Phase 17A2 (guarded live read-only Gmail reply sync) is implemented — it replaces only the mock reply reader
with a real, strictly read-only Gmail reader that is doubly gated and modifies nothing (details below).
Phase 17A3 (live Google Sheets operator dashboard) is implemented — a guarded, one-way, idempotent real
Sheets writer plus a Gmail reader-selection correction that fails closed instead of falling back to mock
(details below). Phase 17B (Controlled First Send Smoke Test) is IMPLEMENTED as a dedicated, heavily-gated
single-send path plus its tracking (details below); no real send occurred during implementation and every
sending flag remains disabled by default. Phase 17C (Delivery Failure Reconciliation) is IMPLEMENTED — a
guarded, strictly read-only Gmail DSN/bounce reconciliation path that transitions confirmed permanent bounces
to BOUNCED and cancels pending follow-ups without ever sending, modifying Gmail, or auto-retrying (details
below); no Gmail read, email, Sheet write, or follow-up occurred during implementation. Phase 17C1 (Harden DSN
Correlation) is IMPLEMENTED — eligibility now excludes already-resolved records (including the `--record`
form), correlation is time-bounded and priority-ranked (fail-closed on ambiguity), DSN parsing handles
multipart/report + nested message/rfc822 + text/plain fallback, and a narrowly-scoped operator correction
mechanism invalidates (never deletes) mis-correlated delivery events (details below); no Gmail read, email,
Sheet write, or follow-up occurred during implementation. Demo Engine V2
fictional validation is complete: the fictional
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

## Phase 7A1 — deterministic competitor candidate foundation (IMPLEMENTED; no capture/email/AI/live/sending)

- Migration `0029_competitor_research.sql` adds two additive tables and changes no existing table:
  `competitor_research_runs` (immutable/versioned; DRAFT|SUPERSEDED; idempotency unique index on
  `(lead_id,input_hash,config_hash)`; per-lead version unique index) and `competitor_candidates`
  (raw + normalized fields, disposition, score, per-component `score_breakdown`/`gate_results` jsonb,
  machine + human reasons). Capture-purpose CHECK is untouched (`COMPETITOR_CAPTURE` is a 7A2 concern).
- Deterministic comparability model with the EXACT operator-approved 100-point weights (category 45/25,
  service overlap 20, proximity 15/8, business-type 10/5/0, market 6 + language 4, location-count 0),
  threshold 70, confidence bands, and pre-scoring gates (self, prospect-branch via PSL, non-eligible
  listing, market mismatch, weak category, related-overlap, missing coords, out-of-radius). No AI, no
  hidden defaults; identical normalized input yields identical output. `COMPARABILITY_RULES_VERSION=comp-cmp-1`.
- Radius: 5 km primary, expand to 10 km only when < 2 valid inside 5 km; actual distance persisted.
  Selection: dedup (domain/provider-id/identity), one branch per parent brand (no chain domination),
  rank by score↓ then distance↑ then domain, cap 3. Fewer-than-two is a valid outcome, not a failure.
- Providers: `fixture` (JSON) and `operator_csv` only, reusing a Google-Places-shaped contract adapter.
  Live-provider requests fail closed (`LiveProviderNotAllowedError`) — never a silent fallback. Bounded
  input count. CLI: `competitor-research-plan` (read-only), `competitor-research-run` (dry report by
  default; `--apply` persists a DRAFT run and requires `COMPETITOR_RESEARCH_ENABLED=true`),
  `competitor-research-review` (read-only). One prospect at a time; no bulk/campaign mode.
- Flags default safe: `COMPETITOR_RESEARCH_ENABLED=false`. No website capture, no email-composer change
  (`competitor_evidence_used` stays `NONE`), no Gmail, no Sheets, no sending. 52 focused unit tests + a
  DB-gated integration test. Milestones 7A2–7A4 remain unapproved. See `docs/phase-7a-competitor-research.md`.

## Phase 17A — outreach tracking & follow-up operations (tracking only; NEVER sends)

- Migration `0026_outreach_tracking.sql` adds six additive `outreach_*` tables and changes no existing
  table: `outreach_campaigns`, `outreach_records` (per lead×campaign×contact; 17-state machine),
  `outreach_messages` (immutable exact subject+body snapshot + content hash), `outreach_followups`
  (explicit due dates; DUE/CANCELLED/POSTPONED/SENT), `outreach_replies`, and `outreach_events`
  (immutable, strictly-increasing per-record timeline). Guarded rollback in
  `scripts/rollback/0026_outreach_tracking_down.sql` refuses while any table holds data.
- State machine: `DRAFT_READY → AWAITING_APPROVAL → APPROVED_TO_SEND → INITIAL_SENT → FOLLOW_UP_1_* →
  FOLLOW_UP_2_* → (MEETING_BOOKED → CLOSED_WON/CLOSED_LOST)`; `REPLIED_*`, `BOUNCED`, `UNSUBSCRIBED`,
  `DO_NOT_CONTACT` may interrupt from any non-terminal state. Invalid transitions are rejected and leave
  the record unchanged. A partial-unique index prevents duplicate ACTIVE outreach per (campaign, lead,
  contact); a Gmail message id is recorded as a reply at most once.
- Rules enforced in code: do-not-contact blocks new outreach; any genuine reply/bounce/unsubscribe cancels
  all pending follow-ups; unsubscribe sets do-not-contact; follow-ups are calculated + stored but **never
  sent**. Follow-up due dates are recipient-timezone-aware and DST-correct.
- Google Sheet is a read-only operator projection (tabs: Outreach, Messages, Follow-ups Due, Replies and
  Outcomes) with stable row ids and idempotent inserted/updated/unchanged/deleted counts. The mock provider
  is the default and the only one used in tests; a real write requires `GOOGLE_SHEETS_PROVIDER=http` +
  `GOOGLE_SHEETS_SYNC_ENABLED=true` + `--confirm` (the http provider fails closed in 17A). Bodies are never
  dumped to the Sheet — the Messages tab references the version by content hash.
- Gmail reply-sync is strictly read-only over tracked threads; deterministic classification; excludes the
  account's own messages; records a short safe preview only; never sends/drafts/labels/archives/modifies.
  Mock reader only in 17A; `GMAIL_REPLY_SYNC_ENABLED=false` by default.
- CLI: `outreach-init`, `outreach-track`, `outreach-record-message`, `outreach-transition`,
  `outreach-schedule-followup`, `outreach-cancel-followup`, `outreach-postpone-followup`,
  `outreach-followups-due`, `outreach-sync-replies`, `outreach-sync-sheet`, `outreach-timeline`,
  `outreach-readiness`. New flags default safe: `OUTREACH_TRACKING_ENABLED=false`,
  `GMAIL_REPLY_SYNC_ENABLED=false`, `GOOGLE_SHEETS_SYNC_ENABLED=false`. All existing sending guards
  unchanged (`SENDING_ENABLED=false`, `OUTBOUND_ACTIONS_ENABLED=false`, `DRY_RUN=true`,
  `GMAIL_DRAFT_ACTIONS_ENABLED=false`).
- Status: implemented; lint/typecheck/build green; 757 unit tests (incl. 37 new outreach cases across state
  machine, reply classification, follow-up calculation, service behavior, reply-sync, and Sheet sync) and
  66 PostgreSQL integration tests (incl. a new outreach suite covering migration, duplicate-active
  constraint, immutable history, reply→cancel, timeline ordering, idempotent Sheet projection) pass. No
  email, Gmail draft/read, follow-up send, or external Sheet write occurred. **Phase 17B — Controlled First
  Send Smoke Test — is NOT approved.**

## Phase 17A2 — guarded live read-only Gmail reply sync (reads only; NEVER sends/drafts/modifies)

- Replaces ONLY the mock reply reader with `HttpGmailThreadReader`, a real reader for the existing
  `GmailThreadReader` boundary. It issues exactly one kind of request —
  `GET /gmail/v1/users/me/threads/{trackedThreadId}?format=metadata` — for thread ids that already belong to
  tracked outreach records. There is, by construction, no send/draft/label/archive/trash/modify method and no
  mailbox-wide `messages.list`/`threads.list`/`q=` search on the class. `format=metadata` means message
  bodies are never downloaded; only `From/Date/Content-Type/Auto-Submitted/List-Unsubscribe` headers plus
  Gmail's own short `snippet` (stored truncated via `safePreview`) are read.
- **Scope isolation:** reading needs a read scope the existing `gmail.compose` grant does not have. A new
  `GMAIL_READONLY_SCOPE = gmail.readonly` is granted by a dedicated one-time `gmail-read-auth` command into a
  SEPARATE git-ignored 0600 file (`GMAIL_READ_CREDENTIALS_FILE=.gmail-read-credentials.json`), entirely
  distinct from the sending credential. The reader's `verifyReadAccess()` refuses to operate unless the stored
  scope is EXACTLY `gmail.readonly` (a mixed or compose scope fails closed). No sending/draft OAuth grant is
  touched or re-consented.
- **Fail-closed gates (all required for any live read):** `GMAIL_REPLY_SYNC_ENABLED=true` AND the explicit
  `--confirm-gmail-read` flag (`liveReplyReadGate`), a present read-only credential, and the exact-scope
  check. Absent any of these, the command falls back to the read-only mock reader and prints why. The mock
  reader remains the default; the standard test suite performs no real Gmail read (fake transport only).
- Detection semantics are unchanged and reused: inbound messages strictly after the latest tracked outbound,
  excluding the configured account's own messages; the existing deterministic (non-AI) classifier; a genuine
  reply cancels pending follow-ups; unsubscribe sets `DO_NOT_CONTACT`; bounce handling preserved. Captured per
  reply: Gmail message id, thread id, received timestamp, and a short safe preview only.
- CLI: `outreach-sync-replies` now accepts `--confirm-gmail-read`, `--record <id>`, `--campaign <name>` (one
  record / one campaign / all eligible tracked threads). New `gmail-read-auth` performs the one-time readonly
  consent.
- Status: implemented; lint/typecheck/build green; new unit tests cover flag/confirm rejection, exact-scope
  guard, self-exclusion, inbound detection, old-message exclusion, untracked-thread inaccessibility,
  follow-up cancellation, unsubscribe→DNC, bounce, zero mutation methods, and GET-only transport — all with
  mocks. No real Gmail read or modification occurred during implementation. **Phase 17A3 (live Sheets) is now
  implemented (see below); Phase 17B (sending) remains NOT approved.**

## Phase 17A3 — live Google Sheets operator dashboard (one-way projection; NEVER sends/imports)

- **Gmail reader-selection correction.** `outreach-sync-replies` no longer silently downgrades to the mock
  reader when a live read is requested but a guard fails. A pure `selectReplyReader` decision now governs it:
  a LIVE read is selected the moment intent is present (`GMAIL_REPLY_SYNC_ENABLED=true` OR
  `--confirm-gmail-read`); once live, EVERY guard (both gates, present readonly credential, exact
  `gmail.readonly` scope) must pass or the command exits nonzero (`AppError`). The mock reader runs ONLY when
  explicitly selected with the new `--mock` flag; selecting neither (or both) is refused with a nonzero exit.
- **Real Google Sheets provider.** `HttpSheetsProvider` replaces the fail-closed placeholder. Postgres stays
  authoritative; the Sheet is a ONE-WAY operator projection over the existing Phase 17A projection and
  `SheetsProvider` interface. It only ever GETs spreadsheet metadata, GETs a tab's values (to diff), and POSTs
  a SINGLE atomic `:batchUpdate` `updateCells` per tab (plus `addSheet` for a missing tab). Column A holds the
  stable row id (`outreach:<id>`, `message:<id>`, `followup:<id>`, `reply:<id>`); rows are ordered by that id
  so re-runs never reshuffle. Sync is idempotent and reports inserted/updated/unchanged/removed-stale counts.
  It never reads a Sheet value back into Postgres, never dumps full message bodies (the Messages tab references
  the version by content hash — the projection carries no body field), and exposes no secret or internal
  database metadata. A single atomic write means a transport failure leaves the tab in its prior committed
  state (no partial row write).
- The four existing tabs are synced: **Outreach**, **Messages**, **Follow-ups Due**, **Replies and Outcomes**.
  A FULL sync mirrors Postgres exactly (removes stale rows); a SCOPED per-campaign sync is upsert-only
  (`deleteStale=false`) so another campaign's rows are never touched.
- **Fail-closed write gates (all required):** `GOOGLE_SHEETS_PROVIDER=http`, `GOOGLE_SHEETS_SYNC_ENABLED=true`,
  `--confirm-sheet-write`, a configured `GOOGLE_SHEETS_SPREADSHEET_ID`, and valid credentials whose stored scope
  is EXACTLY `https://www.googleapis.com/auth/spreadsheets`. Missing any → nonzero exit, no mock fallback, no
  partial write. The default remains mock/off (the mock provider is in-memory only, no external effect).
- **Authentication.** Reuses the existing installed-app loopback OAuth pattern (same Google Cloud OAuth
  client) via a new one-time `sheets-auth` command, granting ONLY the minimum `spreadsheets` scope and storing
  the refresh token in a SEPARATE git-ignored 0600 file (`GOOGLE_SHEETS_CREDENTIALS_FILE`, default
  `.google-sheets-credentials.json`). No Gmail credential is read or written.
- **CLI:** `sheets-auth` (one-time consent); `outreach-sync-sheet` gains `--preview` (build + print projection
  counts, write nothing), `--campaign <name>` (scoped upsert-only sync), and `--confirm-sheet-write` (default
  is a full sync of all outreach records); `outreach-sheet-verify` confirms configuration and — for the http
  provider — credentials + spreadsheet/tab access without modifying data.
- Status: implemented; lint/typecheck/build green; new unit tests cover the reader-selection guarantee
  (never mock for a live intent, `--mock`-only mock, conflict/none refusal) and the real Sheets provider
  (verifyAccess exact-scope guard, insert/update/unchanged counts, idempotent second sync, stable column-A row
  ids, full-sync stale removal, scoped upsert-only preservation, one-way overwrite of manual edits, no partial
  write after a failure, no secret/full-body leakage). The full unit suite (796) and the PostgreSQL integration
  suite (66, incl. the outreach suite exercising the campaign-filtered projection) pass. **No Gmail read, no
  Sheet write, no email, no draft, and no follow-up occurred during implementation or tests.** **Phase 17B —
  Controlled First Send Smoke Test — remains NOT approved.**

## Phase 17B — controlled first-send smoke test (exactly ONE tracked send; heavily gated)

- A NEW, dedicated, outreach-native send path (`OutreachSmokeSendService`) performs EXACTLY ONE fully-tracked,
  allowlisted send and nothing else. It does not touch the Phase 14/15 schedule/readiness `SendService`; it
  reuses the existing safeguarded provider primitives — create a Gmail DRAFT (Phase 12
  `GmailDraftProvider.createDraft`), verify that exact known draft, then dispatch it (Phase 15
  `SendProvider.sendExistingDraft`). No new raw `messages.send` path was added.
- **Fail-closed guard set (all required, evaluated by a pure, unit-tested function before any provider call):**
  `OUTREACH_SMOKE_TEST_ENABLED=true`, `SENDING_ENABLED=true`, `OUTBOUND_ACTIONS_ENABLED=true`, `DRY_RUN=false`,
  `SENDING_PROVIDER=http`, the `--provider http` argument, the explicit `--confirm-phase-17b` flag, an exact
  `--sender` match to `GMAIL_ACCOUNT_EMAIL` (and the provider-verified account must equal it), an allowlisted
  `--recipient` equal to `OUTREACH_SMOKE_TEST_RECIPIENT` (and the tracked record's contact must equal it too),
  exactly one recipient, no Cc/Bcc, the record in `APPROVED_TO_SEND`, a stored INITIAL step-0 message whose
  stored content hash matches its stored subject/body, a valid unexpired human approval
  (`OUTREACH_APPROVAL_TTL_MINUTES`), no do-not-contact, and no prior successful send.
- **Data model (within migration 0026 — no new migration):** one campaign `Phase 17B Smoke Test`, ONE synthetic
  internal test lead (never a real prospect), one outreach record, and the immutable INITIAL step-0 message
  (exact subject + body + SHA-256). Human approval is recorded as the message's `approved_at` plus the record's
  `APPROVED_TO_SEND` state and an immutable event. On a confirmed send the record advances to `INITIAL_SENT`
  atomically with: the message's Gmail message/thread id + sent timestamp attached (subject/body/hash never
  mutated), an immutable `STATE_TRANSITION` + send `NOTE` event, and a tracking-only follow-up (step 1, `DUE`)
  that is created but NEVER auto-sent.
- **Uncertainty handling:** a provider send that returns `unknown`, or a persistence failure AFTER a confirmed
  send, is NEVER auto-retried. The command prints the exact idempotent recovery command
  (`outreach-smoke-reconcile`), which attaches the confirmed Gmail ids WITHOUT sending and refuses if a send is
  already recorded.
- **CLI:** `outreach-smoke-init` (create the one controlled test record at `AWAITING_APPROVAL`; never sends),
  `outreach-smoke-approve` (record human approval → `APPROVED_TO_SEND`; never sends), `outreach-smoke-send` (the
  ONE guarded real send), and `outreach-smoke-reconcile` (recovery only; never calls Gmail). New flags default
  safe: `OUTREACH_SMOKE_TEST_ENABLED=false`; `OUTREACH_SMOKE_TEST_RECIPIENT` unset; `OUTREACH_APPROVAL_TTL_MINUTES=60`.
- Status: implemented; lint/typecheck/build green; 830 unit tests pass (incl. 34 new smoke-send cases:
  wrong sender/recipient rejected, missing confirmation rejected, each sending guard rejected, duplicate send
  rejected, expired/missing approval rejected, exact content hash required, single-recipient + no-Cc/Bcc caps,
  successful send persists message/thread ids, persistence failure never auto-retries, follow-up created but
  never sent, unknown outcome not retried, draft-envelope verification, no bulk/batch path reachable, and the
  sent message projects into the Messages tab by content hash — never its body). **No real email, Gmail send,
  Gmail draft, external Sheet write, or follow-up send occurred during implementation or tests.** The single
  authorized real send is an operator-run step; the exact commands are in `docs/OPERATIONS.md`.

## Phase 17C — delivery failure reconciliation (read-only DSN detection; NEVER sends)

- **Root cause of the incident.** Phase 17B recorded the outbound as `INITIAL_SENT` on a confirmed Gmail
  `drafts.send`, but Gmail later emitted a SEPARATE Delivery Status Notification (`550 5.7.1` — likely
  unsolicited mail) in a different thread; the recipient never received the mail. The pipeline had no path to
  detect that asynchronous bounce, so the outreach state stayed falsely "sent" and a follow-up remained armed.
- **Delivery-event model.** Migration `0027` adds ONE additive `outreach_delivery_events` table (no existing
  table altered) recording the correlation between a tracked outbound and a DSN plus the auditable diagnostics:
  `delivery_status` (DELIVERED/BOUNCED/DELIVERY_UNKNOWN), `permanence` (PERMANENT/TEMPORARY/UNKNOWN), the
  rejection code, diagnostic text, RFC 3463 status + RFC 3464 action, final/original recipient, bounce
  timestamp, the ORIGINAL outbound Gmail message/thread ids, and the DSN's OWN Gmail message/thread ids. The
  DSN Gmail message id is a unique idempotency key (recorded at most once). The immutable sent-message row is
  never mutated — a message stays historically SENT while its outreach state becomes BOUNCED.
- **DSN detection (read-only).** A new guarded bounce reader (`HttpGmailBounceReader`) issues only GETs — a
  bounded `messages.list` scoped to delivery-notification markers AND the tracked recipients (so the search is
  connected to tracked outbounds and finds DSNs even in a separate thread), then `messages.get?format=full` to
  parse the standard `multipart/report` / `message/delivery-status` structure. It has, by construction, no
  send/draft/label/archive/trash/modify method, refuses unless the stored scope is EXACTLY `gmail.readonly`,
  and fails closed (empty) on any error. Correlation is deterministic and PURE (no AI): RFC Message-ID
  reference, then shared Gmail thread, then failed-recipient address; it fails closed on ambiguity and never
  classifies an unrelated or non-DSN message. Only necessary diagnostic fields and a short safe preview are
  stored.
- **State & follow-up behavior.** A confirmed permanent (5.x.x/550) bounce transitions the record to `BOUNCED`,
  cancels every pending follow-up with an explicit blocked reason, and appends immutable `BOUNCE_DETECTED` +
  `FOLLOWUPS_CANCELLED` events while preserving the original `INITIAL_SENT` event and sent timestamp. It does
  NOT set do-not-contact (policy) and NEVER auto-retries. A temporary (4.x.x) failure is recorded as
  `DELIVERY_UNKNOWN` for operator review with no state change and no retry. Reconciliation is idempotent per DSN.
- **Command.** `outreach-reconcile-delivery` supports `--record`, `--campaign`, all eligible unresolved sent
  records, a `--dry-report` mode (proposed correlation + state change, no writes), and `--mock`. A live Gmail
  read requires `GMAIL_REPLY_SYNC_ENABLED=true` + `--confirm-gmail-read` + the exact read-only credential; a
  requested live read that fails any guard exits nonzero and NEVER falls back to mock (reuses the Phase 17A3
  `selectReplyReader` decision). The exact operator command to reconcile the Phase 17B incident record
  (`acded064-b681-4c0d-9d16-45966a5edc43`) is in `docs/OPERATIONS.md`; it is an operator-run step and was not
  run during implementation.
- Status: implemented; lint/typecheck/build green; 876 unit tests pass (incl. 46 new Phase 17C cases across
  correlation/classification, the service bounce/temporary/idempotent paths, the reconciliation orchestrator,
  and the read-only bounce reader — permanent 550 bounce, temporary 4xx, separate-thread correlation, RFC
  Message-ID correlation, wrong-recipient ignored, unrelated DSN ignored, ambiguous rejected, INITIAL_SENT
  history preserved, BOUNCED transition, follow-ups cancelled, no auto-retry, zero Gmail-mutation methods,
  GET-only transport, live-guard-never-mock, idempotent repeat). A PostgreSQL integration case exercises the
  migration + bounce reconciliation end-to-end (runs where a local test DB is configured). **No Gmail read,
  email, Gmail modification, external Sheet write, or follow-up occurred during implementation or tests.**

## Phase 17C1 — harden DSN correlation (read-only; NEVER sends)

- **Root cause of the second incident.** Reconciling record `acded064-…` attached FIVE false
  `DELIVERY_UNKNOWN` events (two from 2026-07-30, three from May 2026 — before the tracked email existed), even
  though the record was already correctly `BOUNCED` by the reply-sync path. The `--record` reconciliation path
  ignored the record's terminal state, and recipient-only correlation had no time window, so historical DSNs
  for the same address attached to a later send.
- **Eligibility filtering.** `trackedOutbounds` now requires a sent timestamp, a Gmail/RFC message id, AND an
  UNRESOLVED record (not `BOUNCED`/`UNSUBSCRIBED`/`DO_NOT_CONTACT`/`CLOSED_WON`/`CLOSED_LOST`) for EVERY form,
  including `--record`. `applyDeliveryFailure` additionally fails closed on a terminal record — `SKIPPED_TERMINAL`,
  writing no delivery event — so a record resolved by another path never accrues late duplicates.
- **Time-window filtering.** A DSN must be received after the outbound sent time (± a documented 5-minute clock
  skew, `DSN_CLOCK_SKEW_MS`). A DSN that predates the outbound can never correlate to it; the three May DSNs are
  rejected (`BEFORE_SENT`).
- **Correlation strength.** Priority: (1) exact RFC Message-ID reference, (2) exact original Gmail message id,
  (3) exact outbound Gmail thread id, (4) recipient-only — and recipient-only ONLY when exactly one unresolved
  outbound matches within a narrow 14-day window (`DSN_RECIPIENT_WINDOW_MS`) and no stronger identifier
  conflicts. Ambiguity is rejected; the dry report surfaces the correlation strength and every skip reason
  (`NOT_A_DSN`/`NO_CORRELATION`/`BEFORE_SENT`/`OUTSIDE_WINDOW`/`AMBIGUOUS_CORRELATION`).
- **DSN parsing.** Handles `multipart/report`, `message/delivery-status`, nested `message/rfc822`, and a
  `text/plain` fallback; extracts Action / Status / Diagnostic-Code / Final-Recipient / Original-Recipient /
  Original-Message-ID / X-Failed-Recipients, with a free-text scan when structured parts are absent. `550 5.7.1`
  and `5.x.x` → PERMANENT (BOUNCED); `4.x.x` → TEMPORARY; UNKNOWN only when no reliable status exists.
- **Operator correction (never deletes history).** Migration `0028` adds additive `superseded_at` /
  `superseded_reason` / `superseded_by` columns. The new `outreach-correct-delivery-events` command (dry-run by
  default; `--apply` needs `--by` + `--reason`) INVALIDATES named delivery events by marking them superseded and
  appends one immutable `DELIVERY_RECONCILIATION_CORRECTED` event per affected record. It changes NO outreach
  state and touches NO follow-up — the record stays `BOUNCED` with its follow-up cancelled — is idempotent, and
  touches no Gmail. The exact dry-run + apply commands for the five incident DSN ids are in `docs/OPERATIONS.md`
  (an operator step; not run during implementation).
- Status: implemented; lint/typecheck/build green; 888 unit tests pass (incl. new 17C1 cases: DSN before
  sentAt rejected, May DSN cannot correlate to the July outbound, terminal BOUNCED record skipped, RFC
  Message-ID wins, Gmail message id wins, thread correlation, recipient-only bounded window, ambiguous
  recipient rejected, 550 5.7.1 parsed as permanent, multipart/report + nested message/rfc822 + text/plain
  parsing, incorrect events invalidated-not-deleted, repeated correction idempotent, zero Gmail-mutation
  methods). PostgreSQL integration cases exercise the eligibility exclusion and the correction end-to-end (run
  where a local test DB is configured). **No Gmail read, email, Gmail modification, external Sheet write, or
  follow-up occurred during implementation or tests.**

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
- `OUTREACH_SMOKE_TEST_ENABLED=false` (Phase 17B single-send path off; `OUTREACH_SMOKE_TEST_RECIPIENT` unset)
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
