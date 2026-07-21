# Google Places API (New) — Place Details (enrichment context)

**Status:** Phase 4 (optional context provider). **Verified against official docs:** 2026-07.

> **Current persistence policy (migration 0018):** successful Place Details retrieval now commits the
> approved business name, candidate website, formatted address/locality/country, category/type, business
> status, Place ID, provider, retrieval time, and field-level provenance before website verification.
> Phone is excluded unless separately approved. Raw responses, ratings, reviews, coordinates, headers, and
> credentials are not stored. This policy supersedes the older in-memory-only text below.

Used only as an **in-memory discovery context** for enrichment. See DECISIONS D-0014 and
docs/SECURITY.md — none of the returned values are ever persisted.

## Endpoint & field mask
- `GET https://places.googleapis.com/v1/places/{PLACE_ID}`
- Header `X-Goog-Api-Key: <key>`, field mask header `X-Goog-FieldMask`.
- **Field mask (minimum for identification + website discovery):**
  `displayName, formattedAddress, nationalPhoneNumber, websiteUri`
- `websiteUri` + `nationalPhoneNumber` place this in the **Enterprise** SKU tier (verified in the docs field/SKU
  mapping). Cost is estimated per request from the local price table (assumption A-0007) and must be
  reconciled with official pricing before being treated as authoritative.

## Compliance (what happens to the response)
- `displayName`, `formattedAddress`, `nationalPhoneNumber` are used **in memory only** to drive discovery and
  verification, then discarded. A returned `websiteUri` is treated **only as a candidate URL** that still
  requires official-site verification.
- **Persisted permanently:** the Place ID, internal metadata, and facts independently extracted + verified
  from the official business website. Nothing Google-derived is written to DB rows, enrichment attempts,
  candidates, signals, events, logs, notes, errors, fingerprints, or test snapshots (enforced by an
  integration test).

## Cost & safety controls
- Reads only occur when `ENRICHMENT_CONTEXT_PROVIDER=google` **and** `ALLOW_PAID_READS=true` **and** a key is
  configured. Otherwise the provider returns `null` (no call).
- `ALLOW_PAID_READS` is separate from the outbound kill switch: `DRY_RUN=true` still permits capped read-only
  research, but never publishes demos / creates drafts / sends email.
- Per-run caps: `MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN`, `MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN`. Each call is
  counted, cost-estimated, logged (counts/cost/Place ID only — never content), and attributed to a run.

## How to enable it later (operator guide)
1. In Google Cloud, create a project and **enable "Places API (New)"**.
2. Create an **API key**; restrict it: application restriction (IP/referrer as appropriate) and **API
   restriction → Places API (New)** only.
3. Set a **billing budget + alerts** (e.g. a low monthly cap) so runaway usage is impossible.
4. Locally, in `.env` (never commit, never paste the key in chat):
   ```
   ENRICHMENT_CONTEXT_PROVIDER=google
   ALLOW_PAID_READS=true
   GOOGLE_PLACES_API_KEY=<your restricted key>
   MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN=1
   MAX_GOOGLE_CONTEXT_COST_USD_PER_RUN=0.10
   ```
5. **Test one lead** first: pick a single `READY_FOR_ENRICHMENT` lead and run
   `pnpm cli enrich-leads --campaign <name> --limit 1`. Confirm the run summary shows `google reads: 1` and a
   small estimated cost, and that only website-verified facts were written.
6. Raise the caps once satisfied. Standard tests and fresh installs keep `ALLOW_PAID_READS=false` and require
   no key.
