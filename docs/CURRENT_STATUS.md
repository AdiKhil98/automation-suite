# Current Status

## Current phase
Phase 11 (Netlify preview deployment) — COMPLETE + live-verified. Committing as `phase-11-netlify-previews`.

## Completed work
- Phases 0–10 tagged. Phase 11: Netlify draft deploy + URL verification + immutable email
  finalization + second human approval (FINALIZED_EMAIL_PENDING). Live smoke: 1 draft deploy
  `6a5bef3b…`, verified, production untouched. See CHANGELOG + D-0028.

## Uncommitted changes
None after this commit.

## Remaining tasks
- Second human approval of the finalized email for the smoke-test lead (decideFinalizedEmail) → HUMAN_APPROVED, when desired.
- Phase 12 (Gmail draft creation, no send) — not started.

## Exact commands to continue
- Suite: `pnpm lint && pnpm typecheck && pnpm test` ; `DATABASE_URL=postgres://postgres:postgres@localhost:5432/outreach pnpm test:integration` ; `pnpm test:browser`
- Deploy (ARMED only): `pnpm cli deploy-demos --limit 1` (idempotent — reconciles/reuses; never double-deploys).
- `pnpm test:integration` truncates the DB.

## Safety restrictions
- `.env` currently ARMED for Netlify (deployment enabled + token/site/hostname). Disarm when done: NETLIFY_DEPLOYMENT_ENABLED=false.
- Draft deploys only (never production). Preview URLs are PUBLIC; noindex/X-Robots-Tag = search guidance, not access control. No send, no Gmail, no scheduling.
- Do NOT begin Phase 12 without approval.
