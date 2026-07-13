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

## Google Places data handling (Phase 2)

Google Maps Platform terms restrict caching of Places content, so the system persists **no Google Places
content**. See docs/integrations/google-places.md and DECISIONS D-0008.

- **Persisted permanently:** Place ID, internal IDs, provider, campaign/run metadata, our request/query
  parameters, field mask, timestamps, processing outcome, match decision, cost/usage metadata.
- **Never persisted:** display name, formatted address, business status, primary type, website URI, phone,
  rating, review count, and any normalized derivative of these — processed in memory only, then discarded.
- **Coordinates:** cacheable ≤30 days in an isolated purge-on-expiry structure only; Phase 2 persists none.
- **Durable facts** come from independent public sources (official website) with `facts_source`,
  `facts_source_url`, `facts_captured_at`. `facts_source` is never `google_places`.
- Discovery is ID-only (`places.id,nextPageToken`). Real calls require the feature flag
  (`LEAD_SOURCE=google_places`), a key, and `DRY_RUN=false`.

## Fact provenance & suppression (Phase 3)

- Durable facts are stored per-fact in `lead_facts` with a `source_type` restricted (in code and by a DB CHECK)
  to `mock | manual | website`. Google Places content is never a fact source; a partial unique index keeps
  exactly one current fact per `(lead, fact_type)`, with superseded history retained.
- Qualification reads only current, approved facts and records the exact fact IDs used (via the
  `qualification_result_facts` join), so every decision is traceable to evidence.
- A `suppression_list` provides a read-only qualification gate now (a suppressed business is rejected). Full
  sending-time suppression enforcement lands in a later phase; suppression always overrides approval.

## Website enrichment (Phase 4)

- **SSRF-hardened fetching** (`src/utils/safe-fetch.ts` + `ip-guard.ts`): http/https only, no embedded
  credentials, manual redirects with per-hop validation, rejection of private/loopback/link-local/multicast/
  metadata/reserved IPv4 & IPv6 (incl. IPv4-mapped and numeric forms), connect-time DNS re-validation
  (rebinding mitigation), and redirect/byte/time caps; HTML content types only.
- **Bounded crawl:** homepage + a small allowlist of contact/about/location pages (≤5, same-origin). No
  arbitrary crawling, form submission, authentication, or CAPTCHA handling. Full HTML is never persisted.
- **Contacts:** only publicly displayed `mailto:`/visible emails, `tel:`/visible phones, and real contact
  pages are stored. Guessed/generated email addresses are never stored. Operational status, ownership, and
  category are only stored with explicit evidence.
- **Paid reads vs outbound:** `ALLOW_PAID_READS` gates capped read-only research (e.g. Google Place Details)
  and is independent of the outbound kill switch. Google-derived context is in-memory only and never
  persisted (see docs/integrations/google-places-details.md; verified by an integration test).

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
