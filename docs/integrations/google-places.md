# Google Places API (New) — integration & data policy

**Status:** Phase 2 (discovery only). **Last verified against official docs:** 2026-07-11.

> **Current Stage 2 policy (migration 0018):** ID-only discovery remains unchanged. A later bounded Place
> Details read may persist only the approved operational identity subset with `google_places` provenance and
> retrieval timestamps. The returned website remains a candidate until independently verified. Phone requires
> separate approval; raw responses, ratings, reviews, and coordinates are not stored. This supersedes the
> older Stage 2/in-memory-only passages below.

## Endpoint & auth

- **Text Search (New):** `POST https://places.googleapis.com/v1/places:searchText`
- Auth header: `X-Goog-Api-Key: <key>`
- Field selection header: `X-Goog-FieldMask: <comma-separated fields>`
- Pagination: request `pageSize` (1–20, default 20); responses may include `nextPageToken`, sent back as `pageToken`.

## Two-stage strategy

**Stage 1 — discovery (Phase 2, implemented).** Field mask is **`places.id,nextPageToken` only.**
We request Place IDs and the pagination token — nothing else. This maps to the cheapest **Text Search
Essentials (IDs Only)** SKU and returns no display content to process or store.

**Stage 2 — enrichment (later phase, not built).** Richer Google fields (`websiteUri`,
`nationalPhoneNumber`, `rating`, `userRatingCount`, etc.) are Enterprise-tier. Any such context is processed
**in memory** only and must be corroborated by an **independent** public source (the official business
website) before it becomes a durable lead fact.

## Billing & cost control

- You are billed at the **highest SKU tier** among the fields in your field mask, so the mask is the primary
  cost control. Phase 2's IDs-only mask stays in the Essentials tier.
- Cost is estimated from a **local price table** (`src/integrations/lead-source/google-places/pricing.ts`,
  assumption A-0007). **These figures are placeholders** and must be reconciled against the official Google
  Maps Platform pricing for the account's region before any cost number is treated as authoritative.
- Cost/usage is recorded **once per request/page** in `source_requests` — never per candidate (one request
  can return many candidates).

## Data handling & retention (compliance)

Google Maps Platform terms restrict caching of Places content. This system therefore persists **no Google
Places content**.

**Stored permanently:** Place ID; internal IDs; provider; campaign & pipeline-run metadata; our request/query
parameters; field mask; timestamps; processing outcome; match decision; cost/usage metadata.

**Never persisted (processed in memory only, then discarded):** display name, formatted address, business
status, primary type, website URI, phone, rating, review count, and any normalized derivative of these.

**Coordinates:** latitude/longitude may be cached at most **30 days** and only in an explicitly temporary,
purge-on-expiry structure. **Phase 2 does not persist coordinates at all** — so no retention/purge obligation
arises in this phase. (The isolated `ephemeral_coordinates` mechanism is specified for a later phase if
cross-run proximity dedup is ever needed.)

**Durable facts** for a Google-sourced lead come later from an **independent** public source, stored with
`facts_source`, `facts_source_url` and `facts_captured_at`. `facts_source` is never `google_places`.

## Collection flow (Google path)

`discover Place IDs → dedup by Place ID (source_entities) → create Place-ID-only candidate lead → await
independent enrichment`.

## Respectful use

Public business data only; rate limiting (`PLACES_RATE_LIMIT_RPS`), per-request timeout
(`PLACES_TIMEOUT_MS`), bounded retries (`PLACES_MAX_RETRIES`). Real calls require `LEAD_SOURCE=google_places`,
`GOOGLE_PLACES_API_KEY`, and `DRY_RUN=false`; the default configuration performs no external calls.
