# Changelog

All notable changes per phase. Format loosely follows Keep a Changelog.

## [phase-2-lead-collection] — 2026-07-11

### Added

- Deterministic dedup engine (`src/domain/leads/dedup.ts`): address-anchored precedence
  (Place ID → domain+addr → phone+addr → name+addr → branch → ambiguous → unique); name never merges alone.
- Normalization for phone (national significant number) + address + haversine proximity; configurable
  near-address threshold (`DEDUP_NEAR_ADDRESS_METERS`, default 40 m).
- Lead facts made nullable + provenance (`facts_source`/`facts_source_url`/`facts_captured_at`), `dedup_status`,
  `duplicate_of`; lead factory (`buildLeadFromFacts` / `buildCandidateLead`).
- Source model: `source_entities` (stable provider+Place ID identity, idempotency anchor), `source_requests`
  (one row per API request/page; cost accounted here), `source_observations` (one per candidate; refs entity
  + request). Migration `0001`.
- Provider abstraction: `LeadSourceProvider`; `MockLeadSource` (default, full facts) and `GooglePlacesProvider`
  (Places API New, **ID-only field mask** `places.id,nextPageToken`, pagination, rate limit, timeout, retries).
- Collection pipeline (`collect-leads`): per-candidate transactions, idempotent reruns, ambiguous flagging
  (no merge), caps, conservative restart (rerun from page 1), rejection of malformed records.
- HTTP (timeout/retry/backoff), rate limiter, geo utilities. `collect-leads` CLI command.
- Compliance: **no Google Places content persisted** (Place ID only; content in-memory only). Docs in
  SECURITY, DECISIONS (D-0007/D-0008) and docs/integrations/google-places.md.
- Tests: unit (normalize, dedup matrix, pipeline with in-memory fakes) + **PostgreSQL integration**
  (source uniqueness, idempotent rerun, append-only observation history, ambiguous matching, transaction
  rollback). CI now runs the integration suite against a Postgres service.

### Decisions

- D-0007 Places API (New) + ID-only discovery mask. D-0008 no storage of Google Places content.

### Notes

- No AI, qualification, audit, demos or emails. Mock default; Google requires flag + key + DRY_RUN=false.

## [phase-1-foundation] — 2026-07-11

### Added

- TypeScript (strict) project: `package.json`, `tsconfig.json` + `tsconfig.build.json` (NodeNext ESM),
  ESLint (flat config, `no-explicit-any`), Prettier, Vitest, `.nvmrc`.
- Environment validation (`src/config/env.ts`) via Zod — default-safe (`DRY_RUN=true`,
  `OUTBOUND_ACTIONS_ENABLED=false`), typed cost/rate limits, explicit boolean parsing.
- Structured logging (`src/utils/logger.ts`, Pino) with secret redaction; typed errors (`src/utils/errors.ts`).
- Global outbound kill-switch guard (`src/utils/outbound.ts`).
- Domain: lead status list, validated **state machine** (allowed-transition map + `assertTransition`), lead +
  evidence + pipeline-run + pipeline-event schemas, and a `model_call` record type (table deferred to Phase 5).
- `LeadService` with injectable ports (`LeadStore`, `EventRecorder`): create + transition, always audited;
  invalid transitions recorded and rejected.
- Persistence: Drizzle schema (`leads`, `evidence`, `pipeline_runs`, `pipeline_events`), pg-backed client,
  migration runner, repositories, and a guarded `truncateAll` for local resets.
- CLI (Commander): `create-sample-leads`, `list-leads`, `lead-state <id>`, `reset-test-data`.
- Local Postgres via `docker-compose.yml` (postgres:16-alpine); initial migration `migrations/0000_*`.
- Unit tests: state machine, env validation, lead/evidence schemas, outbound guard, lead-service (with fakes).
- GitHub Actions CI (`.github/workflows/ci.yml`): Node 24 via `.nvmrc`, pnpm, `pnpm check`, migrate, build.

### Decisions

- D-0006 Node 24 (Krypton) Active LTS pinned across local/engines/.nvmrc/CI. D-0004 pnpm resolved.

### Notes

- No external APIs, AI, demos, or emails. Dry-run + kill switch default-safe.

## [phase-0-specification] — 2026-07-11

### Added

- Repository initialized (git, `main` branch).
- Repository operating contract: `CLAUDE.md`.
- Documentation set: `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `DECISIONS.md`, `ASSUMPTIONS.md`,
  `RISK_REGISTER.md`, `OPERATIONS.md`, `SECURITY.md`, `EVALUATION.md`, `CHANGELOG.md`.
- `README.md`, `.gitignore`, `.env.example` (scaffolding only — no implementation code).
- Domain model, lead state machine, `LlmProvider` provider boundary, and agent output contracts defined.
- Decisions recorded: Drizzle ORM (D-0001), Docker Desktop/WSL2 for local Postgres (D-0002), repo root
  `automation-suite/` (D-0003), pnpm via Corepack (D-0004), LLM provider deferred behind abstraction (D-0005).
- Risk register and assumptions log seeded.

### Notes

- No production implementation code, no dependencies installed, no external accounts, no paid API calls.
- Docker Desktop (WSL 2) install is a prerequisite for Phase 1 and is deliberately deferred.
