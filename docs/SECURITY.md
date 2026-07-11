# Security

**Status:** Phase 0 (policy; enforced progressively from Phase 1).
**Last updated:** 2026-07-11

## Secrets

- Never commit API keys or `.env`. Only `.env.example` (with empty/placeholder values) is committed.
- Validate all required environment variables at startup; fail fast with a clear message if missing/invalid.
- Redact secrets from all logs. Model-call logs record usage + estimated cost, never keys or raw credentials.
- Use least-privilege credentials. Restrict Google API keys (referrer/IP/API restrictions) where possible.

## Data minimization

- Store only business data needed for the workflow. Do not collect unnecessary personal data.
- Research only publicly accessible business information (see respectful-research rules in PRODUCT_SPEC.md §6).

## Outbound safety

- Global kill switch `OUTBOUND_ACTIONS_ENABLED=false` blocks every sending integration regardless of state.
- Even when `true`, sending requires an approved lead state (`HUMAN_APPROVED`) and a passed review.
- Maintain a `suppression_list`. Unsubscribed leads can never re-enter a sending campaign; suppression
  overrides approval.

## Demos

- Prospect-specific demo pages must include `<meta name="robots" content="noindex,nofollow" />`.
- Demos carry a clear concept/demo disclosure and never impersonate the live site.
- Branded demos are generated locally only until Phase 10 is approved.

## Dashboard (Phase 9+)

- Authentication is required before any remote deployment. No unauthenticated exposure of prospect data.

## Dependency & supply chain

- Every dependency must have a documented reason. Lockfile committed. No unnecessary infrastructure.

## Git hygiene

- `.gitignore` covers `.env`, `node_modules`, build output, coverage, Playwright artifacts, and local DB volumes.
- Never rewrite history; never force-push; never delete migrations.
