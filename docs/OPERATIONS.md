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
