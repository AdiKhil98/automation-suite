# Changelog

All notable changes per phase. Format loosely follows Keep a Changelog.

## [phase-4-enrichment] — 2026-07-11

### Added

- Independent enrichment & website discovery: `EnrichmentContextProvider → CandidateProvider →
  WebsiteVerifier → verified facts`. Context providers: facts (default), manual, mock, and optional Google
  (Place Details by Place ID, **in-memory only**, gated by `ALLOW_PAID_READS`, capped + cost-logged).
  Candidate providers: mock, manual (production-usable, no Google/paid API), search interface reserved.
- Deterministic verification (no LLM): strict acceptance (≥1 strong signal — exact phone, name+address,
  branch-location, structured data, legal footer; name tokens alone never verify), directory/social denylist,
  bounded same-origin crawl (≤5 pages), cheerio extraction. Separate facts `official_domain` /
  `official_website_url` / `official_location_page_url` (branches share a domain).
- Nine-outcome taxonomy with exact lead-state routing; lead-level `FAILED` reserved for internal errors.
- SSRF-hardened HTTP (`utils/safe-fetch.ts`, `utils/ip-guard.ts`): manual redirects, per-hop scheme/
  credential/IP validation (private/reserved v4+v6, IPv4-mapped, metadata, multicast, numeric forms),
  connect-time DNS re-validation, redirect/byte/time caps, HTML-only.
- Per-fact provenance conflict rules (website > manual > mock; manual conflicts preserved + routed to review;
  unchanged facts attach evidence without churn). Structured `enrichment_signals` evidence (no full HTML).
- New tables `enrichment_attempts` / `enrichment_candidates` / `enrichment_signals` with CHECK constraints
  (outcome/decision/signal/discovery-source enums, confidence 0..1, `chosen_*` only when VERIFIED, run_id
  non-null); expanded `lead_facts` fact-type CHECK. Migration `0003` + reverse script
  `scripts/rollback/0003_enrichment_down.sql`.
- Per-lead atomic transaction (attempt + candidates + signals + facts + projection + state + event).
- CLI: `enrich-leads --campaign` (batch) and `enrich-lead --lead/--candidate | --csv` (manual). New config
  (`ENRICHMENT_*`, `ALLOW_PAID_READS`, Google caps). Dependency: cheerio (D-0012).
- Tests: unit for ip-guard SSRF matrix, safe-fetch URL validation, extraction, verification, fact-conflict;
  PostgreSQL integration for the full outcome taxonomy, manual/website conflict, transactional rollback, and
  **no provider-restricted context persisted**. 92 unit + 16 integration.

### Decisions

- D-0012 cheerio; D-0013 deterministic enrichment + SSRF hardening; D-0014 Google context in-memory + paid-
  reads separated from outbound.

### Notes

- Zero paid API calls / real network in the standard suite; no key required for install/CI/tests. Google
  context is disabled unless explicitly enabled. Client-rendered sites defer to Phase 5 (`BROWSER_REQUIRED`).

## [phase-3-qualification] — 2026-07-11

### Added

- Deterministic **PRE_AUDIT** qualification (`src/domain/qualification/*`): no AI. `ACCEPT` = worth
  enriching/auditing, not outreach-ready. Four scores (business_viability, auditability, contactability,
  opportunity[null]); composite = 0.6·viability + 0.4·auditability; accept ≥ 55.
- Rejection gates fire only on confident, verified conditions (suppressed, permanently closed, outside niche,
  verified chain via `ownership_type`). Name match only flags a possible chain — never proves/rejects.
- Versioned rules (`q-2026.07.1`) hashed into every result (`rules_config_hash`); `input_fingerprint` from
  canonical rule+fact inputs (timestamps/ids excluded).
- **Per-fact provenance**: `lead_facts` table (type/value/normalized/source/url/captured_at/confidence/
  supersession/is_current) with a partial unique index (one current fact per lead+type). `leads.*` fact
  columns become a derived projection; legacy `facts_source*` deprecated (kept + backfilled, dropped later).
  Phase 2 collection retrofitted to emit `lead_facts`.
- `qualification_results` (append-only) + `qualification_result_facts` join (authoritative fact linkage);
  `suppression_list`. DB CHECK constraints on scores/enums/confidence. Migration `0002`.
- Lead states `READY_FOR_ENRICHMENT` + `ENRICHED`; phone-only/Place-ID-only leads route to
  `READY_FOR_ENRICHMENT` (WEBSITE_DISCOVERY / NEEDS_ENRICHMENT).
- `qualify-leads` CLI command; `QualificationService` + `qualifyLeads` pipeline.
- The complete qualification write (result + fact links + lead state + state-transition event) runs in ONE
  PostgreSQL transaction (`DrizzleQualificationUnitOfWork`); any failure rolls the whole thing back.
- Tests: +12 unit (`qualify`), PG integration (append-only history, state transitions, enrichment routing,
  suppression, partial-unique enforcement, competing current-fact updates, and full rollback when the state
  transition fails after the result insert). `test:integration` runs serially (`--no-file-parallelism`).

### Decisions

- D-0009 deterministic PRE_AUDIT multi-score; D-0010 per-fact provenance (`lead_facts`); D-0011 new
  enrichment phase (roadmap renumbered 4→14).

### Notes

- No AI, capture, enrichment, demos or emails implemented. Website quality/opportunity deferred to Phase 6.

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
