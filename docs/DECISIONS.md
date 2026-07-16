# Decision Log

Every significant decision is recorded here in the required format. Newest first.

---

## D-0024 — Gate B deferred; provisional gpt-5.6-sol/medium baseline

- **Date:** 2026-07-16
- **Problem:** Choosing the production generator/reviewer model + effort ideally comes
  from the Gate B eval matrix, but a full 4-config × 6-case run before the pipeline is
  end-to-end functional spends money on synthetic fixtures with little real audit data
  to validate against. (A first Gate B attempt was additionally degraded by transient
  network connection errors — only the Sol/Sol config partially completed, $0.1545 —
  producing unreliable data.)
- **Chosen option:** Defer Gate B as a post-functional optimization task. Adopt a
  PROVISIONAL production baseline of **gpt-5.6-sol / medium** for both generator and
  reviewer — the exact configuration proven end-to-end at Gate A on a real website.
  Keep all cost guards, the eval runner, the `eval-audit` command, the dollar/call
  budgets, and the 6 fixtures (incl. the 3 multimodal ones) intact for later use.
- **Reason:** Gate A already proved Phase 6 works on a real site; model *optimization*
  is worth more once there is real audit volume to evaluate against. Provisional ≠
  final: the config is documented as such.
- **Tradeoffs:** We run on possibly-not-cost-optimal models until Gate B is completed;
  Terra (≈half the cost) remains unvalidated for quality.
- **Rollback path:** Config only (`.env` model/effort); no schema or code change.
- **Status:** Accepted (Phase 6, approved 2026-07-16). The 2026-07-16 Gate B run is marked
  **INVALID_FOR_MODEL_SELECTION** (network-degraded); cost/diagnostics preserved, quality metrics not used.
  Gate B + follow-up monitoring recorded as deferred tasks in ROADMAP.

---

## D-0023 — Per-lead LLM cost cap enforced by pre-call worst-case projection

- **Date:** 2026-07-15
- **Problem:** A cost cap checked as "spend-so-far < cap" allows one call to overshoot,
  so configured token limits alone did not bound Gate A spend to ≤$0.50 (4 calls near
  their ceiling ≈ $0.84).
- **Chosen option:** Before each real-provider call, project its worst-case completion
  cost from the configured limits (evidence items × per-item tokens + proposed findings
  + images + `max_output_tokens`, priced at the resolved tier) and refuse the call
  unless `spend_so_far + worst_case ≤ cap`. Invariant: `spend_so_far ≤ cap` always
  holds, so final spend can never exceed the cap regardless of call count. A null
  projection (unknown price / undeterminable context tier) blocks the call.
- **Reason:** Makes the budget a structural guarantee provable from config, not a
  post-hoc overshoot; satisfies "prove the configured limits cannot exceed the cap."
- **Tradeoffs:** Conservative token bounds may block a later call in a pathological
  high-token lead (fails closed — correct for a spend guard). Mock provider is exempt
  (zero cost).
- **Rollback path:** Guard is contained in audit-service + token-budget.ts.
- **Status:** Accepted (Phase 6).

---

## D-0022 — Container is the browser boundary; in-process Chromium sandbox is optional

- **Date:** 2026-07-15
- **Problem:** Building/verifying the hardened capture container revealed that Chromium's
  in-process sandbox cannot initialize under `--cap-drop ALL` + `no-new-privileges`
  (setuid sandbox needs privilege escalation; namespace sandbox also fails) — and that
  the app silently ran `--no-sandbox` because Playwright defaults `chromiumSandbox` to
  false, contradicting the Phase-5 doc.
- **Chosen option:** Keep the strong container as the authoritative boundary (D-0017):
  non-root, cap-drop ALL, no-new-privileges, default-deny seccomp, read-only fs,
  resource limits, network egress firewall. Make the in-process sandbox an explicit,
  configurable defense-in-depth layer (`CAPTURE_CHROMIUM_SANDBOX`, default on; set OFF
  in the max-hardened container). Verified by `deploy/verify-container.sh` +
  `deploy/verify-capture.mjs`.
- **Reason:** Enabling the in-process sandbox would require re-adding broad privileges
  (e.g. SYS_ADMIN) or dropping no-new-privileges — a net weaker posture than the
  locked-down container + egress firewall. Correctness over a misleading claim.
- **Tradeoffs:** A renderer exploit runs as pwuser in-container (no Chromium sandbox),
  contained by caps/seccomp/read-only/egress rather than by Chromium itself.
- **Rollback path:** `CAPTURE_CHROMIUM_SANDBOX` + deploy/ assets; no schema impact.
- **Status:** Accepted (Phase 6; supersedes the Phase-5 "sandbox always on" wording).

---

## D-0021 — Paid-result recovery envelope written before DB persistence

- **Date:** 2026-07-15
- **Problem:** A DB failure after paid model calls must never force re-paying for the same calls.
- **Chosen option:** After the audit completes (before the persistence transaction), write a local recovery
  envelope (`.audit-tmp/`, atomic temp→rename, mode 0600, git-ignored) containing the full persist record +
  version stamps. On success it is deleted; on failure `resume-audit` (and a startup scan in `audit-websites`)
  replays persistence idempotently (keyed by audit-run id). Replay NEVER calls the model.
- **Reason:** Paid results are the expensive artifact; the DB write is retryable. Idempotent replay makes the
  failure mode "retry a free transaction", never "spend again".
- **Tradeoffs:** Transient local plaintext copy of findings (no secrets, no keys, no images); restrictive perms.
- **Rollback path:** scripts/rollback/0005_audit_down.sql, delete src/integrations/audit/.
- **Status:** Accepted (Phase 6).

---

## D-0020 — Independent adversarial reviewer; deterministic acceptance

- **Date:** 2026-07-15
- **Problem:** A single model pass over-claims; self-review inherits the same reasoning bias.
- **Chosen option:** A second, fully independent model call (no shared reasoning, no `previous_response_id`,
  minimized reviewer package of only referenced evidence) adversarially checks each finding by its temporary
  `findingRef`. Code — not the model — applies decisions/revisions, caps findings at 5 (≤3 outreach-safe),
  generates DB UUIDs, and computes the opportunity score from versioned rules (`opp-rules-1`, hash persisted).
- **Reason:** Model classifies; code decides. Every score is reproducible from persisted breakdown rows.
- **Tradeoffs:** Doubles per-lead model cost (2 calls normal case; ≤4 with retries).
- **Rollback path:** Config/prompt versions are pinned; git reset to phase-5 tag.
- **Status:** Accepted (Phase 6).

---

## D-0019 — Website text is untrusted data; validation is deterministic and code-owned

- **Date:** 2026-07-15
- **Problem:** Captured website content can carry prompt-injection; model text can over-claim.
- **Chosen option:** Prompts pin an untrusted-data boundary (no tools, never follow embedded instructions);
  ALL acceptance gates are deterministic code: evidence IDs must exist in the package, affected URLs must
  canonicalize into the captured set, forbidden-claim/placeholder/prompt-leak regex denylists, reviewer refs
  must map 1:1. The eval dataset includes injection attacks graded by marker absence.
- **Reason:** Injection resistance must not depend on model behavior alone; validators are reproducible.
- **Tradeoffs:** Regex denylists are conservative and may occasionally reject valid phrasing (retry with hint).
- **Rollback path:** src/domain/audit/validation.ts is self-contained.
- **Status:** Accepted (Phase 6).

---

## D-0018 — OpenAI Responses API for the audit phase; provider behind a port; mock-first

- **Date:** 2026-07-15
- **Problem:** Phase 6 needs a concrete LLM provider without coupling the domain to it or spending in tests.
- **Chosen option:** OpenAI Responses API (openai@6.46.0 pinned; `text.format` json_schema strict,
  `reasoning.context='current_turn'`, `store:false`, no tools) behind the `LlmProvider` port.
  `MockLlmProvider` is the default everywhere; real calls additionally require `ALLOW_PAID_LLM_CALLS=true`
  + key + verified price table, and happen only at approved Gates A/B. Contract recorded in
  docs/integrations/openai-responses.md.
- **Reason:** Structured outputs + multimodal + caching controls fit the audit shape; the port keeps
  Anthropic/local models swappable; mock-first keeps CI free and deterministic.
- **Tradeoffs:** Placeholder pricing must be reconciled before Gate A (enforced by a hard block).
- **Rollback path:** Provider is one adapter file; the domain never imports OpenAI types.
- **Status:** Accepted (Phase 6).

---

## D-0017 — Hardened container is the browser SSRF boundary (not URL checks alone)

- **Date:** 2026-07-11
- **Problem:** URL/IP validation cannot fully prevent browser-level SSRF (subresources,
  page `fetch`, browser-internal DNS/QUIC).
- **Chosen option:** Defense in depth — app-level request interception + SSRF guard + disabling page-script
  WebSocket/WebRTC, PLUS a hardened, network-isolated container as the authoritative boundary for real
  captures (non-root, sandbox on, seccomp, `--init`, read-only fs + tmpfs, cap-drop, resource limits, egress
  firewall denying private/metadata ranges). Local Windows Chromium is for controlled fixtures/dev only.
- **Reason:** Honest security posture; the standard Playwright image is a runtime dependency, not a complete
  boundary. We never claim browser SSRF is solved by URL checks alone.
- **Tradeoffs:** Production captures require container infrastructure (documented, not auto-run here).
- **Rollback path:** Deploy config only (`deploy/`).
- **Status:** Accepted (Phase 5). See docs/deploy/hardened-browser.md.

---

## D-0016 — Do not persist full HTML; store bounded evidence + screenshots + hashes

- **Date:** 2026-07-11
- **Problem:** How much captured content to persist for the Phase 6 audit.
- **Chosen option:** Persist bounded visible text, element-level structured evidence, screenshots
  (content-addressed blobs), a raw-DOM hash (forensic), and a normalized evidence fingerprint. **No full HTML**;
  no cookies/storage/profiles/secrets.
- **Reason:** Privacy + size; hashes give change detection/dedup; screenshots are the visual evidence. Any
  future HTML retention must be justified separately.
- **Tradeoffs:** Post-hydration DOM mutations after settle aren't captured beyond the rendered snapshot used
  for extraction.
- **Rollback path:** Evidence extraction isolated in `src/domain/capture/`.
- **Status:** Accepted (Phase 5).

---

## D-0015 — Playwright 1.61.1 pinned; local dev install, Docker for production

- **Date:** 2026-07-11
- **Problem:** Choose an exact Playwright version + browser-install strategy; the npm package, browser
  binaries, and Docker image tag must match.
- **Chosen option:** Pin `playwright@1.61.1` (verified current stable via `npm view`). Dev installs Chromium
  with `npx playwright install chromium`; production/scheduled runs use `mcr.microsoft.com/playwright:v1.61.1-noble`
  (tag = package version). Each capture run records `playwright_package_version`, `browser_version`, and image
  tag where available.
- **Reason:** Reproducibility; the official docs require the Docker and project versions to match.
- **Tradeoffs:** Version bumps require updating the pin, image tag, and re-installing browsers together.
- **Rollback path:** Version pin + provider are isolated; mock provider needs no browser.
- **Status:** Accepted (Phase 5).

---

## D-0014 — Google context is in-memory only; paid reads separated from outbound

- **Date:** 2026-07-11
- **Problem:** Enrichment needs identification context for Place-ID-only leads, but Places content can't be
  persisted, and paid reads must not be conflated with prospect-facing outbound actions.
- **Chosen option:** Optional `GoogleContextProvider` fetches Place Details (New) by Place ID for **in-memory**
  context only (never persisted; a returned `websiteUri` is only a candidate to verify). Gated by a new
  `ALLOW_PAID_READS` flag distinct from `OUTBOUND_ACTIONS_ENABLED`/`DRY_RUN`; per-run request + cost caps;
  logs counts/cost only. Standard tests/installs keep it off and need no key.
- **Reason:** Compliant, safe, and lets `DRY_RUN=true` still permit capped read-only research.
- **Tradeoffs:** Recommended production context provider requires a one-time GCP/key setup (documented).
- **Rollback path:** Config-only; provider disabled by default.
- **Status:** Accepted (Phase 4). See docs/integrations/google-places-details.md.

---

## D-0013 — Deterministic enrichment (no LLM) + SSRF-hardened fetching

- **Date:** 2026-07-11
- **Problem:** Verify an official website and extract contacts safely, reproducibly, and without paid models.
- **Chosen option:** Deterministic verification — strict signals (exact phone, name+address, branch-location,
  structured data, legal footer), name-tokens-alone never verifies. SSRF-hardened GET: manual redirects,
  per-hop scheme/credential/IP validation (private/reserved v4+v6, IPv4-mapped, metadata, multicast),
  connect-time DNS re-validation, redirect/byte/time caps, HTML-only. No LLM.
- **Reason:** Matching/parsing is deterministic; a model would add cost, nondeterminism, and hallucination
  risk. SSRF hardening is mandatory when fetching operator/third-party URLs.
- **Tradeoffs:** JS-only sites can't be parsed by cheerio → returned as `BROWSER_REQUIRED` (Phase 5).
- **Rollback path:** Isolated to enrichment modules + `utils/safe-fetch.ts`, `utils/ip-guard.ts`.
- **Status:** Accepted (Phase 4).

---

## D-0012 — HTML parser: cheerio

- **Date:** 2026-07-11
- **Problem:** Need a maintained, non-browser HTML parser for deterministic extraction.
- **Options considered:** cheerio, parse5, node-html-parser, jsdom.
- **Chosen option:** cheerio 1.2.0 (built on the spec-compliant parse5; optional forgiving htmlparser2).
- **Reason:** Verified current + healthily maintained; robust on malformed real-world HTML; no browser/DOM
  overhead. node-html-parser is lighter but less spec-compliant.
- **Tradeoffs:** Slightly heavier than node-html-parser.
- **Rollback path:** Parsing isolated in `src/domain/enrichment/extract.ts`.
- **Status:** Accepted (Phase 4).

---

## D-0011 — Insert an independent enrichment & website-discovery phase

- **Date:** 2026-07-11
- **Problem:** Qualification and website capture assumed a website already exists, but Google discovery is
  Place-ID-only and many leads are phone-only. Website quality was also being conflated into qualification.
- **Options considered:** Discover websites inside capture; add a dedicated enrichment phase before capture.
- **Chosen option:** New Phase 4 "Independent enrichment & website discovery" before website capture; former
  phases 4–13 renumbered 5–14. Enrichment writes durable facts from independent public sources
  (`source_type='website'`) with source URL + capture time, then re-qualifies.
- **Reason:** Keeps qualification pre-audit and deterministic; isolates the act of finding/verifying an
  official website; routes phone-only leads to `WEBSITE_DISCOVERY` → `READY_FOR_ENRICHMENT`.
- **Tradeoffs:** One more phase; lead lifecycle gains `READY_FOR_ENRICHMENT` and `ENRICHED`.
- **Rollback path:** Roadmap/doc change; state additions are additive.
- **Status:** Accepted (Phase 3). Enrichment implemented in Phase 4.

---

## D-0010 — Per-fact provenance via `lead_facts` (not lead-level)

- **Date:** 2026-07-11
- **Problem:** A single lead-level provenance can't represent facts from mixed sources or their history, and
  qualification must cite the exact facts it used.
- **Options considered:** Keep lead-level `facts_source`; full EAV (facts only in `lead_facts`); hybrid
  (authoritative `lead_facts` + denormalized current-value projection on `leads`).
- **Chosen option:** Hybrid. `lead_facts` is authoritative (type, value, normalized value, source type/url,
  captured_at, confidence, supersession, `is_current`); `leads.*` fact columns are a derived current-value
  projection for dedup/display. A partial unique index enforces one current fact per `(lead_id, fact_type)`;
  replacement + supersession happen in one transaction. Qualification references facts via the
  `qualification_result_facts` join table (FKs), not a JSON array.
- **Reason:** Traceability, history, and DB-enforced integrity. `input_fingerprint` is computed from
  canonically-sorted rule + fact inputs (timestamps/ids excluded) for stable re-qualification comparison.
- **Tradeoffs:** More write complexity; retrofitted Phase 2 collection to emit `lead_facts`.
- **Rollback path:** Legacy `facts_source*` columns kept (deprecated) and backfilled; dropped only in a later
  migration after verification.
- **Status:** Accepted (Phase 3).

---

## D-0009 — Qualification is deterministic, PRE_AUDIT, multi-score

- **Date:** 2026-07-11
- **Problem:** Need a versioned, deterministic qualification that doesn't conflate "worth auditing" with
  "ready for outreach" and doesn't reject on weak/missing evidence.
- **Options considered:** Single score; AI-assisted; deterministic multi-score with rejection gates.
- **Chosen option:** Deterministic only (no AI). Stage `PRE_AUDIT`: `ACCEPT` means worth enriching/auditing.
  Separate `business_viability`, `auditability`, `contactability`, `opportunity` scores; PRE_AUDIT composite =
  0.6·viability + 0.4·auditability (opportunity null until audit; contactability tracked for later). Hard
  rejection only on confidently verified conditions (suppressed, permanently closed, outside niche, verified
  chain). Rules are versioned and hashed (`rules_config_hash`) into every result; results are append-only.
  Ownership is a verified fact (`ownership_type`) — a name match only flags a possible chain, never proves it.
- **Reason:** Meets the "quality over volume", reversible, auditable, no-fabrication constraints.
- **Tradeoffs:** Website-quality/opportunity assessment deferred to the audit phase.
- **Rollback path:** Rules/config are isolated; `qualification_results` is additive.
- **Status:** Accepted (Phase 3).

---

## D-0008 — No storage of Google Places content; Place ID only

- **Date:** 2026-07-11
- **Problem:** Google Maps Platform terms restrict caching of Places content. Persisting display name,
  address, phone, website, rating, etc. (or normalized derivatives) would be non-compliant.
- **Options considered:** Store full raw payload; store selected fields for 30 days with purge; store nothing
  but Place ID.
- **Chosen option:** Persist **only** Place ID + our own metadata (request params, field mask, outcome, match
  decision, cost/usage, timestamps). Google display content is processed **in memory only** and discarded.
  Coordinates may be cached ≤30 days in an isolated purge-on-expiry structure — but Phase 2 persists no
  coordinates, so no retention obligation arises. Durable facts come later from independent public sources
  (official website) with `facts_source` / `facts_source_url` / `facts_captured_at` (never `google_places`).
- **Reason:** Compliance with current Places terms; keeps the durable store defensible. `response_hash` and a
  general `transient_fields` cache were removed as they derive from restricted content.
- **Tradeoffs:** Google-sourced leads are Place-ID-only candidates until enrichment; cross-run dedup for Google
  reduces to Place ID (documented limitation).
- **Rollback path:** Isolated to the collection layer + schema; no destructive change.
- **Status:** Accepted (Phase 2).

---

## D-0007 — Google Places API (New) + ID-only discovery mask

- **Date:** 2026-07-11
- **Problem:** Which Places API/endpoint and which fields to request for Phase 2 lead discovery.
- **Options considered:** Legacy Places API; Places API (New) `searchText` with a rich mask; Places API (New)
  with an IDs-only mask.
- **Chosen option:** Places API (New) `POST places:searchText`, field mask **`places.id,nextPageToken` only**
  (two-stage strategy: enrichment deferred).
- **Reason:** Verified against current official docs (2026-07-11). Field mask sets the billed SKU tier;
  IDs-only stays in the cheapest Essentials tier and needs no content storage. Enough to create Place-ID
  candidates and dedup by Place ID.
- **Tradeoffs:** No name/address/coords from discovery, so rich dedup relies on later enrichment or
  mock/manual data. Pricing figures are local estimates pending official reconciliation.
- **Rollback path:** Provider is behind `LeadSourceProvider`; mask/endpoint changes are localized.
- **Status:** Accepted (Phase 2). See docs/integrations/google-places.md.

---

## D-0006 — Runtime: pin Node.js 24 (Krypton) Active LTS

- **Date:** 2026-07-11
- **Problem:** The spec says "current LTS" without a version. My initial claim of "Node 22 = current LTS"
  was unverified and wrong; the correct version had to be confirmed against official docs before pinning.
- **Options considered:** Node 24 (Active LTS, "Recommended For Most Users"); Node 22 (Maintenance LTS,
  already installed); Node 26 (Current — not for production).
- **Chosen option:** Node 24 (Krypton), pinned consistently across local dev, `package.json` engines
  (`>=24.0.0 <25.0.0`), `.nvmrc` (`24`, resolves to the latest stable patch), and CI (`node-version-file`).
- **Reason:** Verified via nodejs.org/en/download (recommended = v24.18.0 LTS) and the previous-releases page
  (v24 = Active LTS to ~2028; v22 = Maintenance LTS to ~April 2027). User confirmed Node 24 and requested the
  latest stable patch rather than a hardcoded old patch.
- **Tradeoffs:** Required upgrading the local machine from v22.18.0 to v24.x. All chosen dependencies
  (drizzle-orm, pg, zod, pino, commander, tsx, vitest, eslint, typescript, prettier) support Node 24.
- **Rollback path:** Change the version in `.nvmrc` + engines + CI; no code coupling to a specific version.
- **Status:** Accepted (Phase 1). Local + CI pinned to Node 24.

---

## D-0001 — ORM: Drizzle over Prisma

- **Date:** 2026-07-11
- **Problem:** Need a type-safe DB layer with explicit, reversible migrations for PostgreSQL.
- **Options considered:** Drizzle ORM; Prisma; raw `pg` + hand-written SQL.
- **Chosen option:** Drizzle ORM.
- **Reason:** SQL-first and explicit, excellent TypeScript strict-mode inference, migrations are plain SQL we
  fully control (aligns with the "no destructive migration without a backup path" and "never delete migrations"
  rules), lightweight with no separate engine/binary. Fits the deterministic, auditable design.
- **Tradeoffs:** Smaller ecosystem than Prisma; less batteries-included tooling (e.g. no Prisma Studio). Team
  familiarity with Prisma is more common.
- **Rollback path:** ORM is isolated behind `src/persistence/`. Repositories expose domain methods, not ORM
  types, so swapping to Prisma later touches only that layer plus migration format.
- **Status:** Accepted (Phase 0).

---

## D-0002 — Local database: Docker Desktop (WSL 2 backend)

- **Date:** 2026-07-11
- **Problem:** Docker is not currently installed, but the spec mandates local Postgres via Docker Compose.
- **Options considered:** Install Docker Desktop (WSL 2 backend); native Windows Postgres install; Supabase
  cloud for dev; defer to Phase 1.
- **Chosen option:** Docker Desktop with the WSL 2 backend, **installed by the user before Phase 1**.
- **Reason:** Matches the spec, keeps local/CI/prod environments consistent, most reproducible. User confirmed
  this choice.
- **Tradeoffs:** Requires a one-time Docker Desktop install and WSL 2 setup on Windows; heavier than a native
  install. Docker not needed for Phase 0.
- **Rollback path:** `docker-compose.yml` is the only Docker coupling; a native Postgres or Supabase URL can be
  substituted via `DATABASE_URL` without code changes.
- **Status:** Accepted (Phase 0). **Prerequisite for Phase 1.** Phase 0 does not install or configure Docker.

---

## D-0003 — Repository root name: `automation-suite/`

- **Date:** 2026-07-11
- **Problem:** The suggested structure uses root `outreach-system/`; the project folder is `automation-suite/`.
- **Options considered:** Rename folder to `outreach-system/`; keep `automation-suite/`.
- **Chosen option:** Keep `automation-suite/` as the repo root; adopt the suggested internal `src/...` structure.
- **Reason:** Folder already created and referenced; internal structure is what matters for the code. Documented
  deviation as required.
- **Tradeoffs:** Minor naming divergence from the spec text.
- **Rollback path:** Directory rename + update path references; no code impact.
- **Status:** Accepted (Phase 0).

---

## D-0004 — Package manager: pnpm via Corepack

- **Date:** 2026-07-11
- **Problem:** pnpm is not installed; the spec prefers pnpm. Corepack 0.33.0 is available.
- **Options considered:** pnpm via Corepack; global pnpm install; use npm instead.
- **Chosen option:** pnpm via Corepack (`corepack enable pnpm`), pinned via `packageManager` in `package.json`.
- **Reason:** Matches spec, no global install pollution, version pinned per-repo.
- **Tradeoffs:** `corepack enable` may require an elevated shell on this Windows setup (observed EPERM writing to
  `C:\Program Files\nodejs`). Resolved at Phase 1 start.
- **Rollback path:** Fall back to npm; lockfile/scripts are the only coupling.
- **Status:** Accepted. Resolved in Phase 1: pnpm 11.11.0 enabled via a Corepack shim in the user-writable
  `%LOCALAPPDATA%\Microsoft\WindowsApps` directory (already on PATH), avoiding the elevated-shell requirement.
  Version pinned via `packageManager` in `package.json`.

---

## D-0005 — Production LLM provider: deferred, abstraction-first

- **Date:** 2026-07-11
- **Problem:** The system must not couple to one model provider, but a production provider is needed by Phase 5.
- **Options considered:** Commit to OpenAI now; commit to Anthropic now; build `LlmProvider` abstraction and
  defer the concrete production choice until Phase 5.
- **Chosen option:** Build the `LlmProvider` interface + mock provider first; choose the production provider at
  Phase 5 after checking current official docs and pricing.
- **Reason:** No AI calls occur before Phase 5; deferring avoids premature lock-in and lets us verify current
  APIs/pricing at decision time. Model names stay in env, never hardcoded.
- **Tradeoffs:** One concrete implementation still to be written later.
- **Rollback path:** Any provider swap is confined to `src/integrations/<provider>/` behind `LlmProvider`.
- **Status:** Accepted (Phase 0). Concrete provider decision pending (Phase 5).
