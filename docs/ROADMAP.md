# Roadmap

**Status:** Phases 0-16 are complete, committed and tagged through
`phase-16-production-safety-hardening` (`9092606`). Bounded radius prospecting is committed (`2fe45de`).
A post-Phase-16 controlled validation orchestrator remains non-sendable. Demo Engine V2 fictional validation
is complete — a fictional acceptance package reached a live Sol score of 79 with zero blockers. **Phase 3C-A —
a guarded, read-only KU64 evidence export — is approved and implemented.** **Phase 3C-B — a private,
local-only review package rendered from that exported evidence — is approved and implemented** (reusable
adapter + tests + docs committed; the KU64 render is git-ignored and never committed). No Sol scoring, visual
review, deployment, or outreach use of the render is authorized. Demo Engine V2
Milestones 1 and 2 are implemented as an isolated, disabled-by-default, mock-only intelligence/content/asset/
design foundation. No V2 render, approval, deployment, or live-provider path exists. Phase 9 email generation
uses Cold Email Copy Standard v2 with deterministic and independent-reviewer quality gates.
**Deterministic outreach-finding bridge — implemented in code (pending review): migration `0034` +
`deterministic-finding-approve` CLI + `OUTREACH_READY_DETERMINISTIC` status let an operator promote an
evidence-backed, template-constrained finding into outreach composition (outreach-compose-preview only) when
an AI audit yielded no safe finding, without fabricating an AI audit. Migration NOT applied; no Whitgift
finding created; `generate-emails` not wired.**
**Operator-authored email (minimal reuse) — implemented in code (pending review): migration `0035` adds one
`email_drafts.authorship` column (`AI` default / `OPERATOR`) + `operator-email-approve` CLI + one state edge
`OUTREACH_READY_DETERMINISTIC -> READY_FOR_HUMAN_APPROVAL`, so a human-written email is stored in the EXISTING
email_drafts workflow (no parallel subsystem, never marked AI) and reaches the existing human-approval path.
No LLM. Migration NOT applied; no email persisted; Gmail/send stay gated off.**
**Reply-email finalization (minimal reuse) — implemented in code (pending review): migration `0036` makes the
demo-only finalization columns nullable + adds a `kind` discriminator (`DEMO_URL_RESOLVED`/`REPLY_DIRECT`), so
an already HUMAN_APPROVED reply email gets the `email_draft_finalizations` record the Gmail gate requires
WITHOUT a demo/Netlify/{{DEMO_URL}} (second producer for the same table; gate + demo path unchanged).
`reply-email-finalize` + `set-contact-email` CLIs. No LLM. Migration NOT applied; nothing persisted; Gmail
flags unchanged; no draft/send.**
**Bounded online-booking discovery — Layer 2 committed (`fix(audit): discover bounded online booking
paths`): same-origin booking routes are now eligible for one bounded secondary capture so the audit observes
online booking before any booking-friction conclusion (no crawl; external provider links detected but never
crawled). Layer 1 (provider-host/keyword detection + the "assert absence only on a booking-aware capture,
else UNKNOWN" rule) is implemented but preserved uncommitted with the deterministic-finding bridge.**
**Confirmed decisions (2026-08-09): Whitgift BOOKING_FRICTION is DISPROVEN (functional HSOE online booking
exists) — no email from it, no Whitgift finding; presence-only competitor claim rule (state verified patterns,
never claim they cause more patients/revenue/conversions/rankings/performance without data); reusable market
benchmark is the preferred Phase 7 direction but DEFERRED until the first real outreach email is prepared.
Priority milestone: REAL LEAD -> TRUSTWORTHY AUDIT -> REAL EMAIL -> HUMAN APPROVAL.**
**Phase 17A — outreach tracking & follow-up operations — is implemented (tracking/synchronization
infrastructure only; it sends nothing and modifies no Gmail draft). Phase 17A2 — guarded live read-only
Gmail reply sync — is implemented (a real, doubly-gated, strictly read-only reply reader that modifies
nothing). Phase 17A3 — live Google Sheets operator dashboard — is implemented (a guarded, one-way, idempotent
real Sheets writer plus a fail-closed Gmail reader-selection correction). Phase 17B — Controlled First Send
Smoke Test — is IMPLEMENTED (a dedicated, heavily-gated single-send path plus its tracking; no real send
occurred during implementation and every sending flag remains disabled by default). Phase 17C — Delivery
Failure Reconciliation — is IMPLEMENTED (a guarded, strictly read-only Gmail DSN/bounce reconciliation that
transitions confirmed permanent bounces to BOUNCED and cancels pending follow-ups without sending, modifying
Gmail, or auto-retrying; migration 0027 adds one additive delivery-events table; no Gmail read, email, Sheet
write, or follow-up occurred during implementation). Phase 17C1 — Harden DSN Correlation — is IMPLEMENTED
(eligibility excludes already-resolved records including `--record`; correlation is time-bounded and
priority-ranked, fail-closed on ambiguity; DSN parsing handles multipart/report + nested message/rfc822 +
text/plain; a narrowly-scoped correction command invalidates — never deletes — mis-correlated delivery events;
migration 0028 adds additive supersede columns; no Gmail read, email, Sheet write, or follow-up occurred).**
**Last updated:** 2026-07-31

One phase at a time. Each phase ends with tests, a commit, an annotated tag, and an explicit approval gate.
No phase begins before the previous one is approved with `APPROVE PHASE X`.

| Phase | Name | Tag | Approved? |
|---|---|---|---|
| 0 | Discovery & system specification | `phase-0-specification` | ✅ approved |
| 1 | Local foundation & deterministic core | `phase-1-foundation` | ✅ approved |
| 2 | Lead collection & deduplication | `phase-2-lead-collection` | ✅ approved |
| 3 | Deterministic qualification (PRE_AUDIT) | `phase-3-qualification` | ✅ approved |
| 4 | Independent enrichment & website discovery | `phase-4-enrichment` | ✅ approved |
| 5 | Website capture & evidence extraction | `phase-5-website-capture` | ✅ approved |
| 6 | AI website audit & opportunity analysis | `phase-6-ai-audit` | approved; Gate B deferred |
| 7 | Competitor research (optional module) | `phase-7-competitor-research` | 7A1 DONE (`phase-7a1-competitor-candidates`); 7A2 DONE (`phase-7a2-competitor-evidence`); 7A3A DONE (`phase-7a3a-competitor-patterns`); 7A3B DONE (`phase-7a3b-competitor-email-enrichment`); 7A4A DONE (offline synthetic harness); 7A4B DONE (`phase-7a4b-live-model-validation`, guarded live-model validation; mock default, no live run); 7A4C (operator go/no-go) pending |
| 8 | Demo template & demo decision engine | `phase-8-demo-generation` | approved |
| 9 | Email writer & reviewer | `phase-9-email-generation` | approved |
| 10 | Review dashboard | `phase-10-review-dashboard` | approved |
| 11 | Netlify preview deployment | `phase-11-netlify-previews` | approved |
| 12 | Gmail draft creation (no send) | `phase-12-gmail-drafts` | approved + committed + live-verified |
| 13 | Scheduling & daily operations | `phase-13-daily-operations` | complete; committed + tagged |
| 14 | Controlled sending (only on explicit request) | `phase-14-sending` | complete; committed + tagged |
| 15 | Production sending readiness and live Gmail provider integration | `phase-15-production-sending-readiness` | complete; committed + tagged |
| 16 | Production safety hardening | `phase-16-production-safety-hardening` | complete; committed + tagged; no live send |

## Demo Engine V2 roadmap

| Milestone | Scope | Status |
|---|---|---|
| 1 | Additive schemas, immutable contracts, manifests, validators, repositories, fixtures, and safety tests | complete; locally verified |
| 2 | Clinic Intelligence, structured multilingual content, review-gated English translation, first-party asset discovery, Creative Brief, and no-code ExperiencePlan orchestration | complete; mock/local only |
| 3B2A | Mobile CTA hierarchy fix, CLI render/screenshot persistence + inspection behind a dedicated guarded database, FR/HE/AR screenshot generation, review-package completeness | complete; mock/local only |
| 3B1 | Typography upgrade, editorial composition, imagery, condensed FAQ, FR/HE/AR fixtures, immutable render/screenshot/review persistence (migration 0024) | complete; mock/local only |
| 3A | Code-native component registry + design system, deterministic premium renderer, bilingual bundle, quality checks, mock visual-review + revision contracts, local preview/screenshot/review-package tooling | complete; mock/local only |
| 3+ | Rendering, screenshot generation, visual review, revisions, human approval workflow, and deployment integration | not approved; not implemented |

Milestone 1 leaves V1 untouched and selected by default. Migration `0023` creates 21 isolated V2 tables with
no FK to `demos`. Human translation/reuse/final approvals are actor-bound; approval packages bind the complete
content/translation/asset/brief/plan/registry/render/screenshot/rubric/visual-review fingerprint. Automatic
review is advisory only and cannot authorize deployment. See D-0037.

Milestone 2 writes versioned Milestone 1 packages from accepted source records and exact fingerprints. Its
bounded mock providers make zero paid calls; translation and asset reuse remain human-review gated; lifecycle
advancement stops at `HUMAN_REVIEW_REQUIRED`. V1 remains selected and unchanged. See D-0039.

> **Phase 3C-A — guarded read-only KU64 evidence export:** a single `ku64-v2-export-evidence` CLI reads the
> operational database SELECT-only (session `default_transaction_read_only=on`, plus a write-method Proxy
> guard) to export ONE lead's already-stored, redacted evidence into `.local-data/ku64-v2/evidence.json`
> (git-ignored). It requires `--confirm-production-read` and `ALLOW_PRODUCTION_READ_EXPORT=true`, binds only to
> a lead whose normalized domain is exactly `ku64.de` (www accepted), and fails closed on a missing gate,
> missing/duplicate lead, domain mismatch, unrelated/dangling record, reachable write method, or an output
> path outside `.local-data/ku64-v2/`. The deterministic export excludes raw HTML, page bodies, verbatim
> website text, screenshot binaries, media URLs, secrets, and all email/Gmail/scheduling/outreach records.
> It does NOT authorize rendering, deployment, email, scheduling, live-site crawling, asset reuse, Sol calls,
> or database writes. **Phase 3C-B remains blocked** until the exported local evidence is reviewed and approved.

> **Phase 3C-B — private, local-only review package from exported evidence (approved and implemented):** a
> business-agnostic adapter (`evidence-render-input.ts`) maps the immutable export envelope onto the existing
> Milestone 2 mock orchestration, so every rendered factual claim stays bound to the exact exported record that
> authorized it; sparse evidence yields a shorter, honest page rather than fabricated content. A general,
> additive `assetDisclosure` render field carries a per-language illustrative-imagery notice (absent by default,
> so existing render hashes are unchanged), and a general `demo-v2-render-evidence` CLI renders any exported
> bundle using a caller-supplied illustrative image pool. The general renderer gained no business-specific
> conditional. The KU64 review package (`demos/ku64-v2/`, git-ignored, never committed) was generated locally
> from the exported evidence: verified identity, the six verified services with clean spacing (F1 de-glue fix),
> verified address, verified phone as the appointment channel, and an evidence-gated FAQ. Findings F1/F2 inform
> the build but are never rendered as visitor text; F3 was not restored. The five synthetic clinic assets are
> the illustrative pool, disclosed on-page as illustrative and not depicting KU64. The render is German-only
> (English mock-prepared but withheld as un-reviewed), deterministic, zero quality blockers,
> `deploymentEligible: false`. No Sol, deployment, Gmail, email, scheduling, outbound, database, or live-site
> action occurred. Sol scoring, visual review, human approval, deployment, and outreach remain blocked pending
> separate explicit approval.

> **Controlled prospect validation extension:** the normal prospect continuation remains conservative.
> An explicit `--controlled-test` mode may process exactly one qualified lead through the existing capture,
> audit, composition, preview-deploy, draft, read-only preflight, schedule, and local-readiness stages. It
> requires the configured test-recipient environment variable, safe sending kill switches, and short-lived
> run/hash-bound controlled approvals. These approvals are not human or sending approvals. The resulting
> readiness/dry-run records are database-constrained to `CONTROLLED_TEST_NOT_SENDABLE`; no send method is
> reachable from the coordinator. See D-0036.

> **Phase 16 objective:** close the production-readiness blockers found after Phase 15 without any
> live Gmail operation or send. Reconcile operations documentation; bind and verify Reply-To; make
> provider preflight read-only; add a complete local dry-run report, a structurally read-only Gmail
> verification command, audited multi-scope suppression intake, credential ACL tooling, and explicit
> retention/objection/recovery procedures. Mock remains the default and every sending flag stays disabled.
> Operational execution is defined in `docs/PRODUCTION_OPERATIONS.md`; each live or state-changing step retains
> its own approval gate.

> **Phase 14 implementation:** the committed mock-first safety controller evaluates exactly one known
> scheduled draft, verifies its immutable bindings twice, requires an expiring readiness approval and
> exact interactive confirmation, durably reserves the attempt, and permanently blocks automatic retry
> after an uncertain provider outcome. It does not claim provider-level exactly-once delivery; see D-0031.

> **Phase 15 objective:** production sending readiness and live Gmail provider integration, with no live
> Gmail calls or sends during implementation. Add a separately selectable HTTP provider behind the Phase 14
> controller, strict known-draft parsing, readiness/revocation/status/reconciliation operator commands,
> account daily-cap enforcement, and zero-network tests. Mock remains the default and every sending flag
> remains disabled. No follow-up automation, reply detection, inbox access, bulk sending, or automatic retry.
> Manual uncertainty reconciliation is a dedicated TTY-confirmed path, not a general state-machine edge.
> It preserves the original `OUTCOME_UNKNOWN` attempt and records a separate confirmed-sent,
> confirmed-not-sent, or unresolved audit decision; see D-0032.

> **Phase 13 implementation:** deterministic, timezone-aware scheduling records intended send times in
> PostgreSQL only. It requires a verified recipient IANA timezone, enforces configurable local windows,
> weekdays, spacing and daily caps, preserves cancel/reschedule history, and binds each schedule to the
> exact Gmail draft, finalized content and recipient. `--dry-run` is write-free. Phase 13 has no Gmail
> call or sending implementation; see D-0030.

> **Phase renumbering (Phase 3):** an *Independent enrichment & website discovery* phase was inserted at
> position 4; former phases 4–13 shifted to 5–14. Enrichment discovers/verifies official websites for
> phone-only leads and writes durable facts (`source_type='website'`) with source URL + capture time, then
> re-qualifies. See DECISIONS D-0011.

> **Deferred tasks — Gate B model eval (from Phase 6):** the first Gate B run (2026-07-16) is marked
> **INVALID_FOR_MODEL_SELECTION** — it was degraded by transient network errors (only Sol/Sol partially
> completed; $0.1545 spent). Its cost + diagnostic records are preserved (`eval-reports/`), but its quality
> metrics MUST NOT be used to choose a production model. Production stays on the PROVISIONAL gpt-5.6-sol/medium
> baseline (D-0024). Deferred until the pipeline is end-to-end functional and there is real audit volume:
> 1. **Rerun Gate B under stable network conditions** — `pnpm cli eval-audit --cases "missing-cta,good-site,mobile-overflow,desktop-mobile-mismatch,injection-heading,minimal-evidence" --models "gpt-5.6-sol,gpt-5.6-terra" --reviewers "gpt-5.6-sol,gpt-5.6-terra"`.
> 2. **Monitor fabricated evidence-reference rates** on real audits (the Gate A repair + the degraded run both showed the generator can cite out-of-package evidence IDs).
> 3. **Improve evidence-citation prompting** if the fabricated-reference rate is material.
> 4. **Run future paid evaluations in small foreground batches with explicit stop points** (not a single 48-call background run).

> **Phase 17A — outreach tracking & follow-up operations (IMPLEMENTED; tracking only, NEVER sends).**
> Adds Postgres as the source of truth for outreach (migration `0026`, six additive `outreach_*` tables:
> campaigns, per-(lead×campaign×contact) records with a 17-state machine, immutable message snapshots,
> a follow-up queue, replies, and an immutable per-record event timeline). A Google Sheet is a read-only,
> idempotent operator projection (four tabs; mock provider default; real writes gated behind
> `GOOGLE_SHEETS_SYNC_ENABLED` + `--confirm`). Gmail reply-sync is strictly read-only over tracked threads
> (deterministic classification; excludes self-messages; a genuine reply/bounce/unsubscribe cancels pending
> follow-ups; unsubscribe → do-not-contact). Follow-ups are calculated and stored but **never sent**. New
> flags default safe: `OUTREACH_TRACKING_ENABLED=false`, `GMAIL_REPLY_SYNC_ENABLED=false`,
> `GOOGLE_SHEETS_SYNC_ENABLED=false`; all existing sending guards unchanged. See `docs/OPERATIONS.md`.
>
> **Phase 17A2 — guarded live read-only Gmail reply sync (IMPLEMENTED; reads only, NEVER sends/modifies).**
> Replaces only the mock reply reader with `HttpGmailThreadReader`, a real reader for the existing read-only
> `GmailThreadReader` boundary. It reads exactly `GET /gmail/v1/users/me/threads/{trackedThreadId}?format=metadata`
> for tracked thread ids only — no message bodies, no `messages.list`/`threads.list`/`q=` search, and no
> send/draft/label/archive/trash/modify method exists on the class. Reading uses a NEW `gmail.readonly` grant
> stored in a SEPARATE 0600 credential file via a dedicated `gmail-read-auth` command; the sending
> `gmail.compose` credential is never touched. Any live read is doubly gated by `GMAIL_REPLY_SYNC_ENABLED=true`
> AND `--confirm-gmail-read`, plus an exact-scope check. (Phase 17A3 hardens the fallback: a REQUESTED live
> read that fails any guard now exits nonzero instead of silently using the mock reader; the mock reader runs
> only when explicitly selected with `--mock`.) Detection, classification, follow-up cancellation,
> unsubscribe→DNC, and bounce handling are unchanged. See `docs/OPERATIONS.md`.
>
> **Phase 17A3 — live Google Sheets operator dashboard (IMPLEMENTED; one-way projection, NEVER sends/imports).**
> Corrects the Gmail reader selection so a REQUESTED live read that fails any guard exits nonzero instead of
> silently using the mock reader (pure `selectReplyReader`; mock runs only when explicitly selected with
> `--mock`). Replaces the fail-closed Sheets placeholder with a real `HttpSheetsProvider`: a ONE-WAY,
> idempotent projection over the existing Phase 17A projection and `SheetsProvider` interface that GETs
> metadata/values and writes each tab in a SINGLE atomic `:batchUpdate`. Column A holds the stable row id;
> counts are inserted/updated/unchanged/removed-stale; a full sync mirrors Postgres exactly while a scoped
> per-campaign sync is upsert-only. Live writes require ALL of `GOOGLE_SHEETS_PROVIDER=http`,
> `GOOGLE_SHEETS_SYNC_ENABLED=true`, `--confirm-sheet-write`, a spreadsheet id, and valid credentials with
> exactly the `spreadsheets` scope — otherwise nonzero exit, no mock fallback, no partial write. A new
> `sheets-auth` grants the minimum scope into a SEPARATE 0600 file (no Gmail credential touched); CLI adds
> `--preview`, `--campaign`, `--confirm-sheet-write`, and an `outreach-sheet-verify` readiness command. Manual
> Sheet edits are never imported into Postgres. Mock/off remains the default. See `docs/OPERATIONS.md`.
>
> **Phase 17B — Controlled First Send Smoke Test (IMPLEMENTED; exactly ONE tracked send, heavily gated).**
> A NEW dedicated outreach-native path (`OutreachSmokeSendService`) performs EXACTLY ONE fully-tracked,
> allowlisted send. It does not use the Phase 14/15 schedule/readiness `SendService`; it reuses the existing
> safeguarded primitives (create a Gmail DRAFT → verify that exact known draft → `sendExistingDraft`), adding
> no raw `messages.send`. A pure, unit-tested guard function requires ALL of: `OUTREACH_SMOKE_TEST_ENABLED=true`,
> `SENDING_ENABLED=true`, `OUTBOUND_ACTIONS_ENABLED=true`, `DRY_RUN=false`, `SENDING_PROVIDER=http`,
> `--provider http`, `--confirm-phase-17b`, an exact `--sender` = `GMAIL_ACCOUNT_EMAIL` (provider-verified),
> an allowlisted `--recipient` = `OUTREACH_SMOKE_TEST_RECIPIENT` (and the record's contact), exactly one
> recipient, no Cc/Bcc, the record `APPROVED_TO_SEND`, a stored INITIAL step-0 message whose content hash
> matches, a valid unexpired human approval, no do-not-contact, and no prior successful send. Uses migration
> 0026 only (no new migration): campaign `Phase 17B Smoke Test`, ONE synthetic internal lead, the immutable
> INITIAL message, and — on a confirmed send — an atomic advance to `INITIAL_SENT` with Gmail ids attached, an
> immutable event trail, and a tracking-only follow-up that is NEVER auto-sent. An `unknown` outcome or a
> post-send persistence failure is never auto-retried; the exact idempotent `outreach-smoke-reconcile` recovery
> command is printed. New flags default safe (`OUTREACH_SMOKE_TEST_ENABLED=false`). No real send, Gmail draft,
> external Sheet write, or follow-up send occurred during implementation or tests. The single authorized real
> send is an operator step — see `docs/OPERATIONS.md`.
>
> **Phase 17C — Delivery Failure Reconciliation (IMPLEMENTED; read-only DSN detection, NEVER sends).**
> Closes the gap the Phase 17B smoke test exposed: an outbound recorded `INITIAL_SENT` on a confirmed
> `drafts.send` can still bounce asynchronously (Gmail `550 5.7.1` — likely unsolicited mail) via a SEPARATE
> Delivery Status Notification, so the recipient never received it. A new `outreach-reconcile-delivery`
> command reads Gmail **strictly read-only**, finds DSNs connected to tracked outbounds, correlates each to
> EXACTLY ONE outbound (RFC Message-ID reference → shared Gmail thread → failed-recipient address; **fail-closed
> on ambiguity**; unrelated/non-DSN messages are never classified), and transitions confirmed permanent
> (5.x.x) bounces to `BOUNCED`, cancelling every pending follow-up and appending immutable `BOUNCE_DETECTED` +
> `FOLLOWUPS_CANCELLED` events while preserving the original `INITIAL_SENT` event and sent timestamp. Temporary
> (4.x.x) failures become `DELIVERY_UNKNOWN` for operator review — no state change, **no auto-retry**. It does
> NOT set do-not-contact and is idempotent per DSN. Migration `0027` adds one additive
> `outreach_delivery_events` table (idempotency key: the DSN's own Gmail message id). The read-only bounce
> reader has, by construction, no send/draft/label/archive/trash/modify method (GET-only), refuses unless the
> stored scope is exactly `gmail.readonly`, and a requested live read that fails any guard exits nonzero and
> NEVER falls back to mock. Supports `--record`/`--campaign`/all, plus `--dry-report` and `--mock`. No Gmail
> read, email, Gmail modification, Sheet write, or follow-up occurred during implementation or tests. The
> incident record reconciliation is an operator step — see `docs/OPERATIONS.md`. **Phase 7 competitor research
> remains DEFERRED and unapproved.**
>
> **Phase 17C1 — Harden DSN Correlation (IMPLEMENTED; read-only, NEVER sends).** Fixes a correlation defect the
> first live run exposed: reconciling record `acded064-…` attached five false `DELIVERY_UNKNOWN` events (three
> from May 2026, before the tracked email existed) to a record already correctly `BOUNCED` by reply-sync.
> Eligibility now excludes already-resolved records for EVERY form (including `--record`), and
> `applyDeliveryFailure` fails closed on a terminal record (`SKIPPED_TERMINAL`, no delivery event written). A DSN
> must be received AFTER the outbound (± 5-minute clock skew), so a DSN predating the send can never correlate.
> Correlation priority is (1) exact RFC Message-ID, (2) exact original Gmail message id, (3) exact outbound
> thread id, then (4) recipient-only — used ONLY for a single unresolved outbound within a narrow 14-day window,
> fail-closed on ambiguity; the dry report shows correlation strength. Parsing handles multipart/report,
> message/delivery-status, nested message/rfc822, and a text/plain fallback (`550 5.7.1`/`5.x.x` → PERMANENT,
> `4.x.x` → TEMPORARY). Migration `0028` adds additive supersede columns; a new `outreach-correct-delivery-events`
> command (dry-run by default; `--apply` needs `--by`+`--reason`) INVALIDATES — never deletes — mis-correlated
> delivery events and appends an immutable `DELIVERY_RECONCILIATION_CORRECTED` event, changing no outreach state
> or follow-up and touching no Gmail. The five-id incident correction is an operator step — see
> `docs/OPERATIONS.md`. No Gmail read, email, Gmail modification, Sheet write, or follow-up occurred during
> implementation or tests.

## Phase 0 — Discovery & system specification

Docs-only, no production code. Deliverables: all `docs/*` files, `CLAUDE.md`, `README.md`, `.gitignore`,
`.env.example`, domain model, state machine, provider boundary, roadmap, risk register, Phase 1 acceptance
criteria. No dependency install, no external accounts, no paid APIs. → commit + tag `phase-0-specification` → stop.

## Phase 1 — Local foundation & deterministic core

TypeScript strict project, lint/format, Vitest, env validation, Pino logging, local Postgres via Docker
Compose, initial migrations, core `leads` + `evidence` + `pipeline_runs` + `pipeline_events` entities, state
machine, `model_calls` record type, CLI shell, mock fixtures, dry-run mode, global outbound kill switch.
Commands to start DB, run migrations, create/list/inspect sample leads, reset test data. No external APIs, AI,
demos, or emails.

**Acceptance criteria (exact):**

1. `pnpm install` completes clean on a fresh checkout.
2. `docker compose up` starts local Postgres; `pnpm db:migrate` applies migrations with no error.
3. `pnpm cli create-sample-leads` inserts sample leads; `pnpm cli list-leads` shows them.
4. `pnpm cli lead-state <id>` prints current state + event history.
5. Valid state transitions succeed; invalid transitions throw `InvalidStateTransitionError` and write a
   `pipeline_events` row (covered by unit tests).
6. `pnpm cli reset-test-data` safely clears local test data only.
7. Dry-run mode and `OUTBOUND_ACTIONS_ENABLED=false` are wired and default-safe.
8. `pnpm check` (lint + typecheck + unit tests) passes.
9. No secrets in the repo; `.env` is git-ignored; `.env.example` documents every variable.

## Phases 2–13

Goals, build lists, and acceptance criteria are specified in the mission prompt and will be restated in each
phase's start-of-phase report. Highlights of the hard gates:

- **P2** default mock mode; real Google Places behind a feature flag; reruns never duplicate.
- **P3** identical input → identical score; rules versioned; AI cannot control the number.
- **P4** captures fixtures; records redirects/failures; never labels capture failure as a website defect; no form submits.
- **P5** every finding links evidence IDs; no prose parsing; mock tests make no paid calls; meets eval threshold.
- **P6** disableable; low-value leads skip it; no invented competitor-performance claims; cost-capped.
- **P7** one deployment serves many lead routes; noindex; no fabricated content; local previews only.
- **P8** every factual point maps to evidence; placeholders/wrong names/unsupported claims → failure; one rewrite cycle.
- **P9** inspect-why for every statement; edit/approve/reject; every action logged; auth before remote deploy.
- **P10** deploy only approved demos; globally disableable; URLs recorded; noindex verified.
- **P12** Gmail drafts only, never send; requires `HUMAN_APPROVED` + passed review + verified recipient + not
  suppressed + `OUTBOUND_ACTIONS_ENABLED=true`; reruns never duplicate drafts; suppression overrides approval.
- **P13** end-to-end dry run; resumable runs; enforced daily caps; visible failures; no external write when disabled.
- **P14** only on explicit request; separate sending plan (jurisdiction, SPF/DKIM/DMARC, unsubscribe,
  suppression, bounce handling, volume ramp, caps, provider, reply detection, follow-ups); removable module.

## Phase 7 — Competitor research (optional module)

**Milestone 7A1 (deterministic candidate foundation) is IMPLEMENTED** (tag `phase-7a1-competitor-candidates`,
migration `0029_competitor_research.sql`): fixtures/operator-CSV providers, exact approved 100-point
comparability model, immutable/versioned DRAFT runs, fail-closed live-provider guard, CLI
`competitor-research-plan|run|review`, default-off `COMPETITOR_RESEARCH_ENABLED`. No website capture, email
change, AI, live provider, Gmail/Sheets, or sending. See `docs/phase-7a-competitor-research.md` for the full
plan and the 7A3–7A4 milestones.

**Milestone 7A2 (competitor website evidence capture) is IMPLEMENTED** (tag `phase-7a2-competitor-evidence`,
migration `0030_competitor_evidence_capture.sql`): dedicated non-lead-bound capture service; 15 deterministic
evidence categories; HIGH/MEDIUM/LOW confidence + `safeForOutreach`; 30-day freshness; ≤2 pages/competitor,
depth 1, same-origin, desktop+mobile; no raw HTML retained; immutable/versioned + idempotent; fixture-default
with a fail-closed (no-fallback) guarded live path; CLI `competitor-capture-plan|run|review|invalidate`;
default-off `COMPETITOR_CAPTURE_ENABLED`. **No** comparative pattern, `competitor_evidence_used` change (stays
`NONE`), AI, Gmail/Sheets, or sending. The 7A3 (pattern generation + email enrichment) and 7A4 (controlled
live validation) milestones remain unapproved.

**Milestone 7A3A (deterministic competitor pattern packages) is IMPLEMENTED** (tag
`phase-7a3a-competitor-patterns`, migration `0031_competitor_pattern_packages.sql`): pure deterministic
pattern layer that turns SELECTED-competitor 7A2 evidence into immutable, versioned, source-traceable
pattern packages — per-distinct-brand PRESENT/ABSENT/UNKNOWN classification, PRESENT+ABSENT denominator
(missing data never negative), 2-of-N presence threshold, numeric depth medians (never contrasted),
boolean prospect contrasts only for the operator-approved unambiguous mapping (`PHONE_VISIBLE↔tel`,
`WHATSAPP↔messaging-host link/mailto`, `BOOKING_CTA↔cta/form`) with verified prospect ABSENT, HIGH/MEDIUM/
LOW confidence, anonymized count-bound wording, and a hard validator that FAILS on performance/revenue/
ranking/volume claims, sample-of-one, missing sources, count/wording mismatch, or competitor-name leakage.
CLI `competitor-pattern-plan|run|review|approve|reject|invalidate`; default-off `COMPETITOR_PATTERN_ENABLED`;
human approval requires explicit operator identity and never auto-approves. **No** AI, network, email
composition/schema/prompt change (`competitor_evidence_used` stays `NONE`), Gmail, Sheets, or sending.

**Milestone 7A3B (competitor email enrichment) is IMPLEMENTED** (tag
`phase-7a3b-competitor-email-enrichment`, migration `0032_email_competitor_enrichment.sql`): optional,
default-off (`COMPETITOR_EMAIL_ENRICHMENT_ENABLED`), fully **deterministic** insertion of ONE explicitly
selected APPROVED package into the email pipeline. The model never authors competitor text; the composer
inserts the package's approved anonymized wording + a fixed cautious-consequence template verbatim.
`EMAIL_SCHEMA_VERSION` `email-copy-schema-2` → `email-copy-schema-3`; `competitor_evidence_used` widened to
`NONE | APPROVED_COMPETITOR_PATTERN_PACKAGE` (the FINAL artifact — not the raw model output — carries the
enriched value + provenance + claim ledger). Material alignment to the prospect's primary verified issue is
required (else fail closed); a fixed deterministic pattern-selection order; an explicit `CompositionPlan`
renders the body (prospect observation first, one competitor section, no competitor language in the
subject); full recompute-and-hash-compare revalidation at compose/review/approve; companion tables persist
provenance + a per-claim ledger + the composed-message hash (immutable; a changed package/body is a new
message version). CLI `outreach-compose-preview` (read-only; `--apply` persists). English-only in 7A3B.
**No** Gmail draft, send, sending-flag change, Gmail/Sheets access, live model call, website access, or
network request. **7A4 (controlled live validation) remains unapproved.**

The full plan below was deferred by operator on 2026-07-16 and then resumed for 7A1.

- **Purpose:** for a *selected* lead (deterministic gate on Phase 6 opportunity score + comparison-relevant
  finding categories), gather **bounded, evidence-backed** context on how a few verified local competitors
  handle the *same* weaknesses found on the lead's site. Optional, default-off (`COMPETITOR_RESEARCH_ENABLED`).
- **Hard exclusions:** no competitor traffic/revenue/ranking/performance claims; no copying competitor
  content/designs; no SEO/analytics; not every lead; presence/absence facts only.
- **Discovery:** Google Places ID-only (no content persisted, `ALLOW_PAID_READS`-gated) or operator CSV or mock.
- **Verification:** reuse Phase 4 deterministic `WebsiteVerifier`; only VERIFIED competitor official sites proceed.
- **Capture:** reuse Phase 5 hardened container, purpose `COMPETITOR_CAPTURE`, ≤2 pages/competitor, screenshots
  are internal evidence only (never republished).
- **Deterministic core:** feature extraction (has-online-booking, contact-in-header, etc.) + a versioned,
  reproducible comparison matrix with gap flags + evidence citations. **Optional** bounded AI summary reuses
  Phase 6 validation/injection/cost guards (default off).
- **Schema:** `CompetitorComparison` (dimension, leadState+evidence, competitors[present|null + evidence], gap,
  rulesVersion/hash) — no numeric performance fields.
- **DB (next free migration):** competitor_research_runs, competitors (Place-ID-only, no Google content),
  competitor_comparisons + evidence links; capture reuses website_capture_runs.
- **States:** OPPORTUNITY_READY → COMPETITOR_RESEARCH_READY → COMPETITOR_RESEARCHED; not-justified/disabled skip
  unchanged. Outcome taxonomy incl. NOT_JUSTIFIED, ALL_UNVERIFIED, NO_COMPETITORS_FOUND, BUDGET_BLOCKED.
- **Limits:** module kill switch, MAX_COMPETITORS_PER_LEAD (~3), MAX_COMPETITOR_RESEARCH_PER_RUN (~5), paid-read
  + LLM cost caps.
- **Privacy/legal:** public business info only; no Google content persisted; no copied designs; neutral,
  evidence-bound observations; noindex on any artifacts; competitor screenshots internal-only.
- **Rollback:** module flag + migration reverse script + `git reset --hard phase-6-ai-audit`.
