# Outreach automation (Europe/London)

> **PRODUCTION SCHEDULER = systemd on the VM.** Read "Current production runtime" below BEFORE the
> n8n sections further down. The n8n workflows are LEGACY/OPTIONAL and are **not** what runs today.
> Do not treat them as production truth.

Automation Suite is the execution/source of truth; the scheduler only triggers the CLI. No second
send path exists — the runner reuses the Phase 14/15 `SendService` and the confirmed-send → outreach
bridge. Nothing here is deployed or enabled by committing this repo.

## Current production runtime (authoritative)

The live VM runs the CLI from **systemd timers**, at `/home/opc/automation-suite`, as user `opc`.
The operational gates live in the **service unit environment**; the repo `.env` stays at safe
defaults (`DRY_RUN=true`, `SENDING_ENABLED=false`, `OUTBOUND_ACTIONS_ENABLED=false`,
`SENDING_PROVIDER=mock`). That split is deliberate: running a CLI command by hand on the VM does
**not** inherit the sending gates, so a manual invocation cannot send.

| Unit | Status | Cadence | Command | Sends? |
|---|---|---|---|---|
| `automation-suite-scheduled-sends.{service,timer}` | **LIVE** (enabled; has performed a real send) | every minute | `pnpm cli run-scheduled-sends` | **YES — the sole sender** |
| `automation-suite-followups.{service,timer}` | **PROPOSED, not installed** (`deploy/systemd/`) | Mon–Fri 08:00–18:00 /15 min | `pnpm cli run-followup-automation` | **NO — cannot send** |

`run-scheduled-sends` is the **only** orchestrator that dispatches email. It alone carries
`SENDING_ENABLED`, `OUTBOUND_ACTIONS_ENABLED`, `SCHEDULED_SEND_ENABLED`, `SENDING_PROVIDER=http`
and `DRY_RUN=false`. **Never add those variables to any other unit.**

Follow-up automation is a **separate** unit with none of those gates. It composes follow-up copy,
parks it in the human review queue, and (after a human approves) advances it as far as a send
schedule — then stops. It reaches `SendService` through no code path. It also does not override
`DRY_RUN`, so the `.env` default `DRY_RUN=true` remains a second, independent block on the send path
inside that process; composition, Gmail DRAFT creation, and scheduling do not consult `DRY_RUN` and
work normally.

**The handover point between the two units is the send schedule.** Once follow-up progression creates
a `SCHEDULED` schedule and the lead reaches `SCHEDULED`, the live every-minute sender owns it and
will dispatch at its due instant (after its own preflight, suppression re-check, authorization and
cap). Anything that must be inspected before it can go out has to be inspected **before** that stage.

### Legacy / optional: n8n
The n8n workflow JSON below predates the systemd deployment. It is kept as a portable alternative
for a host without systemd. **It is not the active scheduler.** If both were ever enabled at once
they would double-trigger the same commands; the commands are idempotent, but do not do this.

## Components (migration 0038)
- `scheduled_send_authorizations` — the durable, bounded (≤14 days), revocable, capped, policy-version-bound
  human pre-authorization that replaces the interactive per-send readiness/TTY **for automated sends only**.
- `sending_readiness_approvals.source` (`INTERACTIVE` | `SCHEDULED`) — the manual path reads only
  `INTERACTIVE`; the runner mints a short-lived `SCHEDULED` session readiness from a valid authorization.
- CLI: `approve-scheduled-send` / `revoke-scheduled-send` / `scheduled-send-status` / `run-scheduled-sends`.
- Env: `SCHEDULED_SEND_ENABLED` (master, default false), `SCHEDULED_SEND_SESSION_READINESS_MINUTES` (default 30).

## One-time operator authorization (durable; replaces the morning manual readiness)
```
pnpm cli approve-scheduled-send --by "Adi" --days 14 --max-per-day 2
```
Revoke instantly at any time:
```
pnpm cli revoke-scheduled-send --id <authId> --by "Adi" --reason "pausing pilot"
```
Check gate + authorization state (read-only):
```
pnpm cli scheduled-send-status
```

## Server env (pilot)
NOTE: on the live VM these live in the **scheduled-send systemd unit**, not in `.env`.
`SENDING_ENABLED=true`, `OUTBOUND_ACTIONS_ENABLED=true`, `DRY_RUN=false`, `SENDING_PROVIDER=http`,
`SCHEDULED_SEND_ENABLED=true`, `OUTREACH_TRACKING_ENABLED=true`, `SENDING_DAILY_CAP=2`,
`SCHEDULING_ENABLED=true`, `SCHEDULING_DAILY_CAP=2`, `GMAIL_ACCOUNT_EMAIL=admin@scaleflow.it.com`.
Gmail compose + readonly OAuth credential files present (0600). Postgres = the operational DB with
migration 0038 applied.

## LEGACY/OPTIONAL — n8n workflows (NOT the active scheduler; see "Current production runtime")
Each is a **Schedule Trigger → Execute Command** running the CLI on the persistent server. Set the
workflow timezone to `Europe/London` so BST/GMT is handled automatically; the send gate additionally
verifies `timing=due` and the scheduling rules enforce weekdays.

### 1. Nightly scheduling pass — 22:00 daily
Schedules fully approved/send-ready leads into the next weekday 09:15 slot. Leads approved after this
pass wait for the next night → next business day.
```json
{
  "name": "AS – nightly scheduling (22:00 London)",
  "nodes": [
    { "id": "trg", "name": "22:00 daily", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.1, "position": [0,0],
      "parameters": { "rule": { "interval": [ { "field": "cronExpression", "expression": "0 22 * * *" } ] } } },
    { "id": "cmd", "name": "schedule-drafts", "type": "n8n-nodes-base.executeCommand", "typeVersion": 1, "position": [260,0],
      "parameters": { "command": "cd /srv/automation-suite && pnpm cli schedule-drafts --limit 2" } }
  ],
  "connections": { "22:00 daily": { "main": [ [ { "node": "schedule-drafts", "type": "main", "index": 0 } ] ] } },
  "settings": { "timezone": "Europe/London" }
}
```

### 2. Send pass — 09:15 Mon–Fri
Runs the automated sender. Fail-closed on every gate; sends ≤ cap; auto-enrolls; stops on OUTCOME_UNKNOWN.
```json
{
  "name": "AS – scheduled send (09:15 Mon–Fri London)",
  "nodes": [
    { "id": "trg", "name": "09:15 Mon–Fri", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.1, "position": [0,0],
      "parameters": { "rule": { "interval": [ { "field": "cronExpression", "expression": "15 9 * * 1-5" } ] } } },
    { "id": "cmd", "name": "run-scheduled-sends", "type": "n8n-nodes-base.executeCommand", "typeVersion": 1, "position": [260,0],
      "parameters": { "command": "cd /srv/automation-suite && pnpm cli run-scheduled-sends" } }
  ],
  "connections": { "09:15 Mon–Fri": { "main": [ [ { "node": "run-scheduled-sends", "type": "main", "index": 0 } ] ] } },
  "settings": { "timezone": "Europe/London" }
}
```
The command prints a `SUMMARY_JSON {...}` line and exits non-zero on OUTCOME_UNKNOWN / failure / failed
enrollment — wire an n8n error/alert on non-zero exit.

### 3. Reply/bounce pass — hourly, business hours Mon–Fri (read-only Gmail)
```json
{
  "name": "AS – reply/bounce sync (hourly London)",
  "nodes": [
    { "id": "trg", "name": "hourly 08–20 Mon–Fri", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.1, "position": [0,0],
      "parameters": { "rule": { "interval": [ { "field": "cronExpression", "expression": "5 8-20 * * 1-5" } ] } } },
    { "id": "replies", "name": "sync-replies", "type": "n8n-nodes-base.executeCommand", "typeVersion": 1, "position": [260,-80],
      "parameters": { "command": "cd /srv/automation-suite && pnpm cli outreach-sync-replies --confirm-gmail-read" } },
    { "id": "bounces", "name": "reconcile-delivery", "type": "n8n-nodes-base.executeCommand", "typeVersion": 1, "position": [260,80],
      "parameters": { "command": "cd /srv/automation-suite && pnpm cli outreach-reconcile-delivery --confirm-gmail-read" } }
  ],
  "connections": { "hourly 08–20 Mon–Fri": { "main": [ [ { "node": "sync-replies", "type": "main", "index": 0 }, { "node": "reconcile-delivery", "type": "main", "index": 0 } ] ] } },
  "settings": { "timezone": "Europe/London" }
}
```

### 4. Follow-up automation pass — Mon–Fri 08:00–18:00 every 15 min (NEVER sends)
Automates everything AROUND human review of outreach follow-ups, and nothing of human review itself.
Two independently-gated phases in one command:

* **prepare** — composes follow-ups that are DUE through the existing writer → deterministic
  validation → independent adversarial reviewer → gate, using the step-specific job (internal step 1
  = lesson Follow-up #2 "add clarity", 2 = #3 "compress + reduce pressure", 3 = #4 "binary yes/no
  close"), then stops at the EXISTING human review queue.
* **progress** — takes follow-ups a HUMAN approved and advances them ONE stage per run through the
  existing services: reply finalization → Gmail draft (inside the existing thread) → send schedule.
  Then it stops. It never dispatches.

Both are idempotent under repeated runs and fail closed on reply / bounce / unsubscribe /
do-not-contact / meeting booked / closed. Sending remains exclusively workflow 2 above.

```json
{
  "name": "AS – follow-up automation (Mon–Fri London; never sends) [LEGACY n8n form]",
  "nodes": [
    { "id": "trg", "name": "every 15 min 08–18 Mon–Fri", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.1, "position": [0,0],
      "parameters": { "rule": { "interval": [ { "field": "cronExpression", "expression": "0,15,30,45 8-17 * * 1-5" } ] } } },
    { "id": "cmd", "name": "run-followup-automation", "type": "n8n-nodes-base.executeCommand", "typeVersion": 1, "position": [260,0],
      "parameters": { "command": "cd /srv/automation-suite && pnpm cli run-followup-automation" } }
  ],
  "connections": { "08:40/13:40/17:40 Mon–Fri": { "main": [ [ { "node": "run-followup-automation", "type": "main", "index": 0 } ] ] } },
  "settings": { "timezone": "Europe/London" }
}
```
It prints a `SUMMARY_JSON {...}` line and exits non-zero when a composition or a stage FAILED (a
follow-up BLOCKED by a reply is normal operation, not a failure) — wire the same non-zero alert.

Env for this pass: `FOLLOWUP_PREPARATION_ENABLED=true`, `FOLLOWUP_PROGRESSION_ENABLED=true` (both
default **false**), plus the already-required `OUTREACH_TRACKING_ENABLED=true`,
`EMAIL_GENERATION_ENABLED=true`, `GMAIL_DRAFTS_ENABLED=true`, `GMAIL_DRAFT_ACTIONS_ENABLED=true`,
`SCHEDULING_ENABLED=true`. Per-run caps: `FOLLOWUP_PREPARATION_MAX_PER_RUN` (default 5, bounds model
spend) and `FOLLOWUP_PROGRESSION_MAX_PER_RUN` (default 10).

**On the live VM use the systemd unit**, not the n8n workflow above:
`deploy/systemd/automation-suite-followups.{service,timer}`. It ships with both `FOLLOWUP_*` gates
set to `false`, so installing and enabling the timer performs no work until they are deliberately
flipped. The n8n JSON above is the legacy alternative for a non-systemd host.

### Operator workflow once this pass is enabled
1. A follow-up becomes due → the 08:40 pass composes and AI-reviews it.
2. It appears in the existing review dashboard.
3. **You approve or reject.** This is the only routine manual step.
4. The next pass finalizes it, creates the threaded Gmail draft, and schedules it.
5. The 09:15 send pass dispatches it via `SendService`, re-checking suppression immediately first.
6. A reply / bounce / unsubscribe / DNC / meeting / closed stops the sequence at every one of those
   points, including after approval and after scheduling.

Rejecting follow-up copy rejects **the draft, not the prospect**: the lead returns to `SENT`, the
outreach record is untouched, and that step's pending row is cancelled so the queue does not spin.

## Deploying a schema + code change while the sender is live (runbook)

The scheduled-send timer fires EVERY MINUTE. A schema/code deployment must not race it, so the
deployment opens a short maintenance window by **stopping the TIMER only**. The sender's service unit
is never edited, disabled, or altered — stopping a timer leaves the unit intact and a single
`start` restores it.

**Order is not negotiable: migration BEFORE code.** New code reads `email_drafts.sequence_step` /
`outreach_record_id` in four repositories, two of which are on the live sender's hot path
(`EnrollInputRepository.load`, used by the every-minute recovery sweep and after every confirmed
send; and `FollowupSendContextRepository.forLead`, used per lead in `sendOne`). New code on the old
schema would make the live sender throw `column ... does not exist` every minute. The reverse is
safe: migration 0044 is additive, and old code never selects the new columns, omits `sequence_step`
on insert (so `DEFAULT 0` applies), and writes `NULL` `outreach_record_id` (so the new partial unique
index does not apply). Old-code-on-new-schema was verified against a disposable database.

```bash
# --- 0. Pre-flight (read-only) -------------------------------------------------------------
systemctl cat automation-suite-scheduled-sends.service   # capture the exact ExecStart form
systemctl list-timers --all                              # confirm what else is scheduled
#    ^ CRITICAL: confirm nothing runs `schedule-drafts`. It sweeps every DRAFT_CREATED lead and
#      would auto-schedule a follow-up that is still awaiting manual threading verification.

# --- 1. Open the maintenance window: stop the TIMER only ----------------------------------
sudo systemctl stop automation-suite-scheduled-sends.timer
systemctl is-active automation-suite-scheduled-sends.timer    # expect: inactive
# 2. Verify no run is mid-flight before touching the schema:
systemctl is-active automation-suite-scheduled-sends.service  # expect: inactive (or dead)
journalctl -u automation-suite-scheduled-sends.service -n 20 --no-pager

# --- 3. Back up, then migrate --------------------------------------------------------------
pg_dump "$DATABASE_URL" > ~/backup-pre-0044-$(date +%F-%H%M).sql
cd /home/opc/automation-suite && pnpm db:migrate

# --- 4. Verify the schema ------------------------------------------------------------------
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conname IN
  ('outreach_record_status_ck','outreach_followup_step_ck','email_draft_sequence_step_ck');"
psql "$DATABASE_URL" -c "SELECT column_name, column_default, is_nullable
  FROM information_schema.columns WHERE table_name='email_drafts'
  AND column_name IN ('sequence_step','outreach_record_id');"
psql "$DATABASE_URL" -c "SELECT indexdef FROM pg_indexes
  WHERE indexname='email_drafts_outreach_sequence_uk';"

# --- 5. Deploy the code --------------------------------------------------------------------
git pull && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test

# --- 6. Smoke-test the sender with its gates OFF (the shell has no unit environment, so .env's
# ---    safe defaults apply and this cannot send) -------------------------------------------
pnpm cli scheduled-send-status
pnpm cli run-scheduled-sends        # expect GATES_DISABLED; recovery sweep proves the new
                                    # enrollment queries work against the migrated schema

# --- 7. Close the maintenance window -------------------------------------------------------
sudo systemctl start automation-suite-scheduled-sends.timer
systemctl is-active automation-suite-scheduled-sends.timer    # expect: active
systemctl list-timers automation-suite-scheduled-sends.timer
journalctl -u automation-suite-scheduled-sends.service -n 50 --no-pager   # watch 2-3 cycles
```

Only once the sender is confirmed healthy, install the follow-up unit (both `FOLLOWUP_*` gates
false), then enable preparation, then run the controlled first-follow-up validation below.

## Inbox freshness before preparation (ExecStartPre chain)

Reply/bounce sync was never scheduled anywhere before this feature, so follow-up preparation could
otherwise reason about an inbox nobody had read for days. The follow-up unit therefore runs both
read-only Gmail passes as `ExecStartPre` guards, in a fixed order, before the runner:

```
1. outreach-sync-replies        --confirm-gmail-read --strict-live-read
2. outreach-reconcile-delivery  --confirm-gmail-read --strict-live-read
3. run-followup-automation                      (only if 1 and 2 both succeeded)
```

systemd runs `ExecStartPre` entries in order and, for `Type=oneshot`, aborts the unit if any exits
non-zero — so `ExecStart` never runs after a failed guard. Both passes use the SEPARATE read-only
credential (`.gmail-read-credentials.json`, mode 600); the compose/send credential cannot reach
them, and neither sends, drafts, labels, archives, or modifies anything in Gmail.

### What this chain guarantees

**Ordering and configuration validity.** Both commands exit non-zero when a live read is REFUSED up
front: `GMAIL_REPLY_SYNC_ENABLED` off, `--confirm-gmail-read` missing, absent or wrong-scope
credentials, an unusable token store.

**Proof-of-read, via `--strict-live-read`.** Without that flag the readers return an empty result on
a failed Gmail call — correct for reply detection, since a transport error must never be mistaken
for "a reply exists" — but it makes an outage indistinguishable from "inbox checked, nothing new".

Strict mode closes that gap without changing what the readers return. Each failed read is recorded
as STRUCTURED DATA (`GmailReadFailure`: scope, id, reason, HTTP status, short detail — never parsed
from logs), and the command exits non-zero if any selected read did not complete. Covered: timeout,
network error, 401, 403, 429, 5xx, and a 2xx whose body is unusable.

Reading successfully and finding nothing is still success. A message that was read but is not a
usable DSN is not a failure either.

Partial reads stay applied: if one thread is read and contains a genuine reply while another thread
fails, the reply is applied (that only ever ADDS suppression) and the command still exits non-zero
so the unit aborts. Default, non-strict behaviour is byte-identical to before for every manual and
ad-hoc use.

### Paid model calls

Preparation calls a writer and a reviewer model per follow-up. Two properties keep that bounded:

- **Lazy provider construction.** `run-followup-automation` builds the LLM provider inside `compose`,
  which the runner reaches only for a candidate that is genuinely due, unsuppressed, not already
  prepared, and whose lead sits at the `SENT` re-entry point. A timer fire with nothing due
  constructs no OpenAI client and makes zero paid calls. Pinned by
  `tests/unit/followup-deployment-safety.test.ts`.
- **`ALLOW_PAID_LLM_CALLS` lives in a production drop-in, never in git and never in `.env`.** The
  repository unit ships it `false`. `.env` is the wrong home because it is a GLOBAL paid-call kill
  switch — arming it there would arm paid calls for every CLI invocation on the box, including
  ad-hoc manual ones. In the unit's environment it is scoped to this service alone. See
  `deploy/systemd/automation-suite-followups.service.d/20-preparation-live.conf.example`.

With `LLM_PROVIDER=openai` and `ALLOW_PAID_LLM_CALLS=false`, `buildEmailProvider` throws rather than
silently falling back to the mock, so a misconfigured box fails visibly instead of producing fake
copy.

- **The production drop-in must also SELECT the provider (`LLM_PROVIDER=openai`).**
  `ALLOW_PAID_LLM_CALLS=true` only PERMITS spending; it selects nothing, and `LLM_PROVIDER` defaults
  to `mock`. A box armed for production but left on that default would compose FIXTURE copy and
  persist it into the human review queue as a real draft for a real prospect. Unattended preparation
  therefore runs a preflight after its gates and BEFORE listing a single candidate: a non-live
  provider aborts the whole run (exit non-zero, unit fails) unless
  `FOLLOWUP_PREPARATION_ALLOW_MOCK_LLM=true` was set deliberately, and a live provider with
  incomplete configuration (no key, unverified prices, unpriced model) fails the same way.
  Pinned by `tests/unit/followup-deployment-safety.test.ts`.
- **The MODELS stay in validated `.env`, not in the drop-in.** `EMAIL_WRITER_MODEL` /
  `EMAIL_REVIEWER_MODEL` are not authority switches and are already hard-gated — an unknown or
  misspelled model has no verified price and throws before any paid call. Pinning them in systemd
  would split model configuration across two places and let an ad-hoc `outreach-compose-preview` use
  a different model than the one that wrote the copy an operator is reviewing. The drop-in carries
  AUTHORITY (which provider, whether spending is allowed, which phases run); `.env` carries
  validated configuration.

### Adopting the codified unit over the manual drop-ins

`ExecStartPre` is a LIST. Installing the repository unit while
`/etc/systemd/system/automation-suite-followups.service.d/10-inbox-safety.conf` still exists would
ACCUMULATE both copies and run each Gmail read twice. Delete that drop-in when adopting the unit;
keep `20-preparation-live.conf`, which carries the production-only switches.

## Due-state promotion (how a follow-up becomes due without an operator)

`scheduleFollowup` writes a follow-up ROW with an explicit due instant but deliberately does not move
the record's status — a record that has only sent its initial email stays `INITIAL_SENT`. Preparation
re-checks suppression with `checkFollowupSendAllowed`, which requires `FOLLOW_UP_N_DUE`. Nothing
produced that status automatically, so every due follow-up was reported
`BLOCKED / NOT_AWAITING_FOLLOWUP` until an operator hand-ran `outreach transition` — which defeats
the unattended design.

Phase A0 of `run-followup-automation` closes that gap without weakening a gate:

```text
an ACTIVE (DUE) row whose due instant has passed
+ a record in EXACTLY the status that step must follow (statusBeforeFollowupDue)
+ no suppression (reply / bounce / unsubscribe / DNC / meeting / closed / do-not-contact)
-> promote the record to followupDueStatus(step), and nothing else
```

- Driven only by a real, active, actually-due row — never by elapsed time or message history.
- Exactly one legal state-machine hop; a step/status disagreement is left untouched, never "fixed".
- `OutreachService.promoteFollowupDue` re-reads the row and record and re-runs the SAME pure decision
  INSIDE its transaction, then writes with a compare-and-set on the expected source status. A reply
  landing in between, or a concurrent run, loses the CAS: no status change, and no event.
- One `STATE_TRANSITION` event per real promotion, with `data.trigger='FOLLOWUP_DUE'`,
  `automated=true`, and the actor — so the timeline never implies a human made the transition.
- Adds NO authority: both statuses are non-sending, the follow-up row and due dates are untouched,
  and composing/drafting/scheduling/sending stay behind their own gates.
- Idempotent: a repeated timer run finds the record already due and writes nothing.

Promotion runs automatically as the first step of `--phase prepare` (and of the default `both`), and
can be run alone with `--phase promote` for inspection. Both accept `--record <id>`.

## Follow-up subject continuity (who owns the subject)

A follow-up never authors a subject. `renderEmail` builds it deterministically from the thread
subject (`Re: <original>`, prefixed once), and the writer prompt tells the model to echo the supplied
thread subject into all three options and into `selected_subject`. Deterministic validation enforces
exactly that contract for steps 1-3 — it does not merely skip subject checks:

| what the follow-up did | outcome |
|---|---|
| echoed the thread subject (with or without its `Re: ` prefix) | passes |
| invented a fresh hook, or mutated the subject text or case | `followup_subject_not_thread_subject:<n>` |
| selected something other than the thread subject | `followup_selected_subject_not_thread_subject` |
| was composed with no thread subject at all | `followup_thread_subject_missing` |

Step 0 is unchanged: three distinct options, the selected one among them, none generic or revealing.

**How a resumed follow-up is persisted.** Migration 0044 allows ONE live draft per (outreach record,
sequence step) — `email_drafts_outreach_sequence_uk`, which excludes only `REJECTED` rows. The failed
draft is `human_decision = NULL`, so it occupies that slot and IS the canonical draft for it.
`resume-email-review` therefore writes the reviewer outcome onto that row instead of appending a
second one: same row id, same subject/body, same writer provenance and evidence bindings, and
`human_decision` untouched (no forged rejection to slip past the index). Preparation still sees one
draft awaiting review, and progression picks up that same row once a human approves it. A draft with
no outreach record is unconstrained and still appends a new row.

**When the reviewer itself fails.** A resume that reaches the reviewer and gets back a refusal, a
provider error, or output the local schema rejects has already SPENT money, so the attempt is
recorded: the reviewer `model_call`, the added cost on the draft, and a bounded diagnostic on the
lead's timeline (exact schema issues, request/response ids, a truncated raw excerpt; the fuller
payload goes to `EMAIL_DEBUG_DIR`). The draft and the lead do not move, which is deliberate — the
same draft stays resumable, and a retry after the cause is fixed is still reviewer-only. Repeated
attempts accumulate on the draft rather than replacing each other. The run is still recorded
COMPLETED: it reached a determinate outcome (FAILED is reserved for a run that concluded nothing).

**The retry budget is cumulative.** A resume admits its reviewer call only when the draft's spend so
far plus the projected cost of this call stays inside `EMAIL_MAX_COST_USD_PER_LEAD`. Because failed
attempts are accounted on the draft, repeated retries eventually return `REVIEWER_BUDGET_BLOCKED`
with zero provider calls rather than quietly exceeding the per-lead cap; an unknown projected price
blocks as well.

**Retrying a follow-up that failed deterministic validation.** The writer call is already paid for
and the original writer output is preserved in the debug record, so the retry is
`resume-email-review` (one reviewer call, no writer call) — NOT a re-run of preparation, which will
skip the record as `AWAITING_HUMAN_REVIEW` while the failed draft is the newest one for that
(record, step). Rejecting the failed draft is not a retry: a `REJECTED` human decision cancels that
follow-up step. Resume requires the lead at `EMAIL_REVIEW_FAILED`, the draft at `REVIEW_FAILED`, and
the debug record for its run to still exist (`EMAIL_DEBUG_DIR`, 7-day TTL).

## Follow-up #2 must add something (anti-repetition)

A follow-up that says the first email again in different words is worthless, and one reached human
review in production. Three layers now answer it:

| layer | what it does | what it cannot do |
|---|---|---|
| writer prompt (step 1) | must state what the first email established, then add ONE new layer; reference the issue, never restate it | nothing forces a model to comply |
| deterministic gate | compares the candidate body with everything already sent; `followup_repeats_prior_message`. Free, runs before the reviewer | cannot see a true synonym rewrite |
| reviewer (`addsClarityNotRestart`) | answers "what new understanding does the prospect gain?"; false for paraphrase, repeated evidence, or a consequence restated in synonyms | judgement, not arithmetic |

The gate is STEP-AWARE, because the steps have different jobs:

| step | job | replay refused | new content required |
|---|---|---|---|
| 1 — Follow-up #2 | add clarity | yes | **yes** |
| 2 — Follow-up #3 | compress, reduce pressure | yes | no — a short compression that adds nothing is the job |
| 3 — Follow-up #4 | binary yes/no close | yes | no — a close carries no new business information by design |

A follow-up with no prior sent message fails closed (`followup_prior_messages_missing`): the
comparison could not be performed, and an unperformed check must never read as a pass.

The gate is deliberately conservative — naming the same issue ("cookie banner", "mobile", the
business name, the thread subject) is continuity, not repetition, and is never penalised. Thresholds
live in `REPETITION_LIMITS` with the measurements that set them.

**Regenerating rejected copy.** Rejecting a follow-up rejects THAT COPY: the lead returns to SENT,
the outreach record and its history are untouched, and the rejected draft is preserved. The pending
row is then cancelled by the preparation runner. To get replacement copy, re-schedule that step
(`outreach schedule-followup`); the next preparation run composes fresh copy for it, because a row
scheduled strictly AFTER the human rejection is a deliberate replacement request. Eligibility is read
from `email_drafts.human_reviewed_at` — the rejection, not the draft's creation, is the causal event —
and a rejection with no recorded decision time fails closed. No writer call happens until
preparation runs, and migration 0044's index allows the new draft because REJECTED rows are excluded
from it.

## What each sequence position is actually judged on

Every email in the sequence has a different job, so the deterministic rules and the approval gate are
per step, not global. Safety, honesty and style never move.

| | step 0 Outreach #1 | step 1 Follow-up #2 | step 2 Follow-up #3 | step 3 Follow-up #4 |
|---|---|---|---|---|
| job | earn attention | add clarity | compress, reduce pressure | binary yes/no close |
| paragraphs (prompt AND validator, from `PARAGRAPH_SHAPE`) | 2-4 | 1-3 | 1-2 | 1-2 |
| replay refused | n/a | yes | yes | yes |
| new content required | n/a | yes | no | no |
| body states observation / relevance / outcome | required | not required | not required | forbidden |
| genericity_score ceiling | 40 | 40 | not applied | not applied |
| reviewer: openingSpecific | required | required | not applied | not applied |
| reviewer: businessRelevanceClear, persuasive | required | not applied | not applied | not applied |
| reviewer: sufficientlyPersonalized | required | required | not applied | not applied |
| reviewer: singleObservation, confidentObservation | required | required | required | not applied |
| rendered CTA | "reply and I will share the details" | same | same | deterministic binary close |
| VIEW_CONCEPT allowed | yes | yes | yes | **no** |

Universal at every step, fail-closed: `decision=APPROVE`, no fabrication risk, evidence supports
every claim, urgency supported, competitor claims supported, human style, punctuation, exactly one
primary CTA, buyer language, conversation-not-audit, demo alignment, non-generic opening, plus the
sequence-job booleans for that step.

`genericity_score` is still reported honestly at every step; at steps 2-3 it is simply not read as a
rejection criterion, because a short message that leans on its thread is supposed to look reusable
out of context. What protects those positions instead is the anti-replay gate, the sequence-job
booleans, forbidden phrases, the CTA rules and every safety rule — all unchanged.

Every persisted draft is rendered from its REAL sequence position — `buildPersist` requires it and
`renderEmail` refuses a threaded email rendered as a first email — so what the reviewer judged, what
was stored, and what a later resume re-renders are the same bytes.

The final ask is written by the SYSTEM, not the model — the copy standard forbids a CTA in the body,
so a step-3 model writing its own close would create two asks. The reviewer is shown the exact
sentence that will be appended, so `binaryReplyClose` is judged against the message the recipient
actually receives.

## Controlled first-follow-up validation

**The point of no return is the SCHEDULE stage.** Dispatch requires `leads.status='SCHEDULED'` AND an
active `SCHEDULED` schedule. Until progression's third stage runs, the lead is at most
`DRAFT_CREATED` and is structurally invisible to the sender. Progression executes exactly ONE stage
per run, which is what makes the stop possible.

0. Promote and compose for ONE record before the global timer is ever started. With preparation
   enabled (`FOLLOWUP_PREPARATION_ENABLED=true`, progression `false`) and the timer still stopped:
   ```bash
   cd /home/opc/automation-suite
   # a) see exactly what would change; writes nothing, calls no model
   pnpm cli run-followup-automation --phase promote --record <outreachRecordId> --dry-run
   # b) promote that ONE record (one status change + one event; still no model call)
   pnpm cli run-followup-automation --phase promote --record <outreachRecordId>
   # c) compose that ONE follow-up (promotion is already a no-op; this is the first paid step)
   pnpm cli run-followup-automation --phase prepare --record <outreachRecordId>
   ```
   Only once that copy has been reviewed should the timer be started for the whole queue.
1. Enable preparation only (`FOLLOWUP_PREPARATION_ENABLED=true`, progression stays `false`).
   The due follow-up is promoted, composed + AI-reviewed and parked at `READY_FOR_HUMAN_APPROVAL`.
   Not sendable.
2. Inspect and approve in `review-dashboard`. Lead -> `HUMAN_APPROVED`. Still not sendable.
   (Rejecting returns the lead to `SENT` and cancels that step; it does NOT reject the prospect.)
3. Stage A — finalize. Run manually with scheduling forced off:
   ```bash
   cd /home/opc/automation-suite
   FOLLOWUP_PROGRESSION_ENABLED=true OUTREACH_TRACKING_ENABLED=true \
   GMAIL_DRAFTS_ENABLED=true GMAIL_DRAFT_ACTIONS_ENABLED=true \
   SCHEDULING_ENABLED=false \
   pnpm cli run-followup-automation --phase progress --lead <leadId>
   ```
4. Stage B — Gmail draft. Run the identical command again. Creates the real draft in the thread.
5. **STOP. Inspect in Gmail**: same thread as the original send, subject `Re: <original>`, correct
   recipient and body. `SCHEDULING_ENABLED=false` means an accidental third run fails closed.
6. Only if threading is correct, rerun with `SCHEDULING_ENABLED=true`. This creates the schedule and
   hands the follow-up to the live sender.
7. If threading is wrong: do NOT run stage C. Delete the Gmail draft by hand; it can never be sent.

## Fail-closed safeguard chain (nothing sends unless all pass)
1. `SCHEDULED_SEND_ENABLED=true` + `SENDING_ENABLED`/`OUTBOUND_ACTIONS_ENABLED=true` + `DRY_RUN=false` + `SENDING_PROVIDER=http`.
2. `OUTREACH_TRACKING_ENABLED=true` (enrollment is mandatory after a confirmed send).
3. A **valid durable authorization** (in-window, non-revoked, policy-version match, positive cap) → then and
   only then a short-lived `SCHEDULED` session readiness is minted from it.
4. Daily capacity = `min(SENDING_DAILY_CAP, authorization.max_per_day) − confirmed sends today`.
5. Per lead, the existing `SendService` runs preflight (re-verifies the **live Gmail draft envelope +
   fingerprint** immediately before send) and all eligibility gates; the confirmation is a deterministic
   attestation tied to the authorization id.
6. `OUTCOME_UNKNOWN` stops the run and is **never retried** (blocking-attempt guard prevents future
   auto-send until a human reconciles). Permanent bounce / reply keep cancelling follow-ups.

The manual `send-scheduled` path is unchanged — it still requires an `INTERACTIVE` readiness and the exact
interactive TTY confirmation.
