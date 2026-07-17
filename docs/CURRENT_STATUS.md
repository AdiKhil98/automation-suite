# Current Status

## Current phase
Phase 8B (AI Demo Composer) — COMPLETE, being committed as `phase-8b-ai-composer`.

## Completed work
- Phases 0–8 + Phase 8 quality pass (`phase-8-demo-foundation`).
- Phase 8B: structured `DemoDesignSpec` → adversarial reviewer → deterministic vetted-component
  render; migration 0009; diagnostics store; CLI `compose-demos`. See CHANGELOG + D-0026.
- Paid smoke test passed (APPROVE, $0.0367). Operator approved the demo.

## Uncommitted changes
None after this commit (Phase 8B being committed + tagged + pushed now).

## Remaining tasks
- Phase 9 = cold email writer. NOT started (do not begin without approval).

## Exact commands to continue
- Full suite: `pnpm lint && pnpm typecheck && pnpm test` ; `DATABASE_URL=postgres://postgres:postgres@localhost:5432/outreach pnpm test:integration` ; `pnpm test:browser`
- Paid composer run (ARMED env only): re-seed a lead, then `pnpm cli compose-demos --campaign gate-a-zahnaerzte-berlin --limit 1`
- NOTE: `pnpm test:integration` truncates the DB — re-seed leads after running it.

## Safety restrictions
- `.env` disarmed: `LLM_PROVIDER=mock`, `ALLOW_PAID_LLM_CALLS=false`, `DEMO_COMPOSER_ENABLED=false`.
- Paid calls need all three armed + `OPENAI_API_KEY`. Prompt cache off. `DRY_RUN=true`, `OUTBOUND_ACTIONS_ENABLED=false`.
- Do NOT begin Phase 9 without explicit approval. No Netlify/deploy in Phase 8B.
