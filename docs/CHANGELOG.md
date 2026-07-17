# Changelog

All notable changes per phase. Format loosely follows Keep a Changelog.

## [phase-8b-ai-composer] — 2026-07-17

AI Demo Composer: the model emits a structured `DemoDesignSpec` (never markup); a deterministic
renderer assembles a page from a vetted component library. Built on the Phase 8 deterministic
foundation. Local-only, human-review-gated, no deploy.

### Added

- **Structured design contract** (`domain/demo/composer/design-spec.ts`, `composer-schema.ts`):
  closed allow-lists (7 section types × 2 vetted variants, 3 themes, hero strategy, messaging
  emphasis, CTA intent/label keys, fact keys). Strict Zod + JSON schema, no free-form markup.
- **Vetted component library + themes** (`components.ts`), **deterministic spec validation**
  (`spec-validation.ts`) and **renderer** (`compose.ts`): reuses Phase 8 sanitize/security/CSP/
  noindex/disclosure + relational provenance for every personalized value.
- **Gen + adversarial reviewer** (`demo-composer-service.ts`, prompts `demo-composer/`): pre-call
  worst-case budget projection, ≤2 calls, per-demo USD cap; mock provider default.
- **Diagnostics store** (`integrations/demo/composer-debug-store.ts`, git-ignored `.composer-debug/`):
  records every run's spec + reviewer verdict.
- **Persistence** migration `0009_demo_design_specs` (+reverse); `composer.repo`, composer UoW;
  reuses `model_calls` (nullable `audit_run_id`). CLI `compose-demos` (opt-in, paid hard-gated).
- **Playwright post-render validation** (`playwright-validate.ts`).

### Notes

- First paid smoke test rejected on an over-strict reviewer gate; fixed (reviewer sees component
  semantics; narrow `fabricationRisk`; gate rejects only on REJECT/fabrication/deterministic-fail,
  accepts deterministically-applicable REVISE). Re-run: APPROVE, demo composed, $0.0367. See D-0026.
- MVP simplification: no FS recovery envelope for composer paid calls (spec regen ≈$0.11, bounded).

## [phase-8-demo-generation] — 2026-07-16

Phase 7 (competitor research) deferred as an optional post-MVP module; Phase 8 is the demo
decision + local demo-site generation stage. Narrow, MVP, deterministic, local-only.

### Added

- **Deterministic demo decision** (`demo-decision.ts`): builds a demo when facts suffice AND
  (opportunity score ≥ `MIN_OPPORTUNITY_FOR_DEMO` OR ≥1 accepted outreach-safe finding in a
  demonstrable category) — a useful demo is not rejected for a low score alone (the Gate A
  lead scored 10). Per-run cap `MAX_BRANDED_DEMOS_PER_RUN`.
- **Demo brief** from approved Phase 6 findings → template directives, with relational provenance.
- **No fake functionality** (`demo-content.ts`): CTA never implies online booking without a
  verified booking URL — booking URL → "Book an appointment"; contact page → "Contact us";
  phone → `tel:`; otherwise scroll to the local contact section. No forms; unknown info omits
  the section (no fabricated services/hours/testimonials/ratings/staff/awards/prices/claims).
- **Output security** (`sanitize.ts`, `demo-validation.ts`): every fact HTML-escaped; URLs
  allow-listed to http(s)/tel/mailto (javascript:/data: rejected); path-traversal-safe output
  dirs; generated pages carry a restrictive CSP, `noindex,nofollow,noarchive`, and have no
  scripts/forms/cookies/trackers/external resources. XSS + malicious-fact fixtures in tests.
- One polished **original dental template** (`template.ts`) — self-contained inline CSS, text-
  based business-name treatment, generic visuals only; no scraped logos/photos, no competitor
  assets, no cloning.
- **Relational provenance** (amendment 4): `demo_fact_inputs` (→ lead_facts) and
  `demo_finding_inputs` (→ audit_findings) FK tables — authoritative, not JSON-only.
- **Generation ≠ approval** (amendment 5): demo statuses GENERATED_PENDING_REVIEW / APPROVED /
  REJECTED / SUPERSEDED / BUILD_FAILED; approval metadata columns (approved_at/by/source/notes)
  reserved for a later human-review phase. `DEMO_READY` = generated + validated, pending review.
  Nothing is published.
- 4 tables (demo_decisions, demos, demo_fact_inputs, demo_finding_inputs), migration `0007` +
  reverse script; `netlify.toml` with an `X-Robots-Tag` noindex header prepared for Phase 11.
- CLI: `generate-demos --campaign [--limit]`, `preview-demo --lead` (serves on loopback only,
  never public). New env: `DEMO_GENERATION_ENABLED`, `MIN_OPPORTUNITY_FOR_DEMO`, `DEMO_OUTPUT_DIR`,
  `DEMO_PREVIEW_PORT`.
- Tests: 23 demo unit (decision/brief/CTA/sanitize/provenance/template/XSS), 3 PostgreSQL
  integration (persistence + relational provenance + routing), 3 Playwright browser (desktop +
  mobile render, no overflow, CTA + destination rules, no external requests, disclosure, noindex,
  malicious-fact injection blocked). Totals: 246 unit + 26 integration + 5 browser.

### Decisions

- D-0025 demo generation (deterministic, no fake functionality, output sanitization, relational
  provenance, generation-vs-approval separation, local-only, own template).

### Not in scope

- No competitor research (Phase 7 deferred), no Netlify deploy (Phase 11), no email/dashboard/
  Gmail/scheduling/sending, no AI copy (deterministic only), no GitHub repo creation.

## [phase-6-ai-audit] — 2026-07-16

### Added

- AI website audit & opportunity analysis (first LLM phase). Provider-agnostic `LlmProvider` port;
  `MockLlmProvider` default (zero paid calls in tests/CI); `OpenAiResponsesProvider` on the OpenAI Responses
  API (openai@6.46.0 pinned; `text.format` json_schema strict, `reasoning.context='current_turn'`,
  `store:false`, no tools, no `previous_response_id`; contract in docs/integrations/openai-responses.md, D-0018).
- Two independent bounded calls per lead: generator + **adversarial reviewer** (minimized reviewer package of
  only referenced evidence). Max 2 attempts each, ≤4 calls/lead; per-lead + per-run call and cost caps;
  repair-hint retries for schema/validation failures (D-0020).
- Deterministic acceptance in code: evidence-ID membership, canonical-URL checks, forbidden-claim/
  placeholder/prompt-leak denylists, reviewer-ref mapping, ≤5 findings (≤3 outreach-safe). Model uses
  temporary `findingRef` ("F1"); code generates DB UUIDs (D-0019).
- Deterministic opportunity scoring (`opp-rules-1`): severity/confidence/category/profile multipliers,
  same-category dedup, per-finding cap, dimension scores (conversion/mobile/trust/contactability) + capped
  overall; per-finding breakdown rows + rules hash persisted for full explainability.
- 12-outcome audit taxonomy with exact lead routing (AUDITED → OPPORTUNITY_READY; transient/budget stay
  READY_FOR_AUDIT; the rest → NEEDS_MANUAL_REVIEW).
- Paid-result recovery envelopes (`.audit-tmp/`, atomic rename, mode 0600, git-ignored) written before the
  persistence transaction; `resume-audit` + automatic startup scan replay idempotently, never re-calling the
  model (D-0021).
- Prompt-injection-hardened prompts (website text = untrusted data; versions `audit-rubric-1`,
  `audit-generator-1`, `audit-reviewer-1`); prompt-cache keys partitioned by task|model|prompt|rubric|schema,
  never lead-specific.
- Evaluation harness (Gate B): 16 fixture cases incl. 4 prompt-injection attacks; deterministic graders;
  generator×reviewer matrix runner; JSON reports under `eval-reports/`.
- 8 tables: audit_runs, audit_findings, audit_finding_evidence, audit_reviews, audit_review_findings,
  opportunity_assessments, model_calls, prompt_versions (CHECK constraints). Migration `0005_audit.sql` +
  reverse script `scripts/rollback/0005_audit_down.sql`.
- CLI: `audit-websites --campaign [--limit]`, `resume-audit`, `eval-audit`. New env: `ALLOW_PAID_LLM_CALLS`
  (separate paid-LLM kill switch), `LLM_*` model/effort/image-detail/cache/timeouts, `MAX_LLM_*` budgets,
  `AUDIT_ENVELOPE_DIR`.
- Tests: 61 new unit (scoring, validation, evidence package, call-state machine incl. budget/refusal/envelope
  paths, eval harness, prompt hardening) + 3 PostgreSQL integration (full persistence + routing, failure
  accounting, envelope replay idempotency). Totals: 179 unit + 23 integration.

### Gate A preparation (2026-07-15)

- Pricing reconciled with official OpenAI pricing (`PRICE_TABLE_VERSION='llm-prices-2'`,
  `PRICE_VERIFIED_AT='2026-07-15'`): tiered short/long-context rates for `gpt-5.6-sol`; other models blocked
  until verified. Context tier derived per call from reported input tokens; undeterminable tier → null cost →
  hard block (D-0018 pricing section).
- Per-lead cost cap upgraded to a **pre-call worst-case projection** (D-0023): a call is refused unless its
  worst-case completion still fits the cap, making `spend ≤ cap` a structural invariant (worst-case Gate A
  spend proven ≤ $0.50; single-call ceiling $0.419). Prompt caching defaulted OFF for Gate A.
- Hardened capture container **built and verified** (was documented-only in Phase 5): `.dockerignore` (keeps
  secrets/node_modules out), `deploy/seccomp/chromium.json` (Playwright v1.61.1 profile),
  `deploy/verify-container.sh` (15/15 OS-hardening checks pass: non-root, cap-drop ALL, no-new-privileges,
  seccomp filter, read-only fs, tmpfs, pids/mem/cpu limits, init), `deploy/egress-firewall.sh` +
  `deploy/verify-capture.mjs` (Chromium renders under full hardening; egress blocks metadata/RFC1918/host-non-DB,
  allows public 443).
- **Security fix:** the capture provider silently ran `--no-sandbox` (Playwright defaults `chromiumSandbox` off).
  Now explicit + configurable (`CAPTURE_CHROMIUM_SANDBOX`, default on; off in the max-hardened container where
  the in-process sandbox cannot initialize) — see D-0022.

### Gate A — PASSED (2026-07-16)

- Live single-lead smoke test on a real website (Zahnärzte am Ufer, Berlin) captured in the hardened container:
  generator → one deterministic repair (first pass cited out-of-package evidence) → independent reviewer →
  `AUDITED`. Reviewer rejected an over-reaching accessibility claim. 2 outreach-safe findings, opportunity
  score 10. 3 calls, $0.221. Surfaced + fixed a real defect (adapter's hardcoded 60s timeout → wired
  `LLM_TIMEOUT_MS`; SDK `maxRetries` made explicit, 0). Added validation-debug envelopes
  (`.audit-debug/`, 0600, git-ignored, archive-on-success) + `model_calls.validation_violations` (migration
  0006) so failed paid calls stay diagnosable; `clean-audit-debug` command.

### Gate B — DEFERRED (D-0024)

- The 4-config × 6-case model eval matrix is deferred until the pipeline is end-to-end functional (a first run
  was degraded by transient network errors; $0.1545 spent, unreliable). Production model config is the
  PROVISIONAL **gpt-5.6-sol / medium** baseline (proven at Gate A). Eval tooling retained: dollar guard
  (`MAX_EVAL_COST_USD`/`MAX_EVAL_CALLS`, per-call worst-case projection + token recording), 6 fixtures incl. 3
  with real screenshots, `--cases` filter, verified Terra pricing (`llm-prices-3`). Prompt caching stays off.

## [phase-5-website-capture] — 2026-07-11

### Added

- Website capture with Playwright 1.61.1 (mock provider by default; no LLM). Interfaces:
  `BrowserCaptureProvider`, `CaptureStorageProvider`, `PageSelectionPolicy`, `CaptureEvidenceExtractor`.
- Two capture purposes: `AUDIT_CAPTURE` (verified official facts → CAPTURED → READY_FOR_AUDIT) and
  `VERIFICATION_CAPTURE` (re-render a Phase-4 BROWSER_REQUIRED candidate, re-run the deterministic verifier;
  only a verified association writes facts — never audit-ready by rendering alone).
- New lead states `READY_FOR_CAPTURE`, `CAPTURED`. Nine-outcome taxonomy with exact state routing;
  lead-level FAILED reserved for internal errors.
- Separate isolated desktop (1440×900) / mobile (390×844) contexts with distinct emulation profiles + version;
  no shared cookies/storage/service-workers. Completeness fields (desktop/mobile primary complete, secondary
  attempted/completed, partial reason).
- Hardened browser runtime: `serviceWorkers:'block'`, permissions/downloads denied, dialogs dismissed, popups
  closed, page-script WebSocket/WebRTC neutralized; request-interception SSRF guard (IPv4/IPv6 incl. mapped +
  metadata + multicast + numeric forms); PSL-aware `VerifiedOriginPolicy` (tldts) refusing cross-domain
  main-frame changes. Hardened container reference in `deploy/` + docs/deploy/hardened-browser.md (D-0017).
- Content-addressed screenshot storage (temp → commit/discard, dedup, reference-safe GC); no full HTML — bounded
  evidence + structured signals + screenshots + raw-DOM hash + normalized (volatile-stripped) evidence
  fingerprint (D-0016). Versioned append-only capture runs.
- Per-lead atomic transaction; browser/network outside the tx; artifact temp cleaned on rollback.
- 5 tables (website_capture_runs, captured_pages, capture_artifacts, capture_evidence, capture_errors) with
  CHECK constraints. Migration `0004` + reverse script `scripts/rollback/0004_capture_down.sql`.
- CLI `capture-websites --campaign [--purpose audit|verification]`. New `CAPTURE_*` config. Dependencies:
  `playwright@1.61.1` (pinned, D-0015), `tldts`.
- Tests: unit (verified-origin PSL, request-guard SSRF, audit-decision, page-selection, evidence + fingerprints,
  content-addressed storage GC/dedup); PostgreSQL integration (outcome routing, transactional rollback +
  artifact cleanup, VERIFICATION path); **real Playwright browser suite `pnpm test:browser`** against local
  fixtures (desktop/mobile, JS rendering, redirect, tracker block, console errors, mobile overflow). 118 unit +
  20 integration + 2 browser.

### Decisions

- D-0015 Playwright 1.61.1 pin + install strategy; D-0016 no full-HTML retention; D-0017 hardened container as
  the browser SSRF boundary.

### Notes

- Standard suite: zero external network, zero real browser, no API key. Client-rendered shells → BROWSER_REQUIRED
  routing; a browser-required lead is only audit-ready after independent official-site verification.

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
