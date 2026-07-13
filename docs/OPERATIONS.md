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

## Collection & qualification commands (Phase 2 / Phase 3)

```text
# Phase 2 — collect + deduplicate (mock by default; Google Places behind a flag)
pnpm cli collect-leads --campaign dental-manchester-test
pnpm cli collect-leads --campaign dental-manchester-test --dry-run --limit 25

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
```

Standard tests use the mock capture provider (no browser). The **real** browser suite runs against local
fixtures: install Chromium once (`npx playwright install chromium`), then `pnpm test:browser`. For production
captures of real prospect sites, use the hardened container — see
[deploy/hardened-browser.md](deploy/hardened-browser.md). Screenshots are private artifacts under
`.artifacts/` (git-ignored); a GC removes unreferenced blobs.

Enrichment is mock + deterministic by default (no network in tests). The optional Google context provider is
disabled unless `ENRICHMENT_CONTEXT_PROVIDER=google` and `ALLOW_PAID_READS=true` with a key — see
[integrations/google-places-details.md](integrations/google-places-details.md).

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
