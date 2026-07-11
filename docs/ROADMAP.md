# Roadmap

**Status:** Phase 0 (in progress)
**Last updated:** 2026-07-11

One phase at a time. Each phase ends with tests, a commit, an annotated tag, and an explicit approval gate.
No phase begins before the previous one is approved with `APPROVE PHASE X`.

| Phase | Name | Tag | Approved? |
|---|---|---|---|
| 0 | Discovery & system specification | `phase-0-specification` | ✅ approved |
| 1 | Local foundation & deterministic core | `phase-1-foundation` | ⏳ in progress |
| 2 | Lead collection & deduplication | `phase-2-lead-collection` | ☐ |
| 3 | Deterministic qualification | `phase-3-qualification` | ☐ |
| 4 | Website capture & evidence extraction | `phase-4-website-capture` | ☐ |
| 5 | AI website audit & opportunity analysis | `phase-5-ai-audit` | ☐ |
| 6 | Competitor research (optional module) | `phase-6-competitor-research` | ☐ |
| 7 | Demo template & demo decision engine | `phase-7-demo-engine` | ☐ |
| 8 | Email writer & reviewer | `phase-8-email-generation` | ☐ |
| 9 | Review dashboard | `phase-9-review-dashboard` | ☐ |
| 10 | Netlify preview deployment | `phase-10-netlify-previews` | ☐ |
| 11 | Gmail draft creation (no send) | `phase-11-gmail-drafts` | ☐ |
| 12 | Scheduling & daily operations | `phase-12-daily-operations` | ☐ |
| 13 | Controlled sending (only on explicit request) | `phase-13-sending` | ☐ |

## Phase 0 — Discovery & system specification (current)

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
- **P11** Gmail drafts only, never send; requires `HUMAN_APPROVED` + passed review + verified recipient + not
  suppressed + `OUTBOUND_ACTIONS_ENABLED=true`; reruns never duplicate drafts; suppression overrides approval.
- **P12** end-to-end dry run; resumable runs; enforced daily caps; visible failures; no external write when disabled.
- **P13** only on explicit request; separate sending plan (jurisdiction, SPF/DKIM/DMARC, unsubscribe,
  suppression, bounce handling, volume ramp, caps, provider, reply detection, follow-ups); removable module.
