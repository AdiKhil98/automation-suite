# CLAUDE.md — Controlled AI Outreach Operating System

> Repository-level operating contract for Claude Code. Read this before doing anything in this repo.

## Project mission

Build a production-grade, **coded TypeScript** application that runs a controlled, auditable
outbound-outreach pipeline for a web-design / AI-automation services business:

1. Research and select promising business niches.
2. Collect businesses in a selected niche + geography.
3. Deduplicate and qualify leads.
4. Research each accepted business and its website (evidence-based).
5. Identify factual, commercially relevant pain points.
6. Optionally compare against local competitors.
7. Decide demo tier: `NONE` / `SHARED` / `BRANDED`.
8. Write a concise, evidence-based personalized cold email.
9. Independently review and revise the email.
10. Save lead + evidence + audit + demo URL + email for **human review**.
11. Later (approved phases only): create Gmail drafts, then send.

## Scope exclusions

- **Not** an n8n workflow. n8n is optional and must never be a core dependency.
- **No** unrelated projects (e.g. PureCrunch, KP Medical) — this repo is outreach-only.
- **No** Kubernetes, microservices, Redis, queues, or event buses in the MVP.

## Current approved phase

**Phases 0–4 approved. Phase 5 — Website capture & evidence extraction — complete, awaiting `APPROVE PHASE 5`.**
Do not begin Phase 6 (AI website audit & opportunity analysis) until the user replies `APPROVE PHASE 5`.
Note: an enrichment phase was inserted at position 4; former phases 4–13 are now 5–14 (see docs/ROADMAP.md).
Capture uses Playwright (mock by default). Standard tests use mock; the real browser suite is `pnpm test:browser`.

## Operating protocol (mandatory)

- Build strictly in numbered phases (0–13). **Never implement more than one phase without explicit user approval.**
- At the end of every phase: run tests/quality checks → show what changed → show unresolved risks →
  update docs → one final phase commit → one annotated tag → **stop and request approval** using the format below.
- One clean commit per meaningful unit; one final phase commit; one annotated tag per phase.
- Schema changes go through migrations. Incomplete integrations sit behind feature flags.
- Never rewrite Git history. Never force-push. Never delete previous migrations.
- Before changing existing working behavior, explain: what changes, why, affected files, rollback method.

### Required approval format

```text
Phase X is complete.

Commit:
<commit hash>

Tag:
phase-X-<short-name>

Tests:
<results>

What is working:
<concise list>

What is not implemented:
<concise list>

Decisions requiring review:
<concise list>

To continue, reply:
APPROVE PHASE X
```

## Commands (target — implemented from Phase 1 on)

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm check          # all required non-paid validation
```

## Architecture boundaries

- Deterministic pipeline of small, testable modules first. No giant autonomous multi-agent system.
- Deterministic code owns: arithmetic, thresholds, dedup, state transitions, validation, URL normalization,
  rate limiting, retry policy, filtering, cost/sending limits, suppression.
- AI is used only for: interpreting ambiguous evidence, summarizing commercial impact, comparing positioning,
  choosing a personalization angle, drafting emails, reviewing emails.
- **AI must never perform calculations normal code can do reliably.**
- All model access goes through the `LlmProvider` interface. Model names come from env config, never hardcoded.
- All model outputs are validated with Zod. Never parse model prose with regex.

## Coding conventions

- TypeScript strict mode. No `any`. Strict null handling.
- Small modules, descriptive names, typed errors, pure functions for business rules.
- Dependency injection around every external service.
- Prompts live in versioned files under `src/prompts/`, never inline in business logic.
- No giant files, no silent catch blocks, no mutable global state, no hidden model defaults.

## Test requirements

- Each phase ships tests. Unit tests for normalization, scoring, dedup, state transitions, schemas,
  budget checks, word counts, suppression, demo-decision rules.
- Integration tests use mocks / recorded fixtures (Google Places, browser, model providers, DB, Netlify, Gmail).
- **No paid API calls in the standard test suite.** E2E uses local fixtures / controlled test sites only.

## Git rules

- One phase = one final commit + one annotated tag (`phase-X-<name>`).
- Never combine multiple phases in one commit. Never mix refactors with unrelated feature work.
- Never rewrite history, never force-push, never delete migrations.

## Non-negotiable invariants

**Outbound kill switch.** No sending integration may operate unless `OUTBOUND_ACTIONS_ENABLED=true`.
Even when true, sending still requires an approved lead state.

**Evidence rule.** Every personalization claim must map to stored `evidence` IDs. The email writer may use
only approved evidence. Unverifiable facts must not appear as factual statements.

**Hallucination rule.** Never invent contact/employee names, website problems, broken buttons, services,
awards, reviews, ratings, testimonials, revenue loss, conversion gains, competitor performance, ownership
status, or technical failures. Use `unknown` / `needs_manual_review` when evidence is insufficient.

**Phase approval rule.** See below — copied verbatim as required.

---

> Claude must not begin the next phase until the user explicitly approves the current completed phase.
>
> Claude must not send email, create Gmail drafts, publish demos, or make external writes unless the relevant
> phase has been approved and all required feature flags are enabled.

## Forbidden actions

Do not: build all phases in one run; skip tests; continue without approval; send real outreach; create Gmail
drafts before Phase 11; deploy branded demos before Phase 10; expose secrets; commit `.env`; invent prospect
data; use fake reviews; generate deceptive demos; hide assumptions; silently change architecture; combine
phases in one commit; run destructive DB operations without a rollback plan; use AI for deterministic
arithmetic; add unnecessary infrastructure; or claim production readiness without meeting documented
acceptance criteria.
