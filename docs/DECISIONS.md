# Decision Log

Every significant decision is recorded here in the required format. Newest first.

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
- **Status:** Accepted (Phase 0). Enable step deferred to Phase 1 setup.

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
