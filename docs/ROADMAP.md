# Roadmap

**Status:** Phases 0-16 are complete, committed and tagged through
`phase-16-production-safety-hardening` (`9092606`). Bounded radius prospecting is committed (`2fe45de`).
A post-Phase-16 controlled validation orchestrator remains non-sendable. Demo Engine V2 Milestone 1 is
implemented as an isolated, disabled-by-default foundation; no V2 operational path exists.
**Last updated:** 2026-07-23

One phase at a time. Each phase ends with tests, a commit, an annotated tag, and an explicit approval gate.
No phase begins before the previous one is approved with `APPROVE PHASE X`.

| Phase | Name | Tag | Approved? |
|---|---|---|---|
| 0 | Discovery & system specification | `phase-0-specification` | ✅ approved |
| 1 | Local foundation & deterministic core | `phase-1-foundation` | ✅ approved |
| 2 | Lead collection & deduplication | `phase-2-lead-collection` | ✅ approved |
| 3 | Deterministic qualification (PRE_AUDIT) | `phase-3-qualification` | ✅ approved |
| 4 | Independent enrichment & website discovery | `phase-4-enrichment` | ✅ approved |
| 5 | Website capture & evidence extraction | `phase-5-website-capture` | ✅ approved |
| 6 | AI website audit & opportunity analysis | `phase-6-ai-audit` | approved; Gate B deferred |
| 7 | Competitor research (optional module) | `phase-7-competitor-research` | DEFERRED (optional, post-MVP) |
| 8 | Demo template & demo decision engine | `phase-8-demo-generation` | approved |
| 9 | Email writer & reviewer | `phase-9-email-generation` | approved |
| 10 | Review dashboard | `phase-10-review-dashboard` | approved |
| 11 | Netlify preview deployment | `phase-11-netlify-previews` | approved |
| 12 | Gmail draft creation (no send) | `phase-12-gmail-drafts` | approved + committed + live-verified |
| 13 | Scheduling & daily operations | `phase-13-daily-operations` | complete; committed + tagged |
| 14 | Controlled sending (only on explicit request) | `phase-14-sending` | complete; committed + tagged |
| 15 | Production sending readiness and live Gmail provider integration | `phase-15-production-sending-readiness` | complete; committed + tagged |
| 16 | Production safety hardening | `phase-16-production-safety-hardening` | complete; committed + tagged; no live send |

## Demo Engine V2 roadmap

| Milestone | Scope | Status |
|---|---|---|
| 1 | Additive schemas, immutable contracts, manifests, validators, repositories, fixtures, and safety tests | complete; locally verified |
| 2+ | Intelligence/content generation, translation, asset acquisition, briefs/plans, rendering, visual review, revisions, human review, deployment integration | not approved; not implemented |

Milestone 1 leaves V1 untouched and selected by default. Migration `0023` creates 21 isolated V2 tables with
no FK to `demos`. Human translation/reuse/final approvals are actor-bound; approval packages bind the complete
content/translation/asset/brief/plan/registry/render/screenshot/rubric/visual-review fingerprint. Automatic
review is advisory only and cannot authorize deployment. See D-0037.

> **Controlled prospect validation extension:** the normal prospect continuation remains conservative.
> An explicit `--controlled-test` mode may process exactly one qualified lead through the existing capture,
> audit, composition, preview-deploy, draft, read-only preflight, schedule, and local-readiness stages. It
> requires the configured test-recipient environment variable, safe sending kill switches, and short-lived
> run/hash-bound controlled approvals. These approvals are not human or sending approvals. The resulting
> readiness/dry-run records are database-constrained to `CONTROLLED_TEST_NOT_SENDABLE`; no send method is
> reachable from the coordinator. See D-0036.

> **Phase 16 objective:** close the production-readiness blockers found after Phase 15 without any
> live Gmail operation or send. Reconcile operations documentation; bind and verify Reply-To; make
> provider preflight read-only; add a complete local dry-run report, a structurally read-only Gmail
> verification command, audited multi-scope suppression intake, credential ACL tooling, and explicit
> retention/objection/recovery procedures. Mock remains the default and every sending flag stays disabled.
> Operational execution is defined in `docs/PRODUCTION_OPERATIONS.md`; each live or state-changing step retains
> its own approval gate.

> **Phase 14 implementation:** the committed mock-first safety controller evaluates exactly one known
> scheduled draft, verifies its immutable bindings twice, requires an expiring readiness approval and
> exact interactive confirmation, durably reserves the attempt, and permanently blocks automatic retry
> after an uncertain provider outcome. It does not claim provider-level exactly-once delivery; see D-0031.

> **Phase 15 objective:** production sending readiness and live Gmail provider integration, with no live
> Gmail calls or sends during implementation. Add a separately selectable HTTP provider behind the Phase 14
> controller, strict known-draft parsing, readiness/revocation/status/reconciliation operator commands,
> account daily-cap enforcement, and zero-network tests. Mock remains the default and every sending flag
> remains disabled. No follow-up automation, reply detection, inbox access, bulk sending, or automatic retry.
> Manual uncertainty reconciliation is a dedicated TTY-confirmed path, not a general state-machine edge.
> It preserves the original `OUTCOME_UNKNOWN` attempt and records a separate confirmed-sent,
> confirmed-not-sent, or unresolved audit decision; see D-0032.

> **Phase 13 implementation:** deterministic, timezone-aware scheduling records intended send times in
> PostgreSQL only. It requires a verified recipient IANA timezone, enforces configurable local windows,
> weekdays, spacing and daily caps, preserves cancel/reschedule history, and binds each schedule to the
> exact Gmail draft, finalized content and recipient. `--dry-run` is write-free. Phase 13 has no Gmail
> call or sending implementation; see D-0030.

> **Phase renumbering (Phase 3):** an *Independent enrichment & website discovery* phase was inserted at
> position 4; former phases 4–13 shifted to 5–14. Enrichment discovers/verifies official websites for
> phone-only leads and writes durable facts (`source_type='website'`) with source URL + capture time, then
> re-qualifies. See DECISIONS D-0011.

> **Deferred tasks — Gate B model eval (from Phase 6):** the first Gate B run (2026-07-16) is marked
> **INVALID_FOR_MODEL_SELECTION** — it was degraded by transient network errors (only Sol/Sol partially
> completed; $0.1545 spent). Its cost + diagnostic records are preserved (`eval-reports/`), but its quality
> metrics MUST NOT be used to choose a production model. Production stays on the PROVISIONAL gpt-5.6-sol/medium
> baseline (D-0024). Deferred until the pipeline is end-to-end functional and there is real audit volume:
> 1. **Rerun Gate B under stable network conditions** — `pnpm cli eval-audit --cases "missing-cta,good-site,mobile-overflow,desktop-mobile-mismatch,injection-heading,minimal-evidence" --models "gpt-5.6-sol,gpt-5.6-terra" --reviewers "gpt-5.6-sol,gpt-5.6-terra"`.
> 2. **Monitor fabricated evidence-reference rates** on real audits (the Gate A repair + the degraded run both showed the generator can cite out-of-package evidence IDs).
> 3. **Improve evidence-citation prompting** if the fabricated-reference rate is material.
> 4. **Run future paid evaluations in small foreground batches with explicit stop points** (not a single 48-call background run).

## Phase 0 — Discovery & system specification

Docs-only, no production code. Deliverables: all `docs/*` files, `CLAUDE.md`, `README.md`, `.gitignore`,
`.env.example`, domain model, state machine, provider boundary, roadmap, risk register, Phase 1 acceptance
criteria. No dependency install, no external accounts, no paid APIs. → commit + tag `phase-0-specification` → stop.

## Phase 1 — Local foundation & deterministic core

TypeScript strict project, lint/format, Vitest, env validation, Pino logging, local Postgres via Docker
Compose, initial migrations, core `leads` + `evidence` + `pipeline_runs` + `pipeline_events` entities, state
machine, `model_calls` record type, CLI shell, mock fixtures, dry-run mode, global outbound kill switch.
Commands to start DB, run migrations, create/list/inspect sample leads, reset test data. No external APIs, AI,
demos, or emails.

**Acceptance criteria (exact):**

1. `pnpm install` completes clean on a fresh checkout.
2. `docker compose up` starts local Postgres; `pnpm db:migrate` applies migrations with no error.
3. `pnpm cli create-sample-leads` inserts sample leads; `pnpm cli list-leads` shows them.
4. `pnpm cli lead-state <id>` prints current state + event history.
5. Valid state transitions succeed; invalid transitions throw `InvalidStateTransitionError` and write a
   `pipeline_events` row (covered by unit tests).
6. `pnpm cli reset-test-data` safely clears local test data only.
7. Dry-run mode and `OUTBOUND_ACTIONS_ENABLED=false` are wired and default-safe.
8. `pnpm check` (lint + typecheck + unit tests) passes.
9. No secrets in the repo; `.env` is git-ignored; `.env.example` documents every variable.

## Phases 2–13

Goals, build lists, and acceptance criteria are specified in the mission prompt and will be restated in each
phase's start-of-phase report. Highlights of the hard gates:

- **P2** default mock mode; real Google Places behind a feature flag; reruns never duplicate.
- **P3** identical input → identical score; rules versioned; AI cannot control the number.
- **P4** captures fixtures; records redirects/failures; never labels capture failure as a website defect; no form submits.
- **P5** every finding links evidence IDs; no prose parsing; mock tests make no paid calls; meets eval threshold.
- **P6** disableable; low-value leads skip it; no invented competitor-performance claims; cost-capped.
- **P7** one deployment serves many lead routes; noindex; no fabricated content; local previews only.
- **P8** every factual point maps to evidence; placeholders/wrong names/unsupported claims → failure; one rewrite cycle.
- **P9** inspect-why for every statement; edit/approve/reject; every action logged; auth before remote deploy.
- **P10** deploy only approved demos; globally disableable; URLs recorded; noindex verified.
- **P12** Gmail drafts only, never send; requires `HUMAN_APPROVED` + passed review + verified recipient + not
  suppressed + `OUTBOUND_ACTIONS_ENABLED=true`; reruns never duplicate drafts; suppression overrides approval.
- **P13** end-to-end dry run; resumable runs; enforced daily caps; visible failures; no external write when disabled.
- **P14** only on explicit request; separate sending plan (jurisdiction, SPF/DKIM/DMARC, unsubscribe,
  suppression, bounce handling, volume ramp, caps, provider, reply detection, follow-ups); removable module.

## Phase 7 — Competitor research (DEFERRED — optional, post-MVP)

Deferred by operator on 2026-07-16 to prioritize finishing the usable outreach system. **No code, migrations,
states, providers, or tests exist for it.** Full plan preserved here for when it resumes.

- **Purpose:** for a *selected* lead (deterministic gate on Phase 6 opportunity score + comparison-relevant
  finding categories), gather **bounded, evidence-backed** context on how a few verified local competitors
  handle the *same* weaknesses found on the lead's site. Optional, default-off (`COMPETITOR_RESEARCH_ENABLED`).
- **Hard exclusions:** no competitor traffic/revenue/ranking/performance claims; no copying competitor
  content/designs; no SEO/analytics; not every lead; presence/absence facts only.
- **Discovery:** Google Places ID-only (no content persisted, `ALLOW_PAID_READS`-gated) or operator CSV or mock.
- **Verification:** reuse Phase 4 deterministic `WebsiteVerifier`; only VERIFIED competitor official sites proceed.
- **Capture:** reuse Phase 5 hardened container, purpose `COMPETITOR_CAPTURE`, ≤2 pages/competitor, screenshots
  are internal evidence only (never republished).
- **Deterministic core:** feature extraction (has-online-booking, contact-in-header, etc.) + a versioned,
  reproducible comparison matrix with gap flags + evidence citations. **Optional** bounded AI summary reuses
  Phase 6 validation/injection/cost guards (default off).
- **Schema:** `CompetitorComparison` (dimension, leadState+evidence, competitors[present|null + evidence], gap,
  rulesVersion/hash) — no numeric performance fields.
- **DB (next free migration):** competitor_research_runs, competitors (Place-ID-only, no Google content),
  competitor_comparisons + evidence links; capture reuses website_capture_runs.
- **States:** OPPORTUNITY_READY → COMPETITOR_RESEARCH_READY → COMPETITOR_RESEARCHED; not-justified/disabled skip
  unchanged. Outcome taxonomy incl. NOT_JUSTIFIED, ALL_UNVERIFIED, NO_COMPETITORS_FOUND, BUDGET_BLOCKED.
- **Limits:** module kill switch, MAX_COMPETITORS_PER_LEAD (~3), MAX_COMPETITOR_RESEARCH_PER_RUN (~5), paid-read
  + LLM cost caps.
- **Privacy/legal:** public business info only; no Google content persisted; no copied designs; neutral,
  evidence-bound observations; noindex on any artifacts; competitor screenshots internal-only.
- **Rollback:** module flag + migration reverse script + `git reset --hard phase-6-ai-audit`.
