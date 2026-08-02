# Phase 7A — Verified Competitor Research Enrichment (Implementation Plan)

> **PLAN STATUS.** Sections 1–19 are the approved plan. Milestone **7A1 is now IMPLEMENTED**
> (deterministic candidate foundation, fixtures/CSV only) — see the banner below. Milestones
> 7A2–7A4 remain planning only and each require separate explicit operator approval per `CLAUDE.md`.

> **✅ 7A1 IMPLEMENTED (2026-08-01).** Migration `0029_competitor_research.sql` (additive: tables
> `competitor_research_runs`, `competitor_candidates`). Deterministic candidate selection with the
> EXACT approved 100-point model (§6.2), fixtures/operator-CSV providers only, one prospect at a
> time, DRAFT immutable/versioned runs, idempotent apply. **No** website capture, email-composer
> change (`competitor_evidence_used` stays `NONE`), AI scoring, live provider, Gmail/Sheets, or
> sending. CLI: `competitor-research-plan|run|review`. Flag `COMPETITOR_RESEARCH_ENABLED=false` by
> default. See `docs/OPERATIONS.md` for usage.

> **✅ 7A2 IMPLEMENTED (2026-08-02).** Migration `0030_competitor_evidence_capture.sql` (additive:
> tables `competitor_capture_runs`, `competitor_captured_pages`, `competitor_evidence_items`; and an
> additive widening of `capture_purpose_ck` to add `COMPETITOR_CAPTURE`). Narrow, reproducible
> presence/absence evidence captured from selected competitors' public pages via a **dedicated,
> non-lead-bound** `CompetitorCaptureService` (the lead-bound `CaptureService`/`website_capture_runs`
> are NOT reused — see the deviation note below). **15 deterministic evidence categories**, four-band
> observation kinds (`DIRECT_OBSERVATION` / `DETERMINISTIC_INTERPRETATION` / `UNSUPPORTED_INFERENCE`
> — the last is blocked by construction), HIGH/MEDIUM/LOW confidence, 30-day freshness (re-computed,
> never trusted), `safeForOutreach`, deterministic withholding, immutable/versioned runs, idempotent
> apply, no-raw-HTML retention, internal-only screenshots. Fixture mode (offline) is the default;
> live capture requires `COMPETITOR_CAPTURE_ENABLED=true` + `--provider playwright` +
> `--confirm-live-capture` and **never** falls back to fixtures. **No** comparative pattern,
> prospect-vs-competitor statement, email-composer change (`competitor_evidence_used` stays `NONE`),
> AI, Gmail/Sheets, or sending. CLI: `competitor-capture-plan|run|review|invalidate`. Flags
> `COMPETITOR_CAPTURE_ENABLED=false`, `COMPETITOR_CAPTURE_PROVIDER=fixture` by default.
>
> **✅ 7A3A IMPLEMENTED (2026-08-02).** Migration `0031_competitor_pattern_packages.sql` (additive:
> tables `competitor_pattern_packages`, `competitor_patterns`, `competitor_prospect_contrasts`,
> `competitor_pattern_evidence_refs`). Pure, deterministic pattern layer that turns SELECTED-competitor
> 7A2 evidence into immutable, versioned, source-traceable **pattern packages**: per-distinct-brand
> PRESENT/ABSENT/UNKNOWN classification, **PRESENT+ABSENT denominator** (missing data never negative).
> **Verified ABSENT requires an EXPLICIT, scoped negative observation** for an ABSENT-capable category
> (`PHONE_VISIBLE`, `BOOKING_CTA_VISIBLE`, `WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE`,
> `MOBILE_STICKY_CONTACT_CONTROL`) — "no item found", a bounded/partial capture, or a non-ABSENT-capable
> category is UNKNOWN, and site-wide absence is never inferred. Phase 7A2 stores only positive presence
> facts today, so **ABSENT never arises from live data and prospect contrasts are withheld** (the
> mechanism is honored if 7A2/prospect capture later emits scoped negatives). The `≥2` / `≥2/3` presence
> threshold (§6/§7); numeric depth medians (**never contrasted** — no verified prospect depth exists);
> **boolean prospect contrasts only for the operator-approved unambiguous mapping** (`PHONE_VISIBLE↔tel`,
> `WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE↔messaging-host link/mailto`, `BOOKING_CTA_VISIBLE↔cta/form`) and
> only with an **explicit, scoped verified prospect negative** (a missing primitive is never absence).
> Freshness is re-derived at generation, shown at review, and **re-checked at approval** (an APPROVED
> transition fails if supporting evidence became stale/superseded/invalidated/unsafe after the DRAFT).
> HIGH/MEDIUM/LOW confidence
> (contrast ≤ min(pattern, prospect)); anonymized count-bound wording; a **hard validator** that FAILS
> (never warns) on performance/revenue/conversion/ranking/volume claims, sample-of-one, missing source
> refs, missing-prospect-as-absence, count/wording mismatch, or competitor-name leakage. CLI
> `competitor-pattern-plan|run|review|approve|reject|invalidate`; flag `COMPETITOR_PATTERN_ENABLED=false`
> by default (dry planning/review always allowed; persistence + status changes require it). Approval is
> explicit, requires an operator identity, and never auto-approves. **Email enrichment remains
> unimplemented (Phase 7A3B):** `EmailBrief.competitorPackage` is untouched, `email-schema.ts` /
> `email-validation.ts` / prompts are untouched, and `competitor_evidence_used` stays `NONE`. **No** AI,
> network, Gmail, Sheets, email composition, or sending. **Prospect-mapping deviation:** the plan (§4/§8)
> anticipated richer prospect presence + depth contrasts; inspection showed the prospect side stores only
> low-level DOM primitives (`capture_evidence`: tel/cta/form/mailto/link…) and no verified nav depth, so
> per the "withhold rather than invent a mapping" rule only the three unambiguous boolean mappings above
> are wired and depth prospect-contrasts are withheld entirely (operator-approved 2026-08-02).
>
> **Deviation from this plan (§2.1/§11).** The plan assumed reuse of `CaptureService` +
> `website_capture_runs` via a new purpose. Inspection showed `CaptureService` is prospect-lead-bound
> (requires `READY_FOR_CAPTURE`, writes lead facts, transitions lead state) and
> `website_capture_runs.leadId` is a NOT-NULL FK to `leads`. Reusing either would file competitor
> evidence under the prospect lead. 7A2 therefore reuses only the low-level primitives
> (`BrowserCaptureProvider` mock/playwright, `VerifiedOriginPolicy`, `extractPage`, emulation
> profiles, DOM hashing) and adds dedicated tables. `capture_purpose_ck` is still additively widened
> with `COMPETITOR_CAPTURE` (per the approval), even though the dedicated tables carry their own
> purpose column. Max pages honors the plan-approved bound of **2** (not the larger figure floated in
> the 7A2 task prompt).

---

## 1. Executive summary

Phase 7A adds an **optional, default-off** capability: for a single already-qualified prospect,
identify **2–3 genuinely comparable nearby competitors**, capture **narrow, reproducible,
presence/absence evidence** from their public websites, and assemble an **immutable, versioned
competitor evidence package**. That package can later (behind its own flag) enrich a prospect's
outreach email with **anonymized, cautiously-worded comparative context** — e.g. *"Two nearby
clinics place booking and direct contact options prominently in the mobile header, while your
current contact path requires more navigation."*

The system exists to make emails **more specific and commercially relevant**, never to make
performance claims. Conversion, revenue, traffic, ranking, popularity, and customer-volume claims
are **prohibited by construction** — blocked in deterministic validation, not merely warned.

**The single most important repository finding:** the outreach system was **built anticipating this
feature**. The lead state `COMPETITOR_RESEARCH_READY` already exists; the email brief already
carries a `competitorPackage` slot (currently pinned `null`); the email writer schema already
carries `competitor_evidence_used` (currently pinned `'NONE'`); the reviewer already emits
`competitorClaimsSupported`; the evidence source-type enum already includes `'competitor_website'`;
and `docs/ROADMAP.md` §Phase 7 already specifies the intended schema, states, outcomes, and flags.
Phase 7A therefore **fills existing seams** rather than inventing a parallel architecture.

**Recommended first coding milestone:** **Phase 7A1** — schema/migration + deterministic candidate
selection + comparability scoring, mock/fixture provider only, no capture, no email change. This is
the smallest reviewable, fully-testable unit and unblocks everything downstream.

---

## 2. Repository findings

### 2.1 Components to reuse (do not rebuild)

| Concern | Existing component | Location | Reuse for 7A |
| --- | --- | --- | --- |
| Lead state `COMPETITOR_RESEARCH_READY` | `LEAD_STATUSES` | `src/domain/leads/status.ts:23` | Already present; add transitions + `COMPETITOR_RESEARCHED` (new) |
| Domain normalization / dedup | `normalizeDomain`, dedup helpers | `src/domain/leads/normalize.ts`, `src/domain/leads/dedup.ts` | Domain-key dedup + prospect-self exclusion |
| Registrable-domain origin policy (PSL-aware) | `VerifiedOriginPolicy` | `src/domain/capture/verified-origin.ts` | Enforce "same registrable domain" branch/self detection; never naive suffix match |
| Website verification (Phase 4) | `WebsiteVerifier`, `verify-domain.ts`, `scoreCandidate` | `src/domain/enrichment/verify-domain.ts`, `src/integrations/enrichment/provider.ts` | Only VERIFIED competitor official sites proceed to capture |
| Deterministic non-browser HTML extraction (cheerio) | `extractPage` | `src/domain/enrichment/extract.ts` | Lightweight presence/absence signal extraction; "No raw HTML is retained" invariant already honored |
| Browser capture (Playwright, mock default) | `CaptureService`, `BrowserCaptureProvider`, emulation profiles | `src/domain/capture/capture-service.ts`, `src/domain/capture/capture-types.ts` | Add `COMPETITOR_CAPTURE` purpose; reuse desktop+mobile profiles, ≤2 pages/competitor |
| Capture evidence extraction + fingerprinting | `extractCaptureEvidence`, `normalizedEvidenceFingerprint`, `rawDomHash` | `src/domain/capture/capture-evidence.ts` | Reproducibility hashing for competitor evidence |
| Evidence package builder pattern | `buildEvidencePackage`, `EvidencePackage` | `src/domain/audit/evidence-package.ts` | Model the competitor package builder on this (canonicalization, dedup, caps, versions) |
| Evidence source enum incl. `competitor_website` | `evidenceSourceTypeSchema` | `src/domain/evidence/evidence.ts:9` | Reuse existing enum value |
| Lead source discovery (Google Places, ID-only) | `GooglePlacesProvider`, `LeadSourceProvider` | `src/integrations/lead-source/google-places/`, `src/integrations/lead-source/provider.ts` | Candidate discovery provider (ID-only field mask, `ALLOW_PAID_READS`-gated) |
| Source identity idempotency anchor | `SourceEntity` (provider + Place ID) | `src/domain/lead-sources/source-entity.ts` | Competitor identity keyed on Place ID; no Google content persisted |
| LLM provider abstraction + Zod validation + cost caps | `LlmProvider`, `worstCaseCostUsd`, pricing guard | `src/integrations/llm/provider.ts`, `src/integrations/llm/pricing.ts` | Optional AI *wording* only (default off), reusing audit/email guard patterns |
| Email brief + writer/reviewer/validation | `EmailBrief.competitorPackage`, `competitor_evidence_used`, `competitorClaimsSupported`, `COMPETITOR_RE` | `src/prompts/email/index.ts:22`, `src/domain/email/email-schema.ts`, `src/domain/email/email-validation.ts` | Populate the existing seams; flip literal to enum; add competitor sentence provenance |
| Persistence: unit-of-work + repositories | `*-unit-of-work.ts`, `repositories/*.repo.ts` | `src/persistence/` | Add `competitor-research-unit-of-work.ts` + `competitor-research.repo.ts` |
| Drizzle schema + additive migration convention | `schema.ts`, `migrations/00NN_*.sql` | `src/persistence/schema.ts`, `migrations/` | Additive tables only; next free number `0029` |
| CLI convention (commander, `*Command` exports, `withContext`) | `src/cli/index.ts`, `src/cli/commands/*` | | Add competitor-research commands |
| Feature-flag env convention (`boolString(false)`, validated) | `env.ts` | `src/config/env.ts` | `COMPETITOR_RESEARCH_ENABLED`, `COMPETITOR_EMAIL_ENRICHMENT_ENABLED`, provider flag |
| Pipeline events / immutable notes | `NewPipelineEvent`, `pipelineEvents` | `src/domain/pipeline/`, `schema.ts` | Audit trail of research runs |

### 2.2 New components required

- Domain: `src/domain/competitor/` — candidate selection, comparability scoring, feature extraction,
  comparison-matrix logic, package builder, outcome taxonomy, validation.
- Prompts (only if optional AI wording milestone is approved): `src/prompts/competitor/`.
- Persistence: `competitor-research.repo.ts`, `competitor-research-unit-of-work.ts`; additive schema
  tables + migration `0029_competitor_research.sql`.
- CLI: `competitor-research-*.ts` commands.
- Integration provider: competitor candidate discovery provider (mock + Google Places adapter +
  operator-CSV adapter), plus a competitor capture wiring reusing existing capture provider.
- Config: new env flags + validation cross-checks.
- Tests + fixtures: `tests/unit/competitor/*`, `tests/integration/competitor/*`, fixture sites.

### 2.3 Architectural facts that constrain the design

- **`competitor_evidence_used` is currently `z.literal('NONE')`** (`email-schema.ts`). Enabling
  competitor enrichment requires widening this enum *behind a flag*, and updating the writer/reviewer
  prompts + `EMAIL_WRITER_JSON_SCHEMA`. This is a change to **existing working behavior** and must
  follow the `CLAUDE.md` "before changing existing working behavior" protocol (what/why/affected/rollback).
- **`COMPETITOR_RE` in `email-validation.ts` currently rejects any competitor language.** With a package
  present, validation must switch from "reject all competitor language" to "reject *unsupported* /
  *performance* competitor language, permit *anonymized supported* patterns." This is the most
  delicate change and gets its own milestone (7A3) with exhaustive tests.
- **Capture already forbids retaining raw HTML** and binds to a `VerifiedOriginPolicy`. Competitor
  capture must inherit both properties unchanged.
- **Google Places provider is discovery/ID-only** and persists no Google content. Competitor discovery
  must preserve this: store Place IDs only, never display name/address/coords from Google.

---

## 3. Proposed architecture

Deterministic pipeline of small modules, mirroring the existing phases. AI is optional and only
touches *wording*, never *similarity* or *facts*.

```
Qualified prospect (OPPORTUNITY_READY, gate passed)
        │
        ▼
[1] Candidate discovery (bounded)         provider: mock | google_places(ID-only) | operator_csv
        │   → CompetitorCandidate[]  (Place ID / domain / coarse location only)
        ▼
[2] Deterministic dedup + exclusion       drop self, branches, duplicates, non-eligible
        │
        ▼
[3] Website verification (reuse Phase 4)   only VERIFIED official competitor sites survive
        │
        ▼
[4] Comparability scoring (deterministic)  category/service/proximity/type/market → score+confidence
        │   → accept top 2–3 ≥ threshold; else NO_COMPETITORS / fallback
        ▼
[5] Public website evidence capture        purpose COMPETITOR_CAPTURE, ≤2 pages, desktop+mobile
        │   → presence/absence CompetitorEvidenceItem[]  (no raw HTML, screenshots internal-only)
        ▼
[6] Cross-competitor pattern logic         deterministic "2 of 3" counting + prospect contrast
        │
        ▼
[7] CompetitorEvidencePackage (immutable, versioned, hashed)
        │   selected + rejected(reasons) + evidence + patterns + safe angles + prohibited claims
        ▼
[8] Operator review / approval             package status: DRAFT → APPROVED | REJECTED
        │
        ▼
[9] (Separate flag) Email enrichment       optional comparative paragraph, provenance-traced,
                                           safe fallback to prospect-only, human approval unchanged
```

**Determinism ownership** (per `CLAUDE.md`): discovery bounds, dedup, exclusion, verification,
comparability arithmetic/thresholds, feature presence/absence, "2 of 3" counting, gap flags,
package hashing, and all validation are **deterministic code**. AI may *only* later assist with
phrasing a package's already-decided, already-safe angle — never invent similarity, presence, or impact.

---

## 4. Data flow

1. **Input:** one `leadId` in `OPPORTUNITY_READY` (or explicitly re-runnable). Deterministic
   justification gate reads Phase 6 opportunity score + comparison-relevant finding categories
   (`BOOKING_FRICTION`, `CONTACT_FRICTION`, `MOBILE_USABILITY`, `CTA_CLARITY`, `NAVIGATION`,
   `SERVICE_CLARITY`, `TRUST_SIGNALS`, `LOCAL_INFORMATION`). If not justified → outcome
   `NOT_JUSTIFIED`, no provider calls.
2. **Discovery** produces bounded `CompetitorCandidate[]` (≤ `MAX_CANDIDATES`). Provider is explicit;
   **no silent live→mock fallback** (a live-provider guard failure is a hard error, never a mock).
3. **Dedup/exclusion** removes the prospect itself (by verified registrable domain + Place ID),
   same-registrable-domain branches (unless `allowBranches`), duplicate domains, and ineligible
   entities (directory/marketplace/aggregator/social-only — detected deterministically).
4. **Verification** (reuse `WebsiteVerifier`) keeps only VERIFIED official competitor sites.
5. **Comparability** scores each survivor; accepts top 2–3 ≥ threshold with confidence bands.
6. **Capture** runs `COMPETITOR_CAPTURE` on accepted competitors (desktop+mobile, ≤2 pages each),
   extracts presence/absence evidence items with source URL, timestamp, method, confidence,
   freshness, `safeForOutreach`.
7. **Pattern logic** computes cross-competitor counts and prospect-vs-pattern contrasts deterministically.
8. **Package** is assembled, hashed, versioned, persisted immutably with `DRAFT` status.
9. **Review** transitions the package to `APPROVED`/`REJECTED`; lead → `COMPETITOR_RESEARCHED`.
10. **Email enrichment** (separate flag) consumes only an `APPROVED` package.

No step performs any outbound action. No step writes to Gmail or Sheets. No step sends email.

---

## 5. Schema proposal (additive only — migration `0029`, not created yet)

All tables `text` PKs (repo convention), FK `onDelete: 'cascade'` to `leads`, `withTimezone`
timestamps, CHECK constraints for enums (mirroring `capture_evidence_type_ck` style). **No existing
table is altered destructively.**

- **`competitor_research_runs`** — one row per research attempt.
  - `id`, `leadId`→leads, `runId`, `provider` (mock|google_places|operator_csv),
    `outcome` (CHECK against outcome taxonomy §6.4), `justificationReason`, `candidateCount`,
    `acceptedCount`, `rejectedCount`, `rulesVersion`, `comparabilityVersion`, `packageHash`,
    `packageVersion`, `startedAt`, `completedAt`. Index on `leadId`.
- **`competitors`** — stable competitor identity (Place-ID-only; **no Google content**).
  - `id`, `provider`, `sourcePlaceId` (nullable for CSV/mock), `normalizedDomain`,
    `officialWebsiteUrl`, `verificationStatus`, `firstSeenAt`, `lastSeenAt`.
  - Uniqueness: `(provider, sourcePlaceId)` and `(normalizedDomain)` idempotency anchors.
- **`competitor_candidates`** — per-run candidate consideration + disposition.
  - `id`, `researchRunId`→runs, `competitorId`→competitors (nullable pre-verify),
    `rawDomain`, `disposition` (ACCEPTED|REJECTED), `rejectionReason`, `comparabilityScore`,
    `comparabilityConfidence`, `comparabilityBreakdown` (jsonb of deterministic component scores),
    `distanceBucket`, `categoryMatch`. Index on `researchRunId`.
- **`competitor_evidence_items`** — narrow presence/absence facts.
  - `id`, `researchRunId`, `competitorId`, `captureRunId` (→ reuse `website_capture_runs`),
    `evidenceCategory` (CHECK §4-list), `sourcePageUrl`, `observation` (neutral text),
    `observationKind` (OBSERVED_FACT|DETERMINISTIC_INTERPRETATION|AI_WORDING|UNSUPPORTED_INFERENCE),
    `selector` (nullable), `sourceExcerpt` (nullable, bounded/redacted), `captureMethod`,
    `confidence`, `capturedAt`, `freshnessStatus` (FRESH|STALE|UNREPRODUCIBLE),
    `safeForOutreach` (bool). Index on `(researchRunId, competitorId)`.
- **`competitor_comparisons`** — per-dimension prospect-vs-competitors matrix.
  - `id`, `researchRunId`, `dimension`, `prospectState` (present|absent|unknown),
    `prospectEvidenceId` (→ existing lead evidence/audit finding), `competitorsPresentCount`,
    `competitorsTotalCount`, `gapFlag` (bool), `patternWording` (some|most|two_of_three|none),
    `rulesVersion`. **No numeric performance fields.**
- **`competitor_research_packages`** — immutable versioned package snapshot.
  - `id`, `researchRunId`, `leadId`, `version` (int), `hash`, `status` (DRAFT|APPROVED|REJECTED|SUPERSEDED),
    `safeAngles` (jsonb), `prohibitedClaims` (jsonb), `providerProvenance` (jsonb),
    `createdAt`, `supersededByPackageId` (nullable). Uniqueness `(leadId, version)`.
- **`competitor_package_approvals`** — approval/rejection audit (append-only).
  - `id`, `packageId`, `decision` (APPROVE|REJECT), `reviewer` (operator id/string), `notes`,
    `decidedAt`. Correction = new superseding row, never mutation.

**Idempotency:** a rerun for the same `(leadId)` inserts a new run + new package **version**;
prior versions remain (immutable history). Evidence supersession is additive: a stale/invalidated
evidence item is marked `freshnessStatus=STALE|UNREPRODUCIBLE` and a new item inserted, never deleted.

---

## 6. Domain contracts

### 6.1 `CompetitorCandidate` (discovery output)
`{ provider, sourcePlaceId|null, rawDomain, coarseLocation (bucket/region only, never precise PII), category|null }`
— **no Google display content**; coarse location only, never stored in URLs or Sheets.

### 6.2 Comparability model — APPROVED EXACT WEIGHTS (operator decision, 2026-08-01)

Deterministic, AI-free, 100-point model. **No weight may be invented or modified beyond this decision.**
Score is an integer 0..100; acceptance threshold is **70** (`MIN_COMPARABILITY = 70`).

**Pre-scoring gates (reject before any points are awarded):**
- no valid normalized business website/domain;
- outside the currently active radius (see proximity);
- category match is `WEAK` or `NONE` → `WEAK_CATEGORY_MATCH`;
- candidate is the prospect itself or an alternate prospect branch;
- duplicate / directory / marketplace / aggregator / social-only profile;
- supplied market clearly differs from the prospect's market → `MARKET_MISMATCH`.
- For a `RELATED` category match, require meaningful service overlap:
  `matchedServiceCount >= min(2, prospectSuppliedServiceCount)`, and **both** prospect and candidate
  must have ≥ 1 normalized supplied service. Otherwise → `INSUFFICIENT_SERVICE_OVERLAP`.
- A **language mismatch is NOT a rejection gate**.

**Exact 100-point allocation:**

| Component | Max | Rule |
| --- | --- | --- |
| Category match | **45** | exact primary = 45; approved related = 25; weak/none = gated out (never scored) |
| Service overlap | **20** | normalize+dedupe supplied service identifiers; **5 pts per unique overlapping service**, capped at 4 matches → 0/5/10/15/20 for 0/1/2/3/≥4 matches. Exact-category candidates may score 0 here; related-category must pass the overlap gate. No AI inference. |
| Geographic proximity | **15** | `≤5.0 km = 15`; `>5.0 && ≤10.0 km = 8`; `>10.0 km = reject`. The 10 km band is active **only** when fewer than two otherwise-valid candidates remain inside 5 km. Geography alone can never reach 70. |
| Business-type match | **10** | same supplied type = 10; known mismatch (e.g. independent vs chain) = 5; missing/unknown = 0. Mismatch is **not** auto-disqualifying. |
| Market & language | **10** | **Market:** same supplied = 6; missing/unknown = 0; confirmed different = reject (gate). **Language:** same supplied primary = 4; missing/unknown = 0; different = 0 (no reject). |
| Location-count similarity | **0** | **Not collected or scored in 7A1**; deferred entirely to a later milestone. |

**Acceptance rule — accept only when ALL hold:** `score >= 70` **and** category is `EXACT` or approved
`RELATED` **and** confidence is `MEDIUM` or `HIGH` **and** all pre-scoring gates passed. Score 69 rejects;
score 70 accepts.

**Confidence bands:**
- **HIGH:** category + coordinates + services (both prospect & candidate) + business type + market all supplied.
- **MEDIUM:** category + coordinates supplied, **and** at least one of {services, business type, market} supplied.
- **LOW:** anything below MEDIUM. **LOW candidates can never be accepted, regardless of score.**

Output: `comparabilityScore` (integer 0..100), `confidence` (LOW|MEDIUM|HIGH), `breakdown` (per-component
points persisted), `gateResults` (each gate persisted), `accepted`, machine- **and** human-readable
reasons. **No AI-only comparability decision — AI never sets these fields; no hidden defaults; identical
normalized input always yields the identical result.**

**Sanity examples (from approval):** exact 45 + 3 svc 15 + ≤5 km 15 + same type 10 + market 6 + lang 4 =
**95 accept**; exact 45 + 0 svc + ≤5 km 15 + unknown type/market/lang = **60 reject**; exact 45 + 0 svc +
≤5 km 15 + same type 10 = **70 accept** (confidence ≥ MEDIUM required); related 25 + 4 svc 20 + ≤5 km 15 +
same type 10 + market 6 + lang 4 = **80 accept**; a related candidate with only 1 matched service while the
prospect supplies ≥ 2 services fails the overlap gate.

### 6.3 `CompetitorEvidenceItem` (§4 fields, enforced by Zod)
Every item carries: competitor identity, competitor URL/domain, exact source page URL, evidence
category, factual observation, captured timestamp, capture method, confidence, source excerpt or
structured selector, freshness status, `safeForOutreach`, and `observationKind` distinguishing
**observed fact / deterministic interpretation / AI wording / unsupported inference**.

### 6.4 Outcome taxonomy (`CompetitorResearchOutcome`)
`RESEARCHED`, `NOT_JUSTIFIED`, `NO_COMPETITORS_FOUND`, `INSUFFICIENT_COMPARABLE` (< 2 valid),
`ALL_UNVERIFIED`, `ALL_STALE`, `CAPTURE_FAILED`, `BUDGET_BLOCKED`, `PROVIDER_GUARD_FAILED`,
`RATE_LIMITED`, `MANUAL_REVIEW_REQUIRED`. Terminal states never silently degrade to a weaker outcome.

### 6.5 `CompetitorEvidencePackage` (data contract §6 of brief)
`{ prospectId, researchRunId, version, hash, selectedCompetitors[], rejectedCandidates[{reason}],
comparability{score,confidence}, evidenceItems[], crossCompetitorPatterns[], prospectContrasts[],
safeOutreachAngles[], prohibitedClaims[], timestamps, providerProvenance, rulesVersion }`.
Immutable + versioned so any historical email traces to the evidence available when it was written.

---

## 7. Cross-competitor pattern logic (deterministic)

Rules, all in pure functions with unit tests:

- **Minimum sample:** a comparative statement requires **≥ 2 valid competitors** with ≥ min evidence
  confidence for that dimension. **No conclusion from a sample of one** (`NO_SAMPLE_OF_ONE`).
- **Counting:** `competitorsPresentCount / competitorsTotalCount` where "total" = competitors with a
  *reproducible observation for that dimension* (missing data is **excluded from the denominator**,
  never counted as negative evidence).
- **Wording selection** (deterministic map, not AI):
  - all present → `"All selected competitors ..."` / `two_of_three`/`most` per count;
  - 2 of 3 → `"Two of three comparable competitors ..."` or anonymized `"two nearby clinics ..."`;
  - < 2 present or mixed/ambiguous → **no comparative claim** for that dimension.
- **Prospect contrast** only when prospect state is a verified `present|absent` from its own audit
  evidence (never `unknown`). Contrast is structural (navigation depth, above-the-fold presence),
  never performance.
- **Forbidden outputs:** any ranking, "better/worse", or performance/volume language → excluded at
  this layer (defense in depth before validation).

---

## 8. Email-enrichment integration (Milestone 7A3 — touches existing working code)

**The prospect's own verified issue remains the primary basis of the email.** Competitor context is
additive and optional.

**Changes to existing files (follow "changing working behavior" protocol):**
- `src/prompts/email/index.ts` — populate `EmailBrief.competitorPackage` with an actual (approved,
  redacted, provenance-linked) package type instead of `null`; update writer/reviewer prompt text.
- `src/domain/email/email-schema.ts` — widen `competitor_evidence_used` from `z.literal('NONE')` to
  an enum (`NONE | ANONYMIZED_PATTERN | NAMED` — named likely disallowed in 7A), and add
  per-sentence competitor evidence provenance fields to the writer output. Bump `EMAIL_SCHEMA_VERSION`.
- `src/domain/email/email-validation.ts` — make `COMPETITOR_RE` conditional: with a package present,
  permit **anonymized, package-supported** patterns; **fail (not warn)** on any performance/volume/
  ranking claim, any competitor sentence lacking a package-evidence citation, or any named competitor.
- `src/domain/email/email-writer-service.ts` — pass the approved package into the brief; keep
  `safeFindings` primary; ensure fallback to prospect-only when package absent/unapproved.

**Proposed email structure:** (1) verified prospect observation → (2) relevant competitor pattern
*when available* → (3) cautiously-stated plausible consequence → (4) concrete recommendation/demo →
(5) one CTA.

**Requirements:** dedicated flag `COMPETITOR_EMAIL_ENRICHMENT_ENABLED` (default off); approved
package required; exact source traceability per comparative sentence; **safe fallback to
prospect-only**; no forced competitor paragraph; no competitor name required; anonymized wording
supported (*"two nearby clinics"*); human approval unchanged; no auto-send; email preview shows which
evidence supports each comparative sentence; **prohibited claims fail validation, not warn.**

**Wording examples:**
- ✅ Acceptable: *"Two nearby clinics place booking directly in the mobile header; on your site
  booking sits several taps deeper."*
- ⚠️ Requires caution (only if package-supported + cautious): *"This kind of friction can make it
  harder for a first-time visitor to reach booking."* (plausible-consequence, no metric)
- ❌ Prohibited (must fail validation): *"Your competitors convert better."* / *"You're losing
  patients to nearby clinics."* / *"Competitor X ranks above you."* / any % or volume claim.

---

## 9. Operator workflow & CLI (commander, matching `src/cli/index.ts` conventions)

Single-lead only in 7A. Every live-provider path requires an explicit confirmation flag and the
corresponding env flag; **dry-run / fixture is the default**.

| Command | Purpose | Guards |
| --- | --- | --- |
| `competitor-research-plan <leadId>` | Show justification gate result + discovery plan; no provider call | none (read-only) |
| `competitor-research-run <leadId>` | Execute discovery→comparability→capture→package (DRAFT) | `COMPETITOR_RESEARCH_ENABLED`; live provider needs `--confirm-live-provider` + `ALLOW_PAID_READS`; default mock/fixture |
| `competitor-research-review <leadId>` | Print package for human review (evidence + provenance + rejected reasons) | read-only |
| `competitor-research-package <leadId> --approve\|--reject` | Transition package status; lead → `COMPETITOR_RESEARCHED` | operator confirmation |
| `outreach-compose <leadId> --use-competitor-package` | Compose prospect-only or package-enriched email | `COMPETITOR_EMAIL_ENRICHMENT_ENABLED`; approved package; still human-review gated |

Behaviors: dry-run prints intended actions; `--fixture` forces local fixture provider;
rerun creates a new package version; rejected evidence is shown but never emailed; no bulk mode
(campaign-scoped execution is deferred to a later phase).

---

## 10. Privacy, legal & operational safeguards

- Public business information only; **no Google display content persisted** (Place IDs only).
- No personal-data enrichment beyond legitimately published business contact info.
- **No login bypass, no CAPTCHA bypass** (hard prohibition; matches global safety rules).
- No copying competitor creative assets, layouts, photos, or logos; **competitor screenshots are
  internal evidence only, never republished, never used in demos**.
- No false endorsement/affiliation; no defamatory or subjective criticism; neutral evidence-bound
  observations only.
- **No revenue/conversion/traffic/customer-volume/ranking claims** (blocked in code).
- Bounded requests + rate limiting (reuse `RateLimiter`); clear, honest user-agent (reuse capture
  emulation UA); no unrestricted search-engine crawling or broad internet scraping.
- Respect robots/access restrictions; cookie/login-gated content is **not** captured or asserted.
- Source attribution retained internally for every evidence item. **Freshness:** competitor evidence
  must be captured within **30 days** of any outreach use; older evidence is stale and requires
  recapture (Decision 7). **Retention:** source evidence + package versions retained **180 days** for
  auditability; hashes/provenance/outreach references retained beyond expiry where needed for historical
  traceability. Evidence supersession is additive, never destructive; superseded/invalidated evidence
  remains historically traceable and is never treated as active. Operator purge is a documented, logged
  maintenance path — not part of 7A1.

---

## 11. Database & state design

- **Additive migration `0029_competitor_research.sql` only.** No column of an existing table is
  altered or dropped. Capture reuses `website_capture_runs` via a new `COMPETITOR_CAPTURE` purpose
  value. **Confirmed:** `capture_purpose_ck` constrains `website_capture_runs.purpose` to
  `('AUDIT_CAPTURE','VERIFICATION_CAPTURE')` (`schema.ts:571`), so adding `COMPETITOR_CAPTURE` requires
  a constant update **and** an additive CHECK-widening migration — this lands in **7A2**, not 7A1
  (Decision 7).
- **State transitions** (extend `state-machine.ts`, additive):
  `OPPORTUNITY_READY → COMPETITOR_RESEARCH_READY → COMPETITOR_RESEARCHED → DEMO_DECIDED`.
  Not-justified / module-disabled leads skip unchanged (`OPPORTUNITY_READY → DEMO_DECIDED`), so the
  existing path is never broken. Add `COMPETITOR_RESEARCHED` to `LEAD_STATUSES`
  (`COMPETITOR_RESEARCH_READY` already exists).
- **Uniqueness/idempotency:** `(provider, sourcePlaceId)`, `(normalizedDomain)`, `(leadId, version)`.
- **Immutable history:** packages + approvals + evidence are append-only; corrections supersede.
- **Migration order:** schema constant additions in `schema.ts` → `0029` migration → repo + UoW →
  domain → CLI. Reverse script drops only the new tables (safe because additive).

---

## 12. Testing plan (fixture-only; **no paid calls, no network, no Gmail/Sheets**)

| # | Test | Layer |
| --- | --- | --- |
| 1 | Prospect excluded from its own competitors (domain + Place ID) | unit |
| 2 | Duplicate domains removed | unit |
| 3 | Branch/chain of same registrable domain handled (PSL-aware) | unit |
| 4 | Weak category match rejected (`WEAK_CATEGORY_MATCH`) | unit |
| 5 | Geographic mismatch rejected (`GEO_MISMATCH`) | unit |
| 6 | Fewer than two valid competitors → `INSUFFICIENT_COMPARABLE`, no email claim | unit |
| 7 | Stale evidence rejected / not send-safe | unit |
| 8 | Inaccessible / redirected / unreproducible source rejected | integration |
| 9 | Ambiguous evidence withheld | unit |
| 10 | Deterministic "2 of 3" counting correct | unit |
| 11 | Missing data excluded from denominator (not negative evidence) | unit |
| 12 | No sample-of-one comparison | unit |
| 13 | Prohibited performance/volume/ranking claim **fails** validation | unit |
| 14 | Anonymized competitor wording accepted when package-supported | unit |
| 15 | Every comparative sentence has package-evidence provenance | unit |
| 16 | Safe prospect-only fallback when no/unapproved package | unit |
| 17 | Live-provider guard failure never silently falls back to mock (`PROVIDER_GUARD_FAILED`) | integration |
| 18 | Idempotent rerun → new package version, prior version intact | integration |
| 19 | Package versioning + hash stability | unit |
| 20 | No sending, no Gmail mutation, no Sheet write occurs (assert absence) | integration |
| 21 | Capture retains no raw HTML; screenshots internal-only | integration |
| 22 | Justification gate: low-opportunity lead → `NOT_JUSTIFIED`, zero provider calls | unit |

Fixtures: local static competitor HTML pages (fixture provider), recorded Places ID-only responses,
mock capture provider. Reuse `tests/` structure (`unit` / `integration` / `browser`).

---

## 13. Milestone boundaries & acceptance criteria

Recommended split (smaller reviewable commits over one large drop):

- **7A1 — Schema + candidate selection + comparability.**
  Schema constants + migration `0029`, repo/UoW, discovery (mock/CSV + Google-Places ID-only adapter,
  guarded), dedup/exclusion, verification wiring, comparability scoring, outcome taxonomy, state
  additions. **No capture, no email change.** *Accept when:* `pnpm check` green; tests 1–6,12,17,18,
  19,22 pass; running against fixtures yields a DRAFT run with accepted/rejected candidates and
  reasons; no email code touched.
- **7A2 — Public website evidence capture.**
  `COMPETITOR_CAPTURE` purpose, presence/absence extraction, evidence items with freshness +
  `safeForOutreach`, evidence persistence. *Accept when:* tests 7–9,11,21 pass; captures produce
  reproducible evidence with hashes; no raw HTML retained; screenshots internal-only.
- **7A3 — Pattern generation + email enrichment.**
  Pattern logic, package builder (immutable/versioned/hashed), package review CLI, and the
  **existing-email-code changes** (schema/prompt/validation) behind `COMPETITOR_EMAIL_ENRICHMENT_ENABLED`.
  *Accept when:* tests 10,13–16,19,20 pass; prohibited claims fail (not warn); prospect-only fallback
  intact; preview shows per-sentence provenance; `EMAIL_SCHEMA_VERSION` bumped with migration/back-compat note.
- **7A4 — Controlled live validation (paid, operator-gated).**
  One real single-lead run with `--confirm-live-provider` + `ALLOW_PAID_READS`, cost-capped.
  *Accept when:* operator approves the gate; run stays within caps; package reviewed and approved
  manually; still no send.

Each milestone ends with the `CLAUDE.md` approval format (commit + annotated tag
`phase-7a1-…` … `phase-7a4-…`), then **stop for approval**.

---

## 14. Migration & rollback strategy

- **Migration:** single additive `0029_competitor_research.sql` for 7A1; a separate additive
  purpose-CHECK-widening migration in **7A2** (`capture_purpose_ck` **confirmed present**, so it is
  required, not conditional). Generated via `drizzle-kit` convention; never edits prior migrations.
- **Rollback:** module kill switch (`COMPETITOR_RESEARCH_ENABLED=false`, email flag off) disables all
  behavior with zero data change. Structural rollback = reverse script dropping only the new tables +
  `git reset --hard <phase-6 or prior 7A tag>`. Email-code rollback = revert the schema/prompt/
  validation commit; `competitor_evidence_used` returns to `'NONE'` literal, `COMPETITOR_RE` returns
  to reject-all. Because every table is additive and every flag defaults off, the existing MVP path
  is never at risk.

---

## 15. Operator decisions — RESOLVED

> All seven Phase 7A operator decisions are **RESOLVED** with the operator-supplied defaults below.
> The repository was inspected for contradictions; **none were found** — two defaults were, in fact,
> *confirmed* by the code (capture-purpose CHECK exists → migration needed in 7A2; Places-shaped
> `CollectQuery.locationBias` contract exists → reusable for fixtures/CSV without live calls).

| # | Decision (RESOLVED) | Available options | Recommended choice (approved) | Reason | Effect on later milestones | Affects 7A1 now? |
| --- | --- | --- | --- | --- | --- | --- |
| **1** | **Discovery provider** | (a) fixtures + operator CSV only; (b) also live Google Places in 7A1; (c) live only | **7A1: fixtures + operator CSV only**, reusing existing Google-Places-shaped identifiers/data contracts (`CollectQuery`, Place-ID identity) where useful; **no live Places calls**. Live validation later uses the **existing approved Places integration** behind an explicit provider flag + explicit live confirmation, **never silently falling back to mocks**. | Keeps 7A1 fully offline, free, deterministic, and CI-safe while still exercising the real data contracts. Live cost/risk is deferred to an explicitly-gated milestone. Matches existing `google_places` ID-only + `ALLOW_PAID_READS` invariants. | 7A2 unaffected (capture-side). 7A4 = first and only live provider use, `--confirm-live-provider` + `ALLOW_PAID_READS`, hard-fail (no mock fallback) on guard failure. | **Yes** — defines 7A1 providers (mock/CSV) + the `provider` column + no-silent-fallback guard. |
| **2** | **Geographic relevance** | radius fixed vs configurable; single vs expandable radius | **Primary radius 5 km**; **expandable fallback to 10 km only when < 2 valid competitors**; **store actual calculated distance** (not just a bucket); radius **remains configurable per market/category**; **geography alone never accepts** a competitor. | Urban-market sane defaults; the bounded expansion prevents empty result sets without inviting far-afield noise; storing real distance preserves auditability and lets thresholds be tuned later. | 7A2/7A3 patterns cite proximity as one supporting (never sole) signal. Config surface reused by later per-niche tuning. | **Yes** — comparability scoring + `distance`/`radius` fields + config live in 7A1. |
| **3** | **Category & comparability threshold** | AI vs deterministic; threshold value | **Deterministic 100-point model with EXACT approved weights (see §6.2, operator decision 2026-08-01):** category 45 (exact) / 25 (related-with-overlap-gate); service overlap 20 (5/match, cap 4); proximity 15 (≤5 km) / 8 (≤10 km) / reject; business-type 10/5/0; market 6 + language 4; location-count 0 (deferred). **Accept iff score ≥ 70 AND category EXACT/RELATED AND confidence ≥ MEDIUM AND all gates pass.** No AI, no hidden defaults. | Fully reproducible and operator-explainable; pre-scoring gates prevent weak-category/wrong-market/branch candidates; proximity (max 15) can never reach 70 alone. Honors `CLAUDE.md` "AI must never do what deterministic code can." | 7A3 AI may only *word* an already-decided, already-safe angle — never set comparability. Weights + threshold constants reused unchanged. | **Yes** — the whole comparability model + exact weights + threshold + reason exposure is built in 7A1. |
| **4** | **Branch & chain policy** | exclude all chains vs allow with cap | **Exclude the prospect itself and alternate listings of the same business**; competitors may be **independent OR chains**; **max one branch per competing brand by default**; **prevent one chain dominating** the set; **retain branch + parent-brand identity internally**. | Avoids a skewed comparison set dominated by one brand's branches while still allowing legitimate chain competitors; self/branch exclusion reuses the PSL-aware `VerifiedOriginPolicy`. | 7A3 pattern counts stay meaningful (distinct brands, not duplicate branches). Internal brand identity retained for traceability. | **Yes** — dedup/exclusion + one-branch-per-brand cap + internal brand identity are 7A1 selection logic. |
| **5** | **Competitor naming in outreach** | anonymized default vs named default | **Retain exact competitor identities + URLs internally** for traceability; **default external email wording to anonymized** ("two nearby clinics"); **named references require separate human approval**; **no competitor logos, photos, creative assets, or copied layouts**. | Anonymized wording is commercially sufficient and legally safest; naming is an opt-in behind explicit human approval; internal identity preserved for provenance. | 7A3 email enrichment defaults to anonymized; a named path (if ever) is a distinct, separately-approved sub-feature. No asset copying at any milestone. | **No** — no email/wording code in 7A1; identities are stored internally, wording rules apply at 7A3. |
| **6** | **Email schema version** | change in 7A1 vs defer to 7A3 | **7A1 must NOT change the shipped email schema**; **`competitor_evidence_used` stays `NONE` through 7A1 and 7A2**; **widen the schema + bump `EMAIL_SCHEMA_VERSION` only in 7A3**; **prospect-only emails stay compatible**; **enrichment stays optional**. | Protects shipped, working email behavior until the enrichment path is actually built and tested; isolates the one risky change to a single milestone with back-compat tests. | 7A3 owns the `email-schema.ts` / prompt / validation change + version bump; earlier milestones touch zero email code. | **No** — explicitly *forbids* email changes in 7A1 (a boundary, not a build item). |
| **7** | **Capture purpose & retention** | — | **Add `COMPETITOR_CAPTURE` only when 7A2 begins**, via an **additive migration** (the DB CHECK **exists** — see below — so a migration **is** required); **do not change it in 7A1**. **Freshness:** competitor evidence must be captured **within 30 days** of outreach use; **older = stale, cannot support an email without recapture**. **Retention:** retain source evidence + package versions **180 days** for auditability; retain **hashes/provenance/outreach references after expiry** where needed for historical traceability; **superseded/invalidated evidence stays historically traceable and is never treated as active**. | Confirmed by inspection: `capture_purpose_ck` constrains `website_capture_runs.purpose` to `('AUDIT_CAPTURE','VERIFICATION_CAPTURE')`, so `COMPETITOR_CAPTURE` needs both a constant update and an additive CHECK migration. 30-day freshness keeps claims current; 180-day retention balances auditability with data minimization; append-only supersession preserves immutable history. | 7A2 ships the additive capture-purpose migration + 30-day freshness gating on evidence. Retention/expiry + supersession semantics land in 7A2 (evidence) / 7A3 (packages); a logged purge/maintenance path is documented later. | **No** — no capture and no purpose change in 7A1; freshness/retention rules take effect from 7A2. |

**Repository confirmations (no contradictions found):**
- `capture_purpose_ck` CHECK **exists** (`src/persistence/schema.ts:571`, values in
  `src/domain/capture/capture-outcome.ts:4`) → Decision 7's migration requirement is **confirmed**, lands in 7A2.
- `CollectQuery.locationBias?: unknown` **exists** (`src/integrations/lead-source/provider.ts:31`) →
  Decision 1's "reuse Places-shaped contracts without live calls" is **feasible** in 7A1.
- `competitor_evidence_used: z.literal('NONE')` **confirmed** (`src/domain/email/email-schema.ts`) →
  Decision 6's "stays NONE through 7A2" holds with no code change.

---

## 16. Risks & contradictions found in the current architecture

- **`competitor_evidence_used: z.literal('NONE')` is a hard wall.** Widening it is a change to shipped,
  working email behavior and a schema-version bump — must follow the change-control protocol and ship
  in its own milestone (7A3) with back-compat tests. *Highest-attention item.*
- **`COMPETITOR_RE` currently rejects all competitor language.** The enrichment must invert this to
  "reject unsupported/performance, allow anonymized-supported" without loosening the performance-claim
  guard. Risk of accidentally weakening a safety gate — mitigated by keeping performance/volume/ranking
  regex rejections unconditional and adding positive tests for both allow and deny paths.
- **Google Places is ID-only by design.** Comparability needs category/location signals; these must
  come from **verified public competitor pages** or operator CSV, **not** by widening the Places field
  mask (which would persist Google content and violate the existing invariant).
- **Capture purpose enumeration is CHECK-constrained** (`capture_purpose_ck`) — **confirmed**; adding
  `COMPETITOR_CAPTURE` requires an additive migration in 7A2 (Decision 7 resolved).
- **Scope creep toward bulk/campaign** — explicitly out of 7A; single-lead only.

All seven operator decisions are **RESOLVED** in Section 15; no open contradictions remain.

---

## 17. Estimated files/modules affected (implementation, not done here)

**New (~):** `src/domain/competitor/` (candidate-selection, comparability, feature-extraction,
pattern, package-builder, outcome, validation, types) ≈ 8 files; `src/persistence/
competitor-research.repo.ts` + `competitor-research-unit-of-work.ts`; `migrations/0029_competitor_research.sql`;
`src/integrations/competitor/` discovery provider(s) (mock/csv/places-adapter) ≈ 3 files;
`src/cli/commands/competitor-research-*.ts` ≈ 4 files; `src/prompts/competitor/` (7A3, if AI wording
approved); tests + fixtures ≈ 10+ files.
**Modified (additive/behind flags):** `src/domain/leads/status.ts`, `src/domain/leads/state-machine.ts`,
`src/persistence/schema.ts`, `src/config/env.ts`, `src/cli/index.ts`; **(7A3, working-code change)**
`src/prompts/email/index.ts`, `src/domain/email/email-schema.ts`, `src/domain/email/email-validation.ts`,
`src/domain/email/email-writer-service.ts`; docs: `ROADMAP.md`, `CURRENT_STATUS.md`, `DECISIONS.md`,
`RISK_REGISTER.md`.

---

## 18. Recommended first coding milestone

**Phase 7A1 — schema/migration + deterministic candidate selection + comparability scoring, using
mock/fixture (and operator-CSV) providers only.** No capture, no email change, no live provider, no
paid call. It is the smallest fully-testable unit, establishes the immutable data model, and unblocks
7A2/7A3 without touching any shipped working behavior.

**Confirmed Phase 7A1 boundaries (approved):**
- ✅ schema + deterministic candidate-selection foundation only
- ✅ fixtures and operator CSV only
- ✅ one prospect at a time
- ✅ **no** competitor website capture
- ✅ **no** email-composer changes (`competitor_evidence_used` stays `NONE`)
- ✅ **no** AI scoring (comparability is 100% deterministic)
- ✅ **no** live APIs
- ✅ **no** Gmail or Sheets activity
- ✅ **no** sending
- ✅ **no** broad scraping

---

## 19. Confirmation of no side effects

During the creation of this plan, the following did **not** occur:

- ❌ No production code was written or modified.
- ❌ No migration was created or run.
- ❌ No network request, live website access, or live API call was made.
- ❌ No Gmail access, Google Sheets write, or email send occurred.
- ❌ No outreach record was modified.
- ❌ No commit, tag, push, or other Git operation was performed.
- ❌ `AGENTS.md` was not touched.
- ✅ Read-only inspection of the repository and creation of this single planning file only.
```
