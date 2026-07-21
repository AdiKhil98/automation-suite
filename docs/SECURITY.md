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

> **Current policy (migrations 0018-0019):** ID-only discovery is unchanged. Approved Place Details fields may be
> persisted with `google_places` field-level provenance and retrieval timestamps before website verification.
> Candidate website facts are not official facts; manual/website facts are never overwritten by a Google
> refresh. Phone requires separate approval. Raw responses, authorization headers, ratings, reviews, and
> location-resolution coordinates are stored only in the dedicated normalized location cache/run records.
> This supersedes the older no-Google-content statements below.

### Bounded radius discovery

- `PROSPECT_DISCOVERY_ENABLED=false` and `PROSPECT_CONTINUE_PIPELINE=false` by default; real Places reads also
  require `ALLOW_PAID_READS=true` and a configured key.
- Operator niches resolve through a fixed allowlist. Nearby Search is one request, one page, maximum 20 IDs,
  with `places.id` as the complete field mask. Place Details remains one attempt per new candidate and never
  requests phone unless separately approved.
- Location-name resolution makes at most one Text Search request and caches only normalized location,
  formatted location, coordinates, provider, and timestamp. Entries older than 30 days are not reused;
  manual coordinates bypass resolution.
- Exact candidate order, internal lead binding, skip reason, and aggregate call counters are persisted. API
  keys, raw provider responses, response bodies, headers, and unrelated fields are not.
- Three consecutive matching or very-fast verifier failures trip a systemic circuit breaker; candidate-specific
  failures do not. No automatic provider or website retry exists.

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
- **Sanitized verification attempts:** DNS/TCP/TLS/HTTP/redirect/timeout/policy stage, allowlisted error code,
  HTTP status, redirect count, elapsed time, safe IP family, and retryability are stored. URLs are stripped of
  credentials, query strings, and fragments; headers, cookies, raw bodies, stacks, and recipient data are not.
- **Bounded crawl:** homepage + a small allowlist of contact/about/location pages (≤5, same-origin). No
  arbitrary crawling, form submission, authentication, or CAPTCHA handling. Full HTML is never persisted.
- **Contacts:** only publicly displayed `mailto:`/visible emails, `tel:`/visible phones, and real contact
  pages are stored. Guessed/generated email addresses are never stored. Operational status, ownership, and
  category are only stored with explicit evidence.
- **Paid reads vs outbound:** `ALLOW_PAID_READS` gates capped read-only research (e.g. Google Place Details)
  and is independent of the outbound kill switch. Google-derived context is in-memory only and never
  persisted (see docs/integrations/google-places-details.md; verified by an integration test).

## Website capture (Phase 5)

- **Browser isolation:** a fresh non-persistent context per lead **and per profile** (desktop/mobile) — no
  shared cookies, localStorage, sessionStorage, cache, permissions, or service workers. `serviceWorkers:'block'`,
  `permissions:[]`, `acceptDownloads:false`, downloads canceled+deleted, dialogs dismissed, popups closed and
  not followed. Page-script WebSocket and WebRTC are neutralized via an init script. No form submission, no
  auth, no CAPTCHA bypass. No browser profile or storage state is persisted.
- **Network policy on navigation:** request interception applies the SSRF guard to every request and validates
  the main-frame target + redirects against a Public-Suffix-List-aware `VerifiedOriginPolicy`; a cross-domain
  main-frame change is refused (never replaces the verified official domain).
- **Browser SSRF is not fully solvable by URL checks** (subresources, page `fetch`, browser DNS). Production
  captures run in a hardened, network-isolated container with an egress firewall — see
  docs/deploy/hardened-browser.md and DECISIONS D-0017. The local Windows browser is for controlled fixtures /
  dev only.
- **Artifacts:** screenshots are private internal evidence (content-addressed blobs under `.artifacts/`,
  git-ignored) — never served, never a Netlify asset. No full HTML, cookies, storage, or secrets persisted; no
  sensitive values in artifact paths.
- **Provider-data boundary:** capture targets only URLs already independently verified in Phase 4. No ephemeral
  Google context enters capture records, screenshots, logs, fingerprints, or events.
- **Chromium in-process sandbox (D-0022):** incompatible with `--cap-drop ALL` + `no-new-privileges`, so in the
  max-hardened container it is OFF (`CAPTURE_CHROMIUM_SANDBOX=false`) and the container + egress firewall are the
  boundary; it stays ON where the runtime supports it. Set explicitly in code (Playwright defaults it OFF).
  Verified by `deploy/verify-container.sh` (15 OS checks) and `deploy/verify-capture.mjs` (render + egress).

## AI website audit (Phase 6)

- **What is sent to OpenAI (and nothing else):** business facts already independently verified (name, category,
  city, official domain), bounded capture-evidence rows (type, source URL, truncated extracted text), and the
  primary desktop/mobile **viewport** screenshots. **Never sent:** API keys, env, DB IDs beyond evidence ids,
  full HTML, cookies/storage, Google-derived context, other leads' data, or full-page screenshots.
- **Untrusted-data boundary:** captured website text is labeled untrusted data in the prompts; the model has
  no tools; embedded instructions are never followed. Resistance is *verified deterministically* — the eval
  dataset plants injection payloads and graders assert the payload marker never appears in output and that no
  attacker URL is cited (URLs must canonicalize into the captured set).
- **Deterministic acceptance:** evidence-ID membership, canonical-URL checks, forbidden-claim/placeholder/
  prompt-leak denylists, reviewer-ref mapping — all enforced in code after every call. The model never sets
  scores or DB ids (temporary `findingRef` only; code generates UUIDs).
- **Paid-call gating:** real calls require `LLM_PROVIDER=openai` AND `ALLOW_PAID_LLM_CALLS=true` AND
  `OPENAI_API_KEY` AND a verified price for every model — otherwise the CLI refuses before touching any lead.
  Budgets: ≤4 calls/lead (2 generator + 2 reviewer attempts), run-level call+cost caps, per-lead cost cap.
  Every attempt (including failures) is persisted to `model_calls`. `store:false` — responses are not retained
  by OpenAI's API storage.
- **Recovery envelopes:** `.audit-tmp/` (git-ignored, mode 0600) holds paid results between call completion and
  DB persistence; replay is idempotent and never re-calls the model.

## Outbound safety

- Global kill switch `OUTBOUND_ACTIONS_ENABLED=false` blocks every sending integration regardless of state.
- Even when `true`, sending requires an approved lead state (`HUMAN_APPROVED`) and a passed review.
- Maintain a `suppression_list`. Unsubscribed leads can never re-enter a sending campaign; suppression
  overrides approval.

## Demos (Phase 8)

- **Local-only, human-gated:** demos are generated to a git-ignored `./demos/<leadId>/` and are
  `GENERATED_PENDING_REVIEW`; generation is separate from approval and nothing is published in
  Phase 8. `preview-demo` serves on **127.0.0.1 only** (never a public interface).
- **noindex everywhere:** every page has `<meta name="robots" content="noindex,nofollow,noarchive">`;
  `netlify.toml` carries an `X-Robots-Tag` noindex header for the later deploy phase. A visible
  concept-demo disclosure is always present; demos never impersonate the live site.
- **Untrusted facts / output security:** every lead fact is treated as untrusted — HTML-escaped,
  URLs allow-listed to http(s)/tel/mailto (javascript:/data: rejected), output paths traversal-safe.
  Generated pages carry a restrictive CSP and contain no scripts, forms, cookies, trackers, or
  external resource loads. XSS + malicious-fact fixtures cover this.
- **No fabrication / no copied assets:** content comes only from current verified facts (unknown
  sections omitted); CTAs never imply online booking without a verified booking URL. The template
  is our own (text-based name treatment, generic visuals) — no scraped logos/photos, no competitor
  assets, no cloning of the live site. Relational provenance links every rendered value to a fact.

## Dashboard (Phase 9+)

- Authentication is required before any remote deployment. No unauthenticated exposure of prospect data.

## Dependency & supply chain

- Every dependency must have a documented reason. Lockfile committed. No unnecessary infrastructure.

## Git hygiene

- `.gitignore` covers `.env`, `node_modules`, build output, coverage, Playwright artifacts, and local DB volumes.
- Never rewrite history; never force-push; never delete migrations.
