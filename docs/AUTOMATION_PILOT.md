# Scheduled-send automation pilot (Europe/London, Mon–Fri 09:15, cap 2/day)

Automation Suite is the execution/source of truth; **n8n is only a scheduler/trigger** (swappable for
systemd/cron). No second send path exists — the runner reuses the Phase 14/15 `SendService` and the
confirmed-send → outreach bridge. Nothing here is deployed or enabled by committing this repo.

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
`SENDING_ENABLED=true`, `OUTBOUND_ACTIONS_ENABLED=true`, `DRY_RUN=false`, `SENDING_PROVIDER=http`,
`SCHEDULED_SEND_ENABLED=true`, `OUTREACH_TRACKING_ENABLED=true`, `SENDING_DAILY_CAP=2`,
`SCHEDULING_ENABLED=true`, `SCHEDULING_DAILY_CAP=2`, `GMAIL_ACCOUNT_EMAIL=admin@scaleflow.it.com`.
Gmail compose + readonly OAuth credential files present (0600). Postgres = the operational DB with
migration 0038 applied.

## Three n8n workflows (server; timezone Europe/London)
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
