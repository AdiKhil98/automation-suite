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

Two independent tracks are live in this repo. Approval on one never extends to the other.

**Outreach production pipeline — LIVE.** Phases 0–16, plus 17A/17A2/17A3/17B/17C/17C1 (outreach tracking,
read-only Gmail reply sync, live Sheets projection, the controlled first-send smoke test, and delivery-failure
reconciliation) are implemented, and the pipeline is deployed to production via systemd on the operator's VM.
`docs/AUTOMATION_PILOT.md` is authoritative for the exact units, gates, and runbooks — read it before touching
production. Confirmed live and validated: `automation-suite-scheduled-sends.{service,timer}` is enabled/active
and is the **sole** outbound sender, under a durable `scheduled_send_authorizations` grant, with effective
`SENDING_DAILY_CAP=5` set in the unit's own environment (the repo `.env` intentionally stays at the safe
default `SENDING_DAILY_CAP=1` — production gates live only in the systemd unit, never in git). Outreach #1
(initial send) and the lesson-based Follow-up #2 (sequence step 1) have each been sent and confirmed
`SENT_CONFIRMED`, with correct Gmail threading and clean reply/bounce/suppression checks.
`FOLLOWUP_PREPARATION_ENABLED=true` is live (composes follow-up copy through the writer/reviewer pipeline into
the existing human-approval queue only — it cannot send). **`FOLLOWUP_PROGRESSION_ENABLED` remains `false`.**
Flipping it is the single next production-activation step — it lets a HUMAN-approved follow-up advance through
reply-finalization → Gmail draft → send schedule (still not a send path itself: dispatch stays exclusively
`run-scheduled-sends` → `SendService` under its own separate gates/cap/authorization) — and requires its own
explicit operator approval before any Claude Code session enables it, edits the follow-up systemd unit, or
touches its drop-ins.

**Demo Engine V2 / KU64 — separately scoped, unchanged.** Demo Engine V2 fictional validation is complete (a
fictional acceptance package reached a live Sol score of 79 with zero blockers). Phase 3C-A (one guarded,
read-only KU64 evidence export) and Phase 3C-B (a private, local-only review package rendered from that
evidence) are approved and implemented — see below. V1 remains authoritative (`DEMO_ENGINE_VERSION=v1`,
`DEMO_V2_ENABLED=false`). No V2 generation, translation, asset download, rendering, visual review, deployment,
email, Gmail, or provider behavior beyond 3C-A/3C-B is authorized for this track. No OAuth reauthorization,
additional real-data restoration, or real credential ACL change is authorized here.

`docs/CURRENT_STATUS.md`, `docs/ROADMAP.md`, and `docs/AUTOMATION_PILOT.md` are the authoritative current
handoff for both tracks.

**Phase 3C-A scope (read-only).** The `ku64-v2-export-evidence` CLI may read the operational database
SELECT-only, under a session opened `default_transaction_read_only=on`, to export ONE lead's already-stored,
redacted evidence into `.local-data/ku64-v2/evidence.json` (git-ignored; never staged or committed). It
requires both `--confirm-production-read` and `ALLOW_PRODUCTION_READ_EXPORT=true`, and binds only to a lead
whose normalized domain is exactly `ku64.de` (www accepted). It performs zero writes and never renders,
crawls the live site, downloads KU64 media, calls Sol, deploys, drafts, schedules, or sends. It exports no
email drafts/approvals, Gmail records, scheduling records, or outreach copy, and no raw HTML, page bodies,
verbatim website text, or screenshot binaries. Phase 3C-B (any KU64 use of the exported evidence) remains
blocked until the local evidence is reviewed and approved.

## Historical Phase 6 approval record (superseded)

**Phases 0–5 approved. Phase 6 — AI website audit & opportunity analysis — plan approved with 14 amendments;
mock implementation, persistence, eval harness, and tests are complete and green.** Two paid gates remain:
Gate A (single-lead live smoke test) and Gate B (model eval matrix). NO real OpenAI call may be made without
explicit operator approval of the gate, and the Phase 6 commit + tag (`phase-6-ai-audit`) happen only after
the approved gates are completed (amendment 14). Price-table reconciliation (`PRICE_VERIFIED_AT` in
src/integrations/llm/pricing.ts) is a hard precondition enforced in code.
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

Do not: build all phases in one run; skip tests; continue without approval; send real outreach; enable
`FOLLOWUP_PROGRESSION_ENABLED` or any other new production sending/scheduling capability, or edit a production
systemd unit or its drop-ins, without an explicit operator approval naming that specific capability; create Gmail
drafts before Phase 11; deploy branded demos before Phase 10; expose secrets; commit `.env`; invent prospect
data; use fake reviews; generate deceptive demos; hide assumptions; silently change architecture; combine
phases in one commit; run destructive DB operations without a rollback plan; use AI for deterministic
arithmetic; add unnecessary infrastructure; or claim production readiness without meeting documented
acceptance criteria.
