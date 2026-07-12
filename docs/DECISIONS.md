# Decision Log

Every significant decision is recorded here in the required format. Newest first.

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
