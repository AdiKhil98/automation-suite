# Operations

**Status:** Phase 0 (forward-looking; commands land in Phase 1). No code exists yet.
**Last updated:** 2026-07-11

## Prerequisites

- Node.js 22 LTS (installed: v22.18.0).
- pnpm via Corepack — `corepack enable pnpm` (may need an elevated shell on Windows; see D-0004).
- Git (installed: 2.50.1).
- **Docker Desktop with WSL 2 backend** — to be installed by the operator before Phase 1 (see D-0002).
- A GitHub remote (source of truth) — to be added; Phase 0 commits locally.

## Planned local-dev setup (Phase 1)

```text
cp .env.example .env         # fill in local values; .env is git-ignored
pnpm install
docker compose up -d         # local Postgres
pnpm db:migrate              # apply migrations
pnpm cli create-sample-leads # seed sample data
pnpm cli list-leads
pnpm cli lead-state <id>
pnpm cli reset-test-data     # clears local test data only
```

## Phase 3C-A — guarded read-only KU64 evidence export

`ku64-v2-export-evidence` exports exactly ONE lead's already-stored, redacted pipeline evidence into
`.local-data/ku64-v2/evidence.json` (git-ignored; never staged or committed) for private Demo Engine V2
preparation. It reads the operational `DATABASE_URL` **SELECT-only** — the pool opens every session
`default_transaction_read_only=on`, and a Proxy guard rejects any write-capable executor method — so no
INSERT/UPDATE/DELETE/DDL/migration/lock/export-timestamp write can occur. It never renders, crawls the live
site, downloads KU64 media, calls Sol, deploys, drafts, schedules, or sends, and it exports no raw HTML, page
bodies, verbatim website text, screenshot binaries, media URLs, secrets, or any email/Gmail/scheduling record.

It refuses to run unless ALL hold: `--confirm-production-read`, `ALLOW_PRODUCTION_READ_EXPORT=true`, an
existing `--lead-id`, and an `--expected-domain` that normalizes to exactly `ku64.de` (www accepted) and
matches the lead's own normalized domain. A missing/duplicate lead, domain mismatch, unrelated record, or
out-of-tree output path fails the export closed.

Because this is a production-database read against the remote Supabase target, it is an explicit
operator-run step (it is not run from CI, tests, or an automated agent). Run it manually:

```bash
$env:ALLOW_PRODUCTION_READ_EXPORT="true"; pnpm cli ku64-v2-export-evidence --lead-id 287a6614-e2d7-44f6-8c7d-9adb0924b963 --expected-domain ku64.de --confirm-production-read
```

After it succeeds, validate the printed lead id / normalized domain binding, confirm zero writes (the command
opens a read-only session and reports the record counts by source type and the deterministic `recordsSha256`),
and review `.local-data/ku64-v2/evidence.json` before considering Phase 3C-B. The file is deliberately outside
version control; do not stage or commit it.

## Operational vs. integration-test databases

`DATABASE_URL` is the Supabase production database connection. It must never be used by integration tests or
destructive reset tooling. Production migrations use only the explicit `pnpm db:migrate` command against
`DATABASE_URL` after separate operator approval.

`TEST_DATABASE_URL` is a separate local PostgreSQL connection for integration tests and `reset-test-data` only.
Destructive test actions require all of: `NODE_ENV=test`,
`ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS=true`, a loopback host (`localhost`, `127.0.0.1`, or `::1`), and a
clearly test-only database name such as `outreach_test`. There is no fallback to `DATABASE_URL`; Supabase,
session poolers, and remote hosts are rejected before a connection opens.

Never run `pnpm test:integration` or `pnpm cli reset-test-data` against Supabase. Keep the operational and local
test connections separate.

## Collection & qualification commands (Phase 2 / Phase 3)

```text
# Phase 2 — collect + deduplicate (mock by default; Google Places behind a flag)
pnpm cli collect-leads --campaign dental-manchester-test
pnpm cli collect-leads --campaign dental-manchester-test --dry-run --limit 25

# Bounded production prospecting (disabled unless PROSPECT_DISCOVERY_ENABLED=true and ALLOW_PAID_READS=true)
pnpm cli prospect-run --niche dentists --location "Berlin, Germany" --radius-km 10 --target-qualified 1 --max-candidates 5 --rank POPULARITY
# Explicit coordinates bypass the one-request location resolver
pnpm cli prospect-run --niche dentists --location "Berlin, Germany" --latitude 52.52 --longitude 13.405 --radius-km 10

# Phase 3 — deterministic PRE_AUDIT qualification of collected leads
pnpm cli qualify-leads --campaign dental-manchester-test

# Phase 4 — enrich READY_FOR_ENRICHMENT leads (verify official website), then re-qualify
pnpm cli enrich-leads --campaign dental-manchester-test
pnpm cli qualify-leads --campaign dental-manchester-test   # re-qualify enriched leads

# Manual enrichment (no Google/paid API): supply a candidate URL directly or via CSV
pnpm cli enrich-lead --lead <lead-id> --candidate https://example.com
pnpm cli enrich-lead --csv leads.csv                       # rows: leadId,candidateUrl

# Phase 5 — Playwright capture of verified official websites (mock by default)
pnpm cli capture-websites --campaign dental-manchester-test               # AUDIT_CAPTURE
pnpm cli capture-websites --campaign dental-manchester-test --purpose verification  # BROWSER_REQUIRED leads

# Phase 6 — AI website audit of READY_FOR_AUDIT leads (mock by default; paid hard-gated)
pnpm cli audit-websites --campaign dental-manchester-test [--limit N]
pnpm cli resume-audit                                     # replay recovery envelopes (never calls the model)
pnpm cli eval-audit [--models a,b] [--reviewers c] [--max-calls N] [--out dir]

# Phase 8 — local concept-demo generation for OPPORTUNITY_READY leads (deterministic, no deploy)
pnpm cli generate-demos --campaign dental-manchester-test [--limit N]
pnpm cli preview-demo --lead <lead-id>   # serves the demo on http://127.0.0.1:<port>/ (loopback only)
```

`prospect-run` never accepts arbitrary Google types, never requests more than one Nearby page, and uses an
ID-only discovery field mask. `--continue-pipeline` additionally requires `PROSPECT_CONTINUE_PIPELINE=true`,
passes only the first qualified lead into exact-lead existing stages, and stops before deployment, Gmail,
scheduling, or sending. It does not change flags itself.

Demos are written to `./demos/<leadId>/` (git-ignored), marked `GENERATED_PENDING_REVIEW`, and are
never published in Phase 8 — a later phase handles human approval + Netlify deployment.

Standard tests use the mock capture provider (no browser). The **real** browser suite runs against local
fixtures: install Chromium once (`npx playwright install chromium`), then `pnpm test:browser`. For production
captures of real prospect sites, use the hardened container — see
[deploy/hardened-browser.md](deploy/hardened-browser.md). Screenshots are private artifacts under
`.artifacts/` (git-ignored); a GC removes unreferenced blobs.

Enrichment is mock + deterministic by default (no network in tests). The optional Google context provider is
disabled unless `ENRICHMENT_CONTEXT_PROVIDER=google` and `ALLOW_PAID_READS=true` with a key — see
[integrations/google-places-details.md](integrations/google-places-details.md).

## Phase 6 paid gates (Gate A / Gate B)

Real OpenAI calls are OFF by default and can never happen from tests or CI. Both gates require an explicit
operator approval in chat before running.

**Prerequisites (both gates)** — the CLI refuses (before touching any lead) unless ALL hold:

1. `LLM_PROVIDER=openai`, `OPENAI_API_KEY` set, `ALLOW_PAID_LLM_CALLS=true`.
2. `src/integrations/llm/pricing.ts` reconciled with official OpenAI pricing (`PRICE_VERIFIED_AT` set); every
   requested model must have a verified price row.
3. `LLM_MODEL_AUDIT` set (baseline: `gpt-5.6-sol`).

**Gate A — single-lead smoke test.** One real lead end-to-end with strict budgets
(`MAX_LLM_CALLS_PER_RUN=4`, `MAX_LLM_CALLS_PER_LEAD=4`, `MAX_LLM_COST_USD_PER_LEAD=0.50`):

```text
pnpm cli audit-websites --campaign <campaign> --limit 1
pnpm cli lead-state <lead-id>     # verify outcome, findings, score, model_calls rows
```

Review persisted findings/review/score/costs before approving any batch use. If the DB write failed after paid
calls: `pnpm cli resume-audit` (free, idempotent).

**Gate B — model eval matrix.** Runs the 16-case fixture dataset (incl. prompt-injection attacks) across
generator×reviewer combos with deterministic graders; used to pick the production model pairing:

```text
pnpm cli eval-audit --models gpt-5.6-sol,gpt-5.6-luna --reviewers gpt-5.6-sol --max-calls 96
```

Reports land in `eval-reports/` (git-ignored). Grader failures are per-case and reproducible. The commit + tag
for Phase 6 happen only after these gates are completed and approved.

Recovery envelopes live in `.audit-tmp/` (git-ignored, restrictive perms). `audit-websites` scans and replays
them automatically at startup and stops if any replay fails.

## Reverse migrations

Drizzle migrations are forward-only, so the database is reversed independently of Git. Each destructive schema
step ships a reverse script under `scripts/rollback/`. To roll Phase 4 back:

```text
psql "$DATABASE_URL" -f scripts/rollback/0003_enrichment_down.sql
git reset --hard phase-3-qualification
```

Phase 5:

```text
psql "$DATABASE_URL" -f scripts/rollback/0004_capture_down.sql
git reset --hard phase-4-enrichment
rm -rf .artifacts
```

Phase 6:

```text
psql "$DATABASE_URL" -f scripts/rollback/0005_audit_down.sql
git reset --hard phase-5-website-capture
rm -rf .audit-tmp eval-reports
```

Phase 8:

```text
psql "$DATABASE_URL" -f scripts/rollback/0007_demo_down.sql
git reset --hard phase-6-ai-audit
rm -rf demos
```

Qualification is deterministic and append-only: re-running preserves prior `qualification_results`. Leads
without a verified official website are routed to `READY_FOR_ENRICHMENT` (website discovery in Phase 4).
Integration tests run serially (`pnpm test:integration` uses `--no-file-parallelism`) since they share one DB.

## Planned quality commands

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm check        # all required non-paid validation
```

## Safety defaults

- `OUTBOUND_ACTIONS_ENABLED=false` by default. No sending integration runs otherwise.
- Dry-run mode blocks all external writes.
- Per-run and per-lead cost caps stop the pipeline safely when reached.

## Run model (Phase 1+)

CLI-first. Each pipeline stage is idempotent and resumable; a `pipeline_runs` record tracks a run and
`pipeline_events` records every state transition and notable event for audit.

## Backup & recovery (detailed in Phase 12)

- Migrations are additive and reversible; no destructive migration without a backup path.
- Local DB backup/restore procedure and resumable-run recovery documented at Phase 12.

## Phase 17A — outreach tracking & follow-up operations (tracking only; NEVER sends)

Phase 17A adds the tracking/synchronization layer required before controlled sending. It sends
nothing, creates/modifies no Gmail draft, and runs no automatic follow-up. Postgres is the source of
truth; a Google Sheet is a read-only operator projection. All external reads/writes are flag-gated and
fail closed. The controlled first send is **Phase 17B — not yet approved.**

### Setup

1. Apply the migration (adds the six `outreach_*` tables):

   ```bash
   pnpm db:migrate
   ```

2. Verify and (optionally) create a campaign:

   ```bash
   pnpm cli outreach-init --create-campaign "q3-dental" --timezone "Europe/Berlin"
   ```

3. Enable tracking when ready (still no sending):

   ```text
   OUTREACH_TRACKING_ENABLED=true
   ```

### Google Sheet configuration

- Default is the **mock** provider (`GOOGLE_SHEETS_PROVIDER=mock`): in-memory only, zero network I/O, used
  for tracking and all tests. `outreach-sync-sheet` builds the four tabs and reports
  inserted/updated/unchanged/removed-stale.
- Tabs: **Outreach** (per-lead state), **Messages** (immutable subject + body-version hash + Gmail ids),
  **Follow-ups Due** (with days-overdue), **Replies and Outcomes**.
- Rows carry stable ids (`outreach:<id>`, `message:<id>`, `followup:<id>`, `reply:<id>`) written into column A,
  so sync is idempotent and never duplicates. The Sheet is a ONE-WAY projection: manual Sheet edits are
  **never** read back as database mutations (a re-sync overwrites drift with the Postgres value).
- Phase 17A3 ships the **real** http provider (`HttpSheetsProvider`). See the Phase 17A3 section below for the
  write gates, authentication, and CLI.

### Gmail read-only configuration

- Reply sync is **read-only**: it reads only the threads of tracked outreach records, excludes the
  account's own messages, considers only inbound messages after the last outbound, classifies
  deterministically (positive/neutral/negative/unsubscribe/bounce), records a short safe preview,
  cancels pending follow-ups on any genuine reply, and sets do-not-contact on unsubscribe. It never
  sends, drafts, labels, archives, or modifies Gmail.
- Phase 17A ships the **mock** reader as the default. **Phase 17A2** adds a guarded, real, strictly
  read-only reader (`HttpGmailThreadReader`) for the same boundary.

### Phase 17A2 — live read-only reply sync (reads only; NEVER sends/drafts/modifies)

- The live reader issues exactly one kind of request: `GET /gmail/v1/users/me/threads/{trackedThreadId}?format=metadata`
  for thread ids that already belong to tracked outreach records. It never downloads message bodies (metadata
  format → headers + Gmail `snippet` only), never lists or searches the mailbox (no `messages.list`,
  `threads.list`, or `q=`), and has no send/draft/label/archive/trash/modify method.
- **Read scope is separate from sending.** Reading requires the `gmail.readonly` scope, which the existing
  `gmail.compose` sending grant does not have. Grant it once with `gmail-read-auth`; the refresh token is
  stored in its own git-ignored 0600 file (`GMAIL_READ_CREDENTIALS_FILE`, default `.gmail-read-credentials.json`),
  entirely separate from the sending credential. The reader refuses to run unless the stored scope is EXACTLY
  `gmail.readonly`.
- **Two gates for any live read (fail-closed):** `GMAIL_REPLY_SYNC_ENABLED=true` AND `--confirm-gmail-read`.
  **Phase 17A3 correction:** a REQUESTED live read (either gate present) that fails ANY guard now **exits
  nonzero** with a clear error — it NEVER silently falls back to the mock reader. The mock reader runs ONLY
  when explicitly selected with `--mock`; passing neither a live intent nor `--mock` is refused (nonzero), and
  combining `--mock` with a live intent is refused. All other detection semantics (self-exclusion,
  after-last-outbound, deterministic classification, follow-up cancellation, unsubscribe→DNC, bounce) are
  unchanged.

#### One read-only connection test (manual)

```bash
# 1. One-time consent (opens a loopback OAuth flow; grants gmail.readonly ONLY):
GMAIL_ACCOUNT_EMAIL=you@yourdomain.tld pnpm cli gmail-read-auth
# 2. Live read-only sync of a single tracked record (both gates required):
GMAIL_REPLY_SYNC_ENABLED=true pnpm cli outreach-sync-replies --confirm-gmail-read --record <outreach-record-id>
#    or one campaign:  --campaign "<name>"   |   or all eligible tracked threads: (no --record/--campaign)
```

### Commands

```bash
pnpm cli outreach-init [--create-campaign <name> --timezone <iana>]   # verify tables/flags; create campaign
pnpm cli outreach-track --campaign <name> --lead <id> --contact <email> [--owner <name>]
pnpm cli outreach-record-message --record <id> --type INITIAL|FOLLOW_UP --step <n> --subject <s> --body <b> [--sent --gmail-message-id <id> --gmail-thread-id <id>]
pnpm cli outreach-transition --record <id> --to <status> [--reason <text>]
pnpm cli outreach-schedule-followup --record <id> --step 1|2
pnpm cli outreach-cancel-followup --followup <id> --record <id> [--reason <text>]
pnpm cli outreach-postpone-followup --followup <id> --record <id> --at <iso> [--reason <text>]
pnpm cli outreach-followups-due                 # list due follow-ups (never sends)
pnpm cli gmail-read-auth                         # one-time gmail.readonly consent (separate 0600 file)
pnpm cli outreach-sync-replies (--mock | --confirm-gmail-read) [--record <id>|--campaign <name>]  # read-only reply sync; live needs GMAIL_REPLY_SYNC_ENABLED=true + --confirm-gmail-read; a failed live guard exits nonzero (no mock fallback)
pnpm cli sheets-auth                             # one-time Google Sheets consent (spreadsheets scope; separate 0600 file)
pnpm cli outreach-sync-sheet [--preview] [--campaign <name>] [--confirm-sheet-write]  # project to the Sheet (mock/off by default; http write is fully gated)
pnpm cli outreach-sheet-verify [--campaign <name>]  # verify Sheet config + (http) credentials/spreadsheet access; never writes
pnpm cli outreach-timeline --record <id>        # full event + message timeline
pnpm cli outreach-readiness                     # pre-first-send readiness report (never sends)
```

### Phase 17A3 — live Google Sheets operator dashboard (one-way projection; NEVER sends/imports)

The real Sheets writer (`HttpSheetsProvider`) mirrors Postgres into the four operator tabs. It only GETs
spreadsheet metadata, GETs a tab's values (to diff), and POSTs a SINGLE atomic `:batchUpdate` per tab
(`updateCells`, plus `addSheet` for a missing tab). Column A holds the stable row id; rows are ordered by id
so re-runs never reshuffle. Sync is idempotent and reports inserted/updated/unchanged/removed-stale. A full
sync (all outreach) mirrors Postgres exactly (removes stale rows); a `--campaign` sync is upsert-only and never
touches another campaign's rows. Message bodies are never written (the Messages tab references the version by
content hash). Manual Sheet edits are never imported back into Postgres.

**Fail-closed write gates (ALL required):** `GOOGLE_SHEETS_PROVIDER=http`, `GOOGLE_SHEETS_SYNC_ENABLED=true`,
`--confirm-sheet-write`, a configured `GOOGLE_SHEETS_SPREADSHEET_ID`, and valid credentials whose stored scope
is EXACTLY `https://www.googleapis.com/auth/spreadsheets`. Missing any → nonzero exit, **no mock fallback, no
partial write**. The default remains mock/off.

**Authentication.** Reuse the existing installed-app loopback OAuth pattern (same Google Cloud OAuth client)
via `sheets-auth`. It grants ONLY the `spreadsheets` scope and stores the refresh token in a SEPARATE
git-ignored 0600 file (`GOOGLE_SHEETS_CREDENTIALS_FILE`, default `.google-sheets-credentials.json`) — no Gmail
credential is read or written. Share the target spreadsheet with the authorized Google account (editor).

#### Setup and one live connection test (PowerShell)

```powershell
# 1. One-time consent (opens a loopback OAuth flow; grants the Sheets 'spreadsheets' scope only):
pnpm cli sheets-auth

# 2. Point at the spreadsheet and select the real provider (leave the write flag/confirm off for now):
$env:GOOGLE_SHEETS_PROVIDER = "http"
$env:GOOGLE_SHEETS_SPREADSHEET_ID = "<your-spreadsheet-id>"

# 3. Verify credentials + spreadsheet/tab access WITHOUT writing anything:
pnpm cli outreach-sheet-verify

# 4. Preview the exact projection (row counts) — still writes nothing:
pnpm cli outreach-sync-sheet --preview

# 5. Perform the real, fully-gated write (all four gates required):
$env:GOOGLE_SHEETS_SYNC_ENABLED = "true"
pnpm cli outreach-sync-sheet --confirm-sheet-write
#    scoped to one campaign (upsert-only): pnpm cli outreach-sync-sheet --campaign "<name>" --confirm-sheet-write
```

### Recovery & reconciliation

- **Reply/bounce/unsubscribe already handled:** reply sync is idempotent — a Gmail message id is recorded
  as a reply at most once (`outreach_replies_message_uk`); re-running applies nothing new.
- **Wrong follow-up date:** `outreach-postpone-followup` sets a new explicit due instant; every change is
  an immutable event. `outreach-cancel-followup` cancels a pending follow-up (history retained).
- **Mis-tracked record:** transition it to the correct state (`outreach-transition`); terminal states
  (`UNSUBSCRIBED`, `DO_NOT_CONTACT`, `CLOSED_WON`, `CLOSED_LOST`) free the active-uniqueness slot so a new
  record can be created later if appropriate. Message/reply/event history is never overwritten.
- **Rollback:** `scripts/rollback/0026_outreach_tracking_down.sql` drops the tables but **refuses** while
  any outreach table holds data (history must be exported/cleared first).

## Phase 17B — controlled first-send smoke test (exactly ONE tracked send; heavily gated)

Phase 17B performs EXACTLY ONE fully-tracked, allowlisted send from `admin@scaleflow.it.com` to the
operator-owned test inbox `kheadi10@gmail.com` (never a real prospect). It reuses the existing safeguarded
primitives (create a Gmail DRAFT → verify that exact known draft → `sendExistingDraft`); it adds no raw
`messages.send`, no bulk send, no automatic follow-up send, and no reply classification.

**Preconditions (fail closed on any mismatch):** migration `0026` applied; `OUTREACH_TRACKING_ENABLED=true`;
the sending credential (`GMAIL_CREDENTIALS_FILE`, `gmail.compose` scope) authorizes `admin@scaleflow.it.com`
(one-time `pnpm cli gmail-auth` with `GMAIL_ACCOUNT_EMAIL=admin@scaleflow.it.com`); `GMAIL_ACCOUNT_EMAIL`
equals the sender exactly; `OUTREACH_SMOKE_TEST_RECIPIENT` equals `kheadi10@gmail.com`. Nothing sends until the
explicit smoke-send command below with every gate on.

### Prepare the one controlled test record (never sends)

```powershell
# Identity + allowlist (needed before init so the record's contact is the allowlisted address).
$env:GMAIL_ACCOUNT_EMAIL         = "admin@scaleflow.it.com"
$env:GMAIL_SENDER_NAME           = "ScaleFlow"
$env:OUTREACH_TRACKING_ENABLED   = "true"
$env:OUTREACH_SMOKE_TEST_RECIPIENT = "kheadi10@gmail.com"

# Preflight (reports only; never sends):
pnpm cli outreach-readiness

# 1. Create the ONE synthetic controlled test record (campaign + synthetic lead + INITIAL step-0 message)
#    at AWAITING_APPROVAL. Prints the record id + message content SHA-256. NEVER sends.
pnpm cli outreach-smoke-init

# 2. Record the human approval → APPROVED_TO_SEND (valid for OUTREACH_APPROVAL_TTL_MINUTES, default 60). NEVER sends.
pnpm cli outreach-smoke-approve --record <record-id> --by "<operator>"
```

### The ONE real send (all gates on)

```powershell
# Turn on every gate ONLY for this step. The approval must still be unexpired.
$env:OUTREACH_SMOKE_TEST_ENABLED = "true"
$env:SENDING_ENABLED             = "true"
$env:OUTBOUND_ACTIONS_ENABLED    = "true"
$env:DRY_RUN                     = "false"
$env:SENDING_PROVIDER            = "http"

pnpm cli outreach-smoke-send --record <record-id> --sender admin@scaleflow.it.com --recipient kheadi10@gmail.com --provider http --confirm-phase-17b
```

On success the record advances to `INITIAL_SENT` atomically: the Gmail message/thread id + sent timestamp are
attached to the message (subject/body/hash never mutated), an immutable event trail is written, and a
tracking-only follow-up (step 1, `DUE`) is created but NEVER auto-sent. Then synchronize and verify:

```powershell
$env:GOOGLE_SHEETS_PROVIDER      = "http"    # (if using the live Sheet; see Phase 17A3)
$env:GOOGLE_SHEETS_SYNC_ENABLED  = "true"
pnpm cli outreach-sync-sheet --confirm-sheet-write
pnpm cli outreach-timeline --record <record-id>   # confirm Outreach + Messages rows exist
```

### Reply-detection test (run ONLY after you manually reply from kheadi10@gmail.com)

```powershell
# Reads ONLY the stored Gmail thread, excludes the sender's own messages, cancels the pending follow-up on a
# genuine reply, updates the database, then re-syncs the Sheet. NEVER sends/drafts/modifies Gmail.
$env:GMAIL_REPLY_SYNC_ENABLED = "true"
pnpm cli gmail-read-auth                                   # one-time gmail.readonly consent (separate 0600 file)
pnpm cli outreach-sync-replies --record <record-id> --confirm-gmail-read
pnpm cli outreach-sync-sheet --confirm-sheet-write
```

### Recovery (never sends; idempotent)

- **Unknown send outcome, or the provider sent but persistence failed:** do NOT re-run the send. Confirm the
  Gmail message/thread id, then attach it without sending:

  ```powershell
  pnpm cli outreach-smoke-reconcile --record <record-id> --gmail-message-id <id> --gmail-thread-id <id>
  ```

  It refuses if a send is already recorded, so it is safe to run once the ids are known. `drafts.send` has no
  provider idempotency key, so a human confirms the single message in Gmail before reconciling.

## Phase 17C — delivery failure reconciliation (read-only DSN detection; NEVER sends)

Phase 17C closes the gap the Phase 17B smoke test exposed: an email can be recorded `INITIAL_SENT` while
Gmail later emits a separate Delivery Status Notification (DSN) — e.g. `550 5.7.1 likely unsolicited mail` —
so the recipient never received it, and the bounce may land in a **different Gmail thread** than the outbound.
The outbound message stays historically *sent* (its immutable row is never mutated), but the outreach RECORD
state must become `BOUNCED` so no follow-up is ever sent to an address that rejected the mail.

- **What it does.** `outreach-reconcile-delivery` reads Gmail **strictly read-only**, finds DSNs connected to
  tracked outbound messages, correlates each to EXACTLY ONE outbound (by RFC Message-ID reference, shared Gmail
  thread, or failed-recipient address — **fail-closed on ambiguity**, and unrelated/non-DSN messages are never
  classified), and — unless `--dry-report` — transitions permanent (5.x.x) bounces to `BOUNCED`, cancels every
  pending follow-up, and appends immutable `BOUNCE_DETECTED` + `FOLLOWUPS_CANCELLED` events. Temporary (4.x.x)
  failures are recorded as `DELIVERY_UNKNOWN` for operator review with **no state change and no retry**. It does
  NOT set do-not-contact and **never auto-retries**. Nothing here sends, drafts, labels, archives, or modifies
  Gmail. Migration `0027` adds one additive `outreach_delivery_events` table (idempotency key: the DSN's own
  Gmail message id).
- **Live read gates (fail-closed; same as Phase 17A2/17A3).** A live Gmail read needs
  `GMAIL_REPLY_SYNC_ENABLED=true` AND `--confirm-gmail-read`, the SEPARATE read-only credential
  (`gmail-read-auth`, exactly the `gmail.readonly` scope). A requested live read that fails any guard exits
  nonzero and **never** falls back to mock; the offline mock reader runs only with `--mock`.

```powershell
pnpm cli outreach-reconcile-delivery --record <record-id>   # one record
pnpm cli outreach-reconcile-delivery --campaign "<name>"    # one campaign (unresolved sent records)
pnpm cli outreach-reconcile-delivery                        # all eligible unresolved sent records
#   --dry-report : show the proposed correlation + state change; write NOTHING
#   --mock       : offline mock reader (no external Gmail access)
```

### Reconcile the Phase 17B incident (record acded064-b681-4c0d-9d16-45966a5edc43)

The Phase 17B controlled send was recorded `INITIAL_SENT`, but Gmail returned a `550 5.7.1` DSN (likely
unsolicited mail) and the recipient did not receive it. Reconcile it as an operator step (read-only consent
`gmail-read-auth` must already be granted; this reads Gmail but sends nothing and modifies no message):

```powershell
$env:OUTREACH_TRACKING_ENABLED = "true"
$env:GMAIL_REPLY_SYNC_ENABLED  = "true"

# 1. DRY REPORT first — shows the proposed DSN correlation + state change; writes NOTHING:
pnpm cli outreach-reconcile-delivery --record acded064-b681-4c0d-9d16-45966a5edc43 --confirm-gmail-read --dry-report

# 2. Apply it — transitions the record to BOUNCED and cancels the pending follow-up (still sends nothing):
pnpm cli outreach-reconcile-delivery --record acded064-b681-4c0d-9d16-45966a5edc43 --confirm-gmail-read

# 3. Verify, then synchronize the operator Sheet (Postgres stays authoritative):
pnpm cli outreach-timeline --record acded064-b681-4c0d-9d16-45966a5edc43   # shows the BOUNCE_DETECTED delivery event
pnpm cli outreach-sync-sheet --confirm-sheet-write
```

Reconciliation is idempotent: a given DSN is recorded at most once, and replaying it changes nothing.

## Phase 17C1 — hardened DSN correlation + delivery-event correction

Phase 17C1 fixes a correlation defect the first live run exposed: reconciling record
`acded064-b681-4c0d-9d16-45966a5edc43` attached **five** false `DELIVERY_UNKNOWN` events — two from
2026-07-30 and **three from May 2026, before the tracked email existed** — even though the record was already
correctly `BOUNCED` by the reply-sync path. Root causes: the `--record` path ignored the record's terminal
state, and recipient-only correlation had no time window, so historical DSNs for the same address attached to a
later send.

Hardened rules (all read-only; no send, Gmail mutation, or auto-retry):

- **Eligibility.** Only outbound messages with a sent timestamp, a Gmail/RFC message id, and an UNRESOLVED
  record (not `BOUNCED`/`UNSUBSCRIBED`/`DO_NOT_CONTACT`/`CLOSED_WON`/`CLOSED_LOST`) are reconciled — including
  the `--record` form. No new delivery event is ever written for an already-terminal record.
- **Time window.** A DSN must be received AFTER the outbound was sent (± a 5-minute clock-skew tolerance). A DSN
  that predates the outbound can never correlate to it — the three May DSNs are rejected outright.
- **Correlation priority.** (1) exact RFC Message-ID reference, (2) exact original Gmail message id, (3) exact
  outbound Gmail thread id, then (4) recipient-only — and recipient-only ONLY when a single unresolved outbound
  matches within a narrow 14-day delivery window and no stronger identifier conflicts. Ambiguity is rejected;
  the dry report shows the correlation strength.
- **Parsing.** Handles `multipart/report`, `message/delivery-status`, nested `message/rfc822`, and a
  `text/plain` fallback; extracts Action/Status/Diagnostic-Code/Final-/Original-Recipient/Original-Message-ID/
  X-Failed-Recipients. `550 5.7.1` / `5.x.x` → PERMANENT (BOUNCED); `4.x.x` → TEMPORARY; unknown only when no
  reliable status exists.

Migration `0028` adds additive `superseded_at` / `superseded_reason` / `superseded_by` columns to
`outreach_delivery_events`.

### Correct the five false delivery events (record acded064-…)

`outreach-correct-delivery-events` INVALIDATES (supersedes) the named delivery events — it **never deletes**
immutable history — and appends an immutable `DELIVERY_RECONCILIATION_CORRECTED` event. It changes NO outreach
state and touches NO follow-up: the record stays `BOUNCED` with its follow-up cancelled. It touches no Gmail
and sends nothing. Dry-run is the default; `--apply` (with `--by` and `--reason`) writes.

```powershell
$env:OUTREACH_TRACKING_ENABLED = "true"

# 1. DRY RUN — shows which delivery events would be invalidated; writes NOTHING:
pnpm cli outreach-correct-delivery-events --dsn 19fb2ad74dcbc858 19fb283aaf8d1bb4 19e377fe744e940f 19e377e7d1ef4eab 19e262197cc7fd35

# 2. APPLY — invalidates the five events (history preserved) and annotates the record's timeline:
pnpm cli outreach-correct-delivery-events --dsn 19fb2ad74dcbc858 19fb283aaf8d1bb4 19e377fe744e940f 19e377e7d1ef4eab 19e262197cc7fd35 --apply --by "adi" --reason "Phase 17C1: DSNs mis-correlated (3 predate the outbound; record already BOUNCED by reply-sync)"

# 3. Verify, then synchronize the operator Sheet (Postgres stays authoritative):
pnpm cli outreach-timeline --record acded064-b681-4c0d-9d16-45966a5edc43
pnpm cli outreach-sync-sheet --confirm-sheet-write
```

The correction is idempotent — re-running it supersedes nothing more and appends no further event. After this
fix, `outreach-reconcile-delivery --record acded064-…` returns zero eligible outbounds (the record is terminal),
so no new false events can be created.
