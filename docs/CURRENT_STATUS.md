# Current Status

## Current phase
Phase 12 (Gmail draft creation) — COMPLETE + live-verified. UNCOMMITTED; awaiting operator review and commit approval.

## Completed work
- Phases 0–11 tagged (`phase-11-netlify-previews`) + dashboard pool-lifecycle fix (`b938ed4`).
- Phase 12 (uncommitted): OAuth (gmail.compose only) + git-ignored 0600 token store + `gmail-auth` CLI;
  Gmail provider (interface + mock + http, drafts.create only, token never logged); domain
  (eligibility, sender-name substitution + no-unresolved-token guard, MIME/base64url, GmailDraftService
  with idempotency + dup prevention + routing); migration 0013 (gmail_drafts, unique on account+fingerprint
  and provider draft id, +reverse); repos/UoW/input; CLI `create-gmail-drafts`; state HUMAN_APPROVED→
  DRAFT_CREATED / NEEDS_MANUAL_REVIEW. Mock-first; no Gmail calls in tests.
- Live smoke test: exactly one Gmail draft created for one approved lead, confirmed through a read-only
  draft lookup, and left unsent. Lead advanced to `DRAFT_CREATED`; the unique fingerprint record exists;
  `GMAIL_DRAFTS_ENABLED=false` again. Private recipient and Gmail identifiers are intentionally omitted.

## Uncommitted changes
All Phase 12 files. NOT committed/tagged; proposed commit must be reviewed and explicitly approved first.

## Remaining tasks
- Review the proposed Phase 12 commit contents; commit/tag only after explicit operator approval.
- Phase 13/14 not started.

## Exact commands to continue
- Suite: `pnpm lint && pnpm typecheck && pnpm test` ; `DATABASE_URL=… pnpm test:integration` ; `pnpm test:browser`
- `pnpm test:integration` truncates the DB.

## Safety restrictions
- `GMAIL_DRAFTS_ENABLED=false` and `OUTBOUND_ACTIONS_ENABLED=false` default. Both must be true for a real draft.
- Only users.drafts.create — never send, no inbox read/modify, no scheduling, no contact discovery.
- Refresh token only in git-ignored 0600 `.gmail-credentials.json` — never in env/DB/logs/git.
- Do NOT begin Phase 13/14.
