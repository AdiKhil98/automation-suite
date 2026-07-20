# Current Status

## Current phase
Phase 14 (controlled sending) — implemented MOCK-FIRST. UNCOMMITTED; awaiting operator review and
commit approval. No live sending provider is wired, so no email can be dispatched.

## Completed work
- Phases 0–13 are committed and tagged through `phase-13-daily-operations` (`49db3f9`, at HEAD).
  (Earlier `docs` said Phase 13 was uncommitted — that was stale; git shows it committed + tagged.)
- Phase 14 (uncommitted): deterministic, fail-closed sending of ONE existing, scheduled Gmail draft.
  A send requires all three kill switches armed, an intact schedule integrity binding, a verified
  non-suppressed recipient, a valid readiness approval, and an explicit fresh confirmation of the
  exact approved envelope. A confirmed send advances the lead `SCHEDULED → SENT` and marks the
  schedule `FULFILLED`.
- Provider state is verified twice (before confirmation and after confirmation immediately before
  reservation): authenticated account plus exact sender/recipient/subject/body/Cc/Bcc/attachments
  from only the known draft id. Missing or changed drafts fail closed and are never recreated.
- Sending is mock-first: the only wired provider is a zero-network `MockSendProvider`; the live
  (`http`) provider is intentionally unimplemented and refused at build time.
- Durable reservation and DB unique indexes prevent local concurrency/confirmed duplicates. An
  UNKNOWN provider result permanently blocks automatic retry. Because Gmail has no idempotency key
  for `drafts.send`, provider-level exactly-once delivery is not claimed.
- Migration `0015` (applied to the local DB) adds `sending_readiness_approvals`, `send_attempts`,
  extends `send_schedules` (`FULFILLED`/`INVALIDATED` + timestamps/reason), and adds the `email`
  suppression scope, with a reverse script. The state machine drops the direct `DRAFT_CREATED → SENT`
  edge.
- Verification: lint, typecheck, 381 unit tests, 39 PostgreSQL integration tests, 9 browser tests,
  isolated 3-test Phase 14 integration run, and migration 0015 apply/reverse/reapply passed.

## Uncommitted changes
Codex's first Phase 14 patch (migration 0015 + reverse, env sending flags, schema, suppression,
maintenance ordering, stricter lead transition) PLUS this continuation (the `domain/send` +
`integrations/send` modules, persistence repos/UoW, CLI `send-scheduled`, tests, docs, and
`.env.example`). Nothing is committed, tagged, or pushed; the exact proposed commit must be reviewed
and explicitly approved first.

## Local database note
The integration suite intentionally truncates the configured test database. It was truncated during
this work. No Phase 12/13 seed was restored; no real Gmail draft was called, read, mutated, or sent.

## Remaining tasks
- Review the complete Phase 14 diff and proposed commit contents.
- Commit/tag/push only after explicit operator approval.
- A live sending provider + full sending plan (jurisdiction, SPF/DKIM/DMARC, unsubscribe, bounce
  handling, volume ramp, reply detection, follow-ups) are deferred to a separate, approved step.

## Exact commands to continue
- Suite: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm test:integration` (needs `DATABASE_URL`).
- Migration: apply 0015, run `scripts/rollback/0015_controlled_sends_down.sql`, then reapply 0015.
- Dry-run readiness report (no writes/provider call): `pnpm cli send-scheduled --lead <id>` while
  `DRY_RUN=true` (the default).
- Warning: `pnpm test:integration` truncates the configured database.

## Safety restrictions
- `SENDING_ENABLED=false` and `SENDING_PROVIDER=mock` by default. The live provider is disabled.
- Even fully armed, a send additionally requires `OUTBOUND_ACTIONS_ENABLED=true`, `DRY_RUN=false`,
  a valid readiness approval, an intact schedule binding, and an explicit envelope confirmation.
- Phase 14 performs no live Gmail call, draft mutation, live schedule creation, or email send in
  this work; all sending flags remain false.
