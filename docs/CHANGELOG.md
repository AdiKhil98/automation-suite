# Changelog

All notable changes per phase. Format loosely follows Keep a Changelog.

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
