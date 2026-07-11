# automation-suite — Controlled AI Outreach Operating System

A production-grade, coded **TypeScript** pipeline that researches niches, collects and qualifies local-business
leads, audits their websites with stored evidence, decides whether to build a demo, and drafts concise,
evidence-based cold emails for **human review** — reversible, auditable, and human-approved until explicitly
changed.

> **Status: Phase 0 — Discovery & System Specification.** No production code yet. See
> [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase plan and [`CLAUDE.md`](CLAUDE.md) for the operating contract.

## What this is (and isn't)

- ✅ A deterministic, testable pipeline with narrow AI stages behind strict schemas.
- ✅ Local-first: files, DB records, and (later) a review dashboard.
- ❌ Not an n8n workflow (n8n is optional, never a core dependency).
- ❌ No sending, Gmail drafts, or public demos until their phases are approved and feature flags enabled.

## Core guarantees

- **Evidence-bound:** every personalization claim maps to stored evidence. No fabrication.
- **Human-approved:** `OUTBOUND_ACTIONS_ENABLED=false` by default; sending requires an approved lead state.
- **Reversible:** one commit + one annotated tag per phase; migrations for schema; feature flags for the rest.

## Planned stack

Node 22 LTS · TypeScript (strict) · pnpm · Zod · Vitest · Playwright · Pino · ESLint · Prettier · PostgreSQL ·
Drizzle ORM · Docker Compose · GitHub Actions · Netlify (demos). Rationale in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Getting started

Setup commands land in Phase 1. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Prerequisite before Phase 1:
install **Docker Desktop (WSL 2 backend)**.

## Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Operating contract for the build |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | Mission, scope, invariants, lifecycle |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, state machine, provider boundary, contracts |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases 0–13 + acceptance criteria |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Reversible defaults |
| [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md) | Risks + mitigations |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Setup + run + recovery |
| [docs/SECURITY.md](docs/SECURITY.md) | Secrets, data minimization, outbound safety |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Metrics, fixtures, prompt versioning |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Per-phase changes |
