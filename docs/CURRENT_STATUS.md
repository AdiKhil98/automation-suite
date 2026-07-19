# Current Status

## Current phase
Phase 13 (scheduling and daily operations) — COMPLETE. UNCOMMITTED; awaiting operator review and commit approval.

## Completed work
- Phases 0–12 are committed and tagged through `phase-12-gmail-drafts` (`5c14792`).
- Phase 13 (uncommitted): deterministic recipient-local scheduling with verified IANA timezones,
  DST-aware UTC conversion, configurable weekday/business-hour windows, earliest-time/horizon rules,
  account-wide minimum spacing, and per-recipient-local-day caps.
- Scheduling is an inert database plan only: `schedule-drafts`, read-only `schedule-status`,
  `cancel-schedule`, and `reschedule`. It never calls Gmail, mutates a Gmail draft, or sends email.
- Fail-closed eligibility requires a `DRAFT_CREATED` lead, created Gmail draft/provider id, approved
  finalized-content hash, verified `contact_email`, and verified `contact_timezone`. Missing or invalid
  timezone routes to `NEEDS_MANUAL_REVIEW`; an existing active schedule is reused.
- Migration 0014 adds `contact_timezone` and `send_schedules`, including one-active-schedule-per-draft,
  integrity binding to the draft/content/recipient/time/rules, retained cancel/reschedule history, and
  a reverse migration. Lead state adds `SCHEDULED`; cancellation returns it to `DRAFT_CREATED`.
- Verification passed: 372 unit tests, 36 PostgreSQL integration tests, 9 browser tests, migration 0014
  apply/reverse, lint, typecheck, and secret/private-data scan.

## Uncommitted changes
All Phase 13 implementation, migration, tests, configuration documentation, and handoff docs. Nothing is
committed, tagged, or pushed; the exact proposed commit must be reviewed and explicitly approved first.

## Local database note
The integration suite intentionally truncates the configured test database. It removed the restored local
Phase 12 lead/audit records; the real Gmail draft was not called, read, mutated, or sent. Do not restore the
Phase 12 seed as part of the Phase 13 handoff.

## Remaining tasks
- Review the complete Phase 13 diff and proposed commit contents.
- Commit/tag/push only after explicit operator approval.
- Phase 14 controlled sending is not started.

## Exact commands to continue
- Suite: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm test:integration`; `pnpm test:browser`.
- Migration: apply 0014, run `scripts/rollback/0014_send_schedules_down.sql`, then reapply 0014.
- Warning: `pnpm test:integration` truncates the configured database.

## Safety restrictions
- `SCHEDULING_ENABLED=false` by default. `--dry-run` computes a proposed slot without database writes.
- Phase 13 records intended times only. No Gmail calls, draft mutation, live scheduling, sending, inbox work,
  reply detection, follow-ups, or external writes.
- `GMAIL_DRAFTS_ENABLED=false` remains the draft-creation default; Phase 14 sending gates do not exist yet.
- Do NOT restore the Phase 12 seed or begin Phase 14 during this handoff.
