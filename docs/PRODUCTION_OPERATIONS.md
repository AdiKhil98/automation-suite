# Production operations and recovery

Phase 16 defines the operator procedure before any controlled live smoke test. It does not authorize
live use. Keep `SENDING_ENABLED=false`, `OUTBOUND_ACTIONS_ENABLED=false`, `DRY_RUN=true`,
`SENDING_PROVIDER=mock`, and `GMAIL_SEND_PREFLIGHT_ENABLED=false` unless a separate approval explicitly
authorizes one bounded operation.

## Required order before a live smoke test

1. Confirm the working tree and deployed commit/tag, safe flag values, empty or explicitly reviewed local
   state, sender-domain legal/compliance readiness, and owner-only Gmail credential ACLs.
2. Restore or create exactly one reviewed lead only under separate data-restoration approval.
3. Run `pnpm cli -- send-scheduled --lead <internal-id>` while `DRY_RUN=true`. This is local-only and reports
   schedule timing, account cap, recipient/final approval status, fingerprints, database linkage, readiness,
   suppression matches, provider selection, flags, and the remaining external-verification requirement.
4. Under a separate Gmail-read approval, temporarily enable only `GMAIL_SEND_PREFLIGHT_ENABLED=true` and run
   `pnpm cli -- gmail-send-preflight --lead <internal-id>`. This command can call only `users.getProfile` and
   `drafts.get` for the persisted known draft ID. It has no send method and performs no database write.
5. Disable `GMAIL_SEND_PREFLIGHT_ENABLED` again. Review the redacted results. Creation of readiness, scheduling,
   flag enablement, and a live send each require the approvals stated below.

## Suppression and objections

- Add an email, domain/business, phone, or Place-ID suppression with `add-suppression`. The command requires
  operator identity, a reason, and exact interactive confirmation. Raw identity values are stored only in the
  suppression table; audit/status output uses a one-way hash.
- Inspect with `suppression-status`. Revoke only with `revoke-suppression`, an operational reason, operator
  identity, and exact interactive confirmation. Revocation history remains.
- An objection, complaint, verified hard bounce, or direct reply is handled manually: disable sending gates,
  revoke active readiness, cancel any active schedule, add every applicable suppression scope, and preserve the
  audit evidence. Do not monitor/search the inbox and do not automate replies or follow-ups.
- Suppression is re-evaluated during local eligibility, after human confirmation, after the second provider
  verification, and immediately before reservation. A newly added applicable suppression blocks execution.

## Credential-file permissions

- `gmail-credential-acl` inspects only the configured OAuth-client and OAuth-token files and reports only
  existence/owner-only status. It never reads or prints file contents.
- `gmail-credential-acl --fix --by <operator>` requires exact TTY confirmation before applying owner-only access
  (`0600` on POSIX; protected owner-only ACL on Windows). Inspect first, back up securely if policy requires it,
  and never run remediation during incident triage without explicit approval.

## Uncertain send and crash recovery

- A timeout, network loss, malformed success, 5xx, or crash after `CALL_STARTED` is not success and is never
  automatically retried. Keep the draft and original attempt unchanged as evidence.
- A persisted `CALL_STARTED` is converted only by `recover-started-send`, with exact TTY confirmation, operator
  identity, and a nonempty evidence note. The result is `OUTCOME_UNKNOWN`, the lead enters manual review, and
  retries remain blocked. The command never calls Gmail.
- Reconcile only through `reconcile-send-attempt`. Confirmed-sent and confirmed-not-sent both require independent
  evidence and exact confirmation. Unresolved keeps the attempt and lead blocked. Missing draft state alone is
  never proof of sending.
- **Never reverse a migration or restore an old database snapshot to resolve an uncertain send.** That can erase
  the durable reservation/attempt evidence and permit a duplicate. Schema rollback is maintenance only, after
  proving there are no reserved, started, uncertain, or live production records.

## Retention and deletion/anonymization

The configured policy windows are `RETENTION_LEAD_DAYS`, `RETENTION_PROVIDER_ID_DAYS`,
`RETENTION_READINESS_DAYS`, and `RETENTION_AUDIT_DAYS`. Defaults are conservative examples, not legal advice.

Retention execution is deliberately manual in Phase 16. Before deletion/anonymization: obtain jurisdictional
approval; export the required audit evidence; disable all outbound/readiness/preflight gates; verify no active
schedule or reserved/started/uncertain attempt references the record; and take a recoverable encrypted backup
under the approved retention policy. Then, in one reviewed database transaction, remove provider identifiers
when their shorter window expires, anonymize/delete lead contact facts when the lead window expires, expire or
remove readiness records when no attempt references them, and retain append-only audit/suppression evidence for
its configured window. Re-run referential-integrity and zero-live-state checks before commit. An objection or
valid erasure request overrides ordinary lead retention where law requires, but the minimum hashed suppression
and send-safety evidence should remain when legally permitted to prevent renewed contact.

## Separate approvals

Separate explicit approval is required for each of: real data restoration; real credential ACL remediation;
read-only Gmail preflight; OAuth reauthorization or scope change; DNS/domain changes; readiness creation; live
schedule creation; enabling `OUTBOUND_ACTIONS_ENABLED` or `SENDING_ENABLED`; changing `DRY_RUN=false`; selecting
`SENDING_PROVIDER=http`; and the one-draft live send confirmation. No approval implies another.
