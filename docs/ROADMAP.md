# Roadmap

**Status:** Phase 12 complete and live-verified; awaiting commit approval.
**Last updated:** 2026-07-19

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
| 12 | Gmail draft creation (no send) | `phase-12-gmail-drafts` | complete + live-verified; awaiting commit approval |
| 13 | Scheduling & daily operations | `phase-13-daily-operations` | not started |
| 14 | Controlled sending (only on explicit request) | `phase-14-sending` | not started |

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
