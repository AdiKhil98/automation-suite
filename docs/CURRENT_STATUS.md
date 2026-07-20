# Current Status

## Current phase

Phase 15: production sending readiness and live Gmail provider integration. Implementation is complete,
uncommitted, and awaiting final review. No live Gmail call or send is authorized.

## Completed work

- Phases 0-14 are committed and tagged through `phase-14-sending` (`3d5e66c`).
- Phase 13 persists inert, deterministic, timezone-aware schedules only; it never schedules with Gmail.
- Phase 14 is the authoritative fail-closed safety controller for exactly one existing scheduled draft.
  It verifies immutable bindings twice, requires a valid expiring readiness approval and exact interactive
  confirmation, durably reserves the attempt, and permanently blocks automatic retry after uncertainty.
- Phase 14 does not claim provider-level exactly-once delivery because Gmail has no idempotency key for
  `drafts.send`.
- Migration `0015` and its reverse are committed. The verified Phase 14 suites passed before release.

## Phase 15 implementation

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
- No live Gmail call, OAuth reauthorization, real draft read or mutation, real schedule/seed/readiness
  restoration, or email send is permitted during implementation and tests.

## Remaining steps

1. Review the exact uncommitted diff and proposed commit contents; stop for explicit commit approval.
2. Controlled production smoke testing requires separate live approval.

## Verification

- Lint and typecheck pass.
- 390 unit, 43 PostgreSQL integration, and 9 browser tests pass.
- Migration `0016` apply/reverse/reapply passes.
- Final diff whitespace check and full sensitive-value/security scan pass with zero findings.
- Tests used mocked/local providers only. No live Gmail call, OAuth reauthorization, real draft read or
  mutation, live schedule/readiness record, or email send occurred.
- Local database has zero schedules, send attempts, Gmail-draft rows, and readiness approvals. One
  fictional integration-test lead remains; no real seed was restored.

## Out of scope

Inbox access or modification, contact discovery, draft create/update/delete/recreation, direct
`messages.send`, replacement MIME, bulk sending, automatic retry, reply detection, follow-up automation,
and Phase 16 work.
