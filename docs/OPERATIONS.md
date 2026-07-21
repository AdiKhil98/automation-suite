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

## Operational vs. integration-test databases

`DATABASE_URL` is the Supabase production database connection. It must never be used by integration tests or
destructive reset tooling. Production migrations use only the explicit `pnpm db:migrate` command against
`DATABASE_URL` after separate operator approval.

`TEST_DATABASE_URL` is a separate local PostgreSQL connection for integration tests and `reset-test-data` only.
Destructive test actions require all of: `NODE_ENV=test`,
`ALLOW_TEST_DATABASE_DESTRUCTIVE_ACTIONS=true`, a loopback host (`localhost`, `127.0.0.1`, or `::1`), and a
clearly test-only database name such as `outreach_test`. There is no fallback to `DATABASE_URL`; Supabase,
session poolers, and remote hosts are rejected before a connection opens.

Never run `pnpm test:integration` or `pnpm cli reset-test-data` against Supabase. Keep the operational and local
test connections separate.

## Collection & qualification commands (Phase 2 / Phase 3)

```text
# Phase 2 — collect + deduplicate (mock by default; Google Places behind a flag)
pnpm cli collect-leads --campaign dental-manchester-test
pnpm cli collect-leads --campaign dental-manchester-test --dry-run --limit 25

# Bounded production prospecting (disabled unless PROSPECT_DISCOVERY_ENABLED=true and ALLOW_PAID_READS=true)
pnpm cli prospect-run --niche dentists --location "Berlin, Germany" --radius-km 10 --target-qualified 1 --max-candidates 5 --rank POPULARITY
# Explicit coordinates bypass the one-request location resolver
pnpm cli prospect-run --niche dentists --location "Berlin, Germany" --latitude 52.52 --longitude 13.405 --radius-km 10

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

# Phase 6 — AI website audit of READY_FOR_AUDIT leads (mock by default; paid hard-gated)
pnpm cli audit-websites --campaign dental-manchester-test [--limit N]
pnpm cli resume-audit                                     # replay recovery envelopes (never calls the model)
pnpm cli eval-audit [--models a,b] [--reviewers c] [--max-calls N] [--out dir]

# Phase 8 — local concept-demo generation for OPPORTUNITY_READY leads (deterministic, no deploy)
pnpm cli generate-demos --campaign dental-manchester-test [--limit N]
pnpm cli preview-demo --lead <lead-id>   # serves the demo on http://127.0.0.1:<port>/ (loopback only)
```

`prospect-run` never accepts arbitrary Google types, never requests more than one Nearby page, and uses an
ID-only discovery field mask. `--continue-pipeline` additionally requires `PROSPECT_CONTINUE_PIPELINE=true`,
passes only the first qualified lead into exact-lead existing stages, and stops before deployment, Gmail,
scheduling, or sending. It does not change flags itself.

Demos are written to `./demos/<leadId>/` (git-ignored), marked `GENERATED_PENDING_REVIEW`, and are
never published in Phase 8 — a later phase handles human approval + Netlify deployment.

Standard tests use the mock capture provider (no browser). The **real** browser suite runs against local
fixtures: install Chromium once (`npx playwright install chromium`), then `pnpm test:browser`. For production
captures of real prospect sites, use the hardened container — see
[deploy/hardened-browser.md](deploy/hardened-browser.md). Screenshots are private artifacts under
`.artifacts/` (git-ignored); a GC removes unreferenced blobs.

Enrichment is mock + deterministic by default (no network in tests). The optional Google context provider is
disabled unless `ENRICHMENT_CONTEXT_PROVIDER=google` and `ALLOW_PAID_READS=true` with a key — see
[integrations/google-places-details.md](integrations/google-places-details.md).

## Phase 6 paid gates (Gate A / Gate B)

Real OpenAI calls are OFF by default and can never happen from tests or CI. Both gates require an explicit
operator approval in chat before running.

**Prerequisites (both gates)** — the CLI refuses (before touching any lead) unless ALL hold:

1. `LLM_PROVIDER=openai`, `OPENAI_API_KEY` set, `ALLOW_PAID_LLM_CALLS=true`.
2. `src/integrations/llm/pricing.ts` reconciled with official OpenAI pricing (`PRICE_VERIFIED_AT` set); every
   requested model must have a verified price row.
3. `LLM_MODEL_AUDIT` set (baseline: `gpt-5.6-sol`).

**Gate A — single-lead smoke test.** One real lead end-to-end with strict budgets
(`MAX_LLM_CALLS_PER_RUN=4`, `MAX_LLM_CALLS_PER_LEAD=4`, `MAX_LLM_COST_USD_PER_LEAD=0.50`):

```text
pnpm cli audit-websites --campaign <campaign> --limit 1
pnpm cli lead-state <lead-id>     # verify outcome, findings, score, model_calls rows
```

Review persisted findings/review/score/costs before approving any batch use. If the DB write failed after paid
calls: `pnpm cli resume-audit` (free, idempotent).

**Gate B — model eval matrix.** Runs the 16-case fixture dataset (incl. prompt-injection attacks) across
generator×reviewer combos with deterministic graders; used to pick the production model pairing:

```text
pnpm cli eval-audit --models gpt-5.6-sol,gpt-5.6-luna --reviewers gpt-5.6-sol --max-calls 96
```

Reports land in `eval-reports/` (git-ignored). Grader failures are per-case and reproducible. The commit + tag
for Phase 6 happen only after these gates are completed and approved.

Recovery envelopes live in `.audit-tmp/` (git-ignored, restrictive perms). `audit-websites` scans and replays
them automatically at startup and stops if any replay fails.

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

Phase 6:

```text
psql "$DATABASE_URL" -f scripts/rollback/0005_audit_down.sql
git reset --hard phase-5-website-capture
rm -rf .audit-tmp eval-reports
```

Phase 8:

```text
psql "$DATABASE_URL" -f scripts/rollback/0007_demo_down.sql
git reset --hard phase-6-ai-audit
rm -rf demos
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
