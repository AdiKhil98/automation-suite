# Phase 7A4 — Synthetic End-to-End Email Quality Validation (Planning)

> **STATUS: Phase 7A4A APPROVED for implementation (2026-08-03).** The plan below is approved. The
> operator recorded Decision D1 and Decision G1 (see §0) and the exact rubric point allocation (see §6.1).
> Phase 7A4A (offline synthetic harness) is authorized. 7A4B (live-model advisory) and 7A4C (operator
> go/no-go) remain unapproved. This validation is fixture-only and offline: no live website, real prospect,
> live AI model, Gmail, Sheets, draft, send, migration, or production-DB write.

## 0. Approved operator decisions (2026-08-03)

### Decision D1 — Offline pipeline architecture (APPROVED)

Use the **real Phase 7 domain services with in-memory adapters** (in-memory repositories implementing the
same production ports). The validation flow MUST execute, in order:

1. actual Phase 7A1 candidate normalization, scoring and selection (`CompetitorResearchService`),
2. actual Phase 7A2 fixture capture + deterministic evidence rules (`CompetitorCaptureService` +
   `MockCaptureProvider` + `deriveCompetitorObservations`),
3. actual Phase 7A3A pattern generation (`CompetitorPatternService.build/run`),
4. actual package validation + explicit synthetic operator approval (real `validatePackage` +
   `isApprovableConfidence` + live-state freshness recheck; status set DRAFT→APPROVED in the in-memory
   pattern store by a named synthetic operator),
5. actual Phase 7A3B baseline + enriched composition (`planEnrichment` + `composeEnrichedEmail`),
6. actual final validators, traceability + message hashing (`validateEnrichedComposition`,
   `composedMessageHash`, package-hash re-match),
7. deterministic baseline-vs-enriched scoring (new rubric).

Prohibited: manually constructing a final approved pattern package; manually constructing the enriched
claim ledger; bypassing package approval; writing synthetic records into Supabase; requiring PostgreSQL for
the normal validation run. A guarded PostgreSQL integration test MAY be added behind the existing
`outreach_test` protections but MUST NOT be required for fixture execution.

### Decision G1 — Explicit synthetic prospect negative (APPROVED, this fictional validation only)

The fixture MAY contain an explicit scoped negative observation proving the fictional prospect lacks a
booking CTA in the defined mobile initial viewport. It MUST enter through the **prospect-evidence
fixture/input boundary** (mapped into `ProspectEvidenceInput.negatives` + capture identity/timestamp),
never injected directly into the pattern package, the prospect contrast, the composer, or the final email.
The synthetic negative record carries: category, explicit `ABSENT` polarity, inspection scope, viewport,
synthetic source/capture identifier, captured timestamp, confidence, rule version, and deterministic
locator/check metadata. Absence is NEVER inferred from a missing row, an empty detector, an uncaptured
page, or bounded-capture limits. The observation and all related sources are clearly labeled synthetic.

---

## 1. Executive summary

Phase 7A3B added deterministic competitor-pattern enrichment to the email pipeline. Today its guarantees
are proven by unit tests over individual functions and by the `outreach-compose-preview` CLI, but there is
**no single artifact that demonstrates, side by side, that an enriched email is materially better than the
prospect-only baseline while remaining fully evidence-backed.** Phase 7A4 closes that gap.

7A4 designs a synthetic, offline, fixture-only harness that:

1. Builds one entirely fictional dental-clinic scenario (prospect + three comparable clinics + synthetic
   evidence), and drives it through the **actual** 7A1 → 7A2 → 7A3A → 7A3B code path — never a hand-built
   final package.
2. Composes **two** final email artifacts that differ only by the approved competitor enrichment: a
   prospect-only **baseline** and an **enriched** version built from the same prospect issue,
   recommendation, CTA, language, and base draft.
3. Runs every existing deterministic **safety** validator plus a new deterministic **100-point quality
   rubric** over both artifacts.
4. Produces one structured comparison report (baseline vs enriched, claim ledger, rubric scores, hard-gate
   results, PASS / REVISE / FAIL).

Safety is never traded for quality: a single hard-gate failure forces FAIL regardless of score.

The default execution is **fixture-only and offline** — zero network, zero DB writes, zero live model, zero
Gmail/Sheets. A later, separately-approved mode may add advisory live-model critique; it is planned here but
neither implemented nor run.

**Recommended split:** 7A4A (offline harness) → 7A4B (guarded live-model advisory run) → 7A4C (operator
review & go/no-go). Only **7A4A** is the subject of the first coding milestone, and only after explicit
approval.

---

## 2. Repository findings

Confirmed by inspection of the current tree (commit `4eea329`). No component below is assumed — each was
located in the repo.

### 2.1 The enrichment path already exists and is pure

- `src/domain/email/competitor-enrichment.ts` — `planEnrichment(req) → EnrichmentOutcome`,
  `isEnrichablePattern`, `buildCompositionSections`, `renderEnrichedBody`, `buildClaimLedger`,
  `validateEnrichedComposition(finalBody, plan, pkg, ledger) → { ok, violations[] }`. Pure, no I/O, no AI.
  `COMPETITOR_ENRICHMENT_RULES_VERSION = competitor-email-enrichment-2026-08-03`.
- `src/domain/email/competitor-email-composer.ts` — `composeEnrichedEmail({ prospectDraft, emailInputs,
  validationCtx, plan, pkg }) → ComposedEnrichedEmail`. Flips `competitor_evidence_used` to
  `APPROVED_COMPETITOR_PATTERN_PACKAGE` **on the final artifact only**, re-runs schema + base copy gate +
  enriched-body validator, builds the claim ledger, and computes the canonical `composedMessageHash`
  (stable-key JSON, SHA-256).
- Final schema: `EMAIL_SCHEMA_VERSION = email-copy-schema-3`; `competitor_evidence_used ∈ {NONE,
  APPROVED_COMPETITOR_PATTERN_PACKAGE}` (`src/domain/email/email-schema.ts`).
- `validateEnrichedComposition` already encodes most of the required hard gates: competitor/consequence
  sentence must appear verbatim; exact count wording/form preserved; consequence must come from the fixed
  `CONSEQUENCE_TEMPLATES` table; identity-token/domain leakage fails; prohibited performance/volume/ranking
  terms fail; comparative traceability (pattern id + competitor evidence refs + contrast refs) required.

### 2.2 The 7A1–7A3A production path is reusable and DI-friendly

- `src/domain/competitor/` — `research-service.ts`, `scoring.ts`, `selection.ts` (7A1);
  `capture-service.ts`, `capture-eligibility.ts`, `evidence-*.ts` (7A2);
  `pattern-{eligibility,logic,confidence,wording,hash,validator,service}.ts` (7A3A).
- `CompetitorPatternService` takes injected `PatternServiceDeps` (`pattern-service.ts:96`) — so the pattern
  layer can be driven with **fixture/in-memory deps**, exactly as the plan requires.
- `src/cli/commands/competitor-pattern-build.ts` exposes `resolvePatternInput`, `reconstructPackage`, and
  `recheckSupportingEvidence(ctx, pkg, now)` — the composition-time revalidation the harness must exercise.
- `outreach-compose-preview.ts` is the working reference for how a persisted approved package becomes an
  `EnrichmentPackage` (identity-token derivation, `reconstructPackage`, `planEnrichment`,
  `composeEnrichedEmail`).

### 2.3 There is a deterministic eval-harness precedent to copy

- `src/evaluation/audit/` — `eval-cases.ts`, `graders.ts` (`GradeResult { name, pass, detail }`, all
  reproducible from recorded output — "Gate B decisions are made from these, never vibes"), `eval-runner.ts`
  (budget-capped combo runner, cost accounting, per-case report). **This is the structural template for the
  7A4 rubric + report**: deterministic boolean/points checks, no model-graded scores in the default mode.

### 2.4 Mock/provider + fixture conventions

- `src/integrations/llm/provider.ts` (`LlmProvider`, `.name`), `src/integrations/llm/mock-llm.ts`,
  `src/fixtures/mock-email-responses.ts` (`defaultMockEmailResponder`), `mock-composer-responses.ts`. The
  eval runner already branches on `provider.name !== 'mock'` for the paid path — the pattern for
  "no automatic fallback from live to mock" is established.
- `src/fixtures/*` (`sample-leads.ts`, `mock-capture-pages.ts`, `mock-audit-responses.ts`,
  `mock-enrichment.ts`) and `fixtures/competitor-capture/example.json` are the fixture homes.
- `tests/support/collection-memory.ts` and `tests/support/outreach-memory.ts` are existing **in-memory
  repository** helpers — precedent for the fixture-only persistence approach.

### 2.5 Guarded-live and test-DB precedents

- `demo-v2-review-loop-live.ts` and Gate A/B are the precedent for a separately-approved, explicitly-flagged
  live-model path with no silent fallback.
- Integration tests run only against the loopback `outreach_test` DB, gated by
  `src/persistence/test-database-guard.ts`. The operational Supabase `DATABASE_URL` is never used by tests.
- `.local-data/` and `eval-reports/` are already git-ignored (`.gitignore:31,36`) — natural homes for
  synthetic artifacts.

### 2.6 Gaps / constraints found (must shape the design)

- **G1 — Live data never produces ABSENT or contrasts today.** 7A2 stores only positive presence facts, so
  verified-ABSENT and prospect contrasts never arise from live data (`CURRENT_STATUS.md`, 7A3A/7A3B notes).
  The synthetic fixture may inject **explicit, scoped negative** prospect evidence to exercise the contrast
  path; this is legitimate for a fictional fixture and does not change production behavior.
- **G2 — Enrichment is English-only in 7A3B.** German/Hebrew leads fail closed. 7A4 is therefore
  **English-only** (matches the brief). Localization is a separate later milestone.
- **G3 — The composer consumes an `EnrichmentPackage` + `EnrichmentPlan`, not raw evidence.** To satisfy
  "exercise the full path, not a hand-built final package", the harness must derive the package by running
  the real `pattern-eligibility`/`pattern-logic`/`pattern-confidence`/`pattern-wording`/`pattern-hash`
  functions over fixture evidence — the wordingText/counts must come from the 7A3A logic, not be typed by
  hand. **Decision D1** (below) picks how: pure-function assembly vs in-memory repositories.
- **G4 — There is no existing quality rubric or side-by-side report module** for emails. Both are new
  (§14 expected files). The graders/eval-runner shape is reused, not the audit-specific logic.

---

## 3. Reusable vs new components

| Concern | Reuse (do not rebuild) | New (7A4) |
|---|---|---|
| Candidate selection | `research-service`, `scoring`, `selection` | fixture provider input |
| Evidence capture | `capture-service`, `evidence-*` | synthetic fixture pages/evidence |
| Pattern package | `pattern-{eligibility,logic,confidence,wording,hash,validator,service}` | fixture deps / assembly |
| Revalidation | `recheckSupportingEvidence`, `reconstructPackage`, `resolvePatternInput` | fixture-clock wrapper |
| Composition | `planEnrichment`, `composeEnrichedEmail`, `validateEnrichedComposition` | none |
| Base email draft | `email-render`, `email-validation`, `email-schema`, `defaultMockEmailResponder` | deterministic base fixture |
| Harness shape | `evaluation/audit/graders.ts` + `eval-runner.ts` pattern | `email-quality-rubric.ts`, `validation-runner.ts` |
| Report | eval report JSON convention | `validation-report.ts` (typed report + renderer) |
| Persistence (opt.) | `tests/support/*-memory.ts`, `outreach_test` guard | in-memory competitor/email repos for the harness |
| CLI | commander registration in `src/cli/index.ts`; `outreach-compose-preview` shape | three new commands (§9) |

---

## 4. Synthetic scenario (entirely fictional, English)

**Business:** a single-location general dental clinic. No real name, domain, person, address, phone, or
review. All identifiers use reserved example forms (`*.example`, `+1-555-01xx`, "Clinic A/B/C").

**Prospect (the target):**
- Verified prospect audit finding: **`BOOKING_FRICTION`** — no discoverable online-booking CTA on mobile;
  booking requires a phone call found only in the footer. `safeForOutreach = true`, HIGH confidence.
- Explicit **scoped negative** prospect evidence for the mapped low-level primitive (`BOOKING_CTA_VISIBLE` ↔
  cta/form) so the contrast path is genuinely exercised (see G1). This is fixture-injected, clearly synthetic.
- One clear recommendation (add a mobile-visible booking CTA) and one CTA (a short reply/booking-of-a-call).

**Three comparable clinics** (fictional, same city, within the 5 km radius, same category — general
dentistry): Clinic A, Clinic B, Clinic C.
- **≥2 of 3** present a visible mobile booking CTA (`BOOKING_CTA_VISIBLE`, `DIRECT_OBSERVATION`/
  `DETERMINISTIC_INTERPRETATION`, HIGH/MEDIUM, FRESH, `safeForOutreach`), yielding a valid
  `MAJORITY_OBSERVED` (2/3) or `ALL_OBSERVED` (3/3) presence pattern with `usableDenominator ≥ 2`.
- Synthetic HTML/evidence only; content hashes stored, **no raw HTML retained**, no screenshots, no copied
  external assets.

This gives: one exact prospect issue, ≥2 comparable competitors, a valid 2-of-3/3-of-3 pattern, an explicit
scoped prospect negative, HIGH or MEDIUM confidence, a cautious consequence label (`BOOKING_DISCOVERABILITY`
— note it avoids the word "immediately" per the existing fake-urgency gate), one recommendation, one CTA.

**Alignment used:** `BOOKING_FRICTION` → `BOOKING_CTA_VISIBLE` (from the approved
`AUDIT_TO_EVIDENCE_ALIGNMENT` map). A second scenario variant (`CONTACT_FRICTION` → `PHONE_VISIBLE` /
`WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE`) is planned as an optional fixture to cover the direct-contact path.

---

## 5. Complete data flow (fixture-only)

```
[synthetic prospect + verified prospect evidence fixture]
        │
        ▼
(1) 7A1 candidate selection  ── research-service/scoring/selection ──► 3 selected candidates
        │
        ▼
(2) 7A2 evidence capture     ── capture-service/evidence-* (fixture pages) ──► competitor evidence items
        │
        ▼
(3) 7A3A pattern generation  ── pattern-eligibility/logic/confidence/wording/hash ──► DRAFT package
        │
        ▼
(4) synthetic operator APPROVAL ── pattern-validator + recheckSupportingEvidence ──► APPROVED package (hash frozen)
        │
        ├───────────────────────────────┐
        ▼                               ▼
(5) prospect-only compose          (6) enriched compose
    (mode = NONE, schema-3-shaped)     planEnrichment → composeEnrichedEmail
    same base draft, issue,            (mode = APPROVED_COMPETITOR_PATTERN_PACKAGE)
    recommendation, CTA, language      reuses the SAME base draft
        │                               │
        └───────────────┬───────────────┘
                        ▼
(7) deterministic validation of BOTH artifacts
    ── schema-3 + base copy gate + validateEnrichedComposition (enriched) + hard safety gates (§7)
                        ▼
(8) deterministic quality rubric (§6) over BOTH artifacts
                        ▼
(9) side-by-side comparison + score delta
                        ▼
(10) validation report (§8) → PASS / REVISE / FAIL   [written to .local-data/phase-7a4/, git-ignored]
```

Both compositions consume the same `EmailInputs`/`validationCtx` and the same base prospect draft (a fixed
deterministic base email, or `defaultMockEmailResponder` output pinned by fixture), so the **only** material
difference is the approved enrichment.

**Decision D1 (persistence style for stages 1–4).** Two viable approaches:
- **D1a — pure-function assembly (recommended for 7A4A):** drive the real pattern pure-functions directly
  over fixture evidence to produce the package + hash, and represent "APPROVED + revalidated" by running
  `pattern-validator` and a fixture-clock `recheckSupportingEvidence`-equivalent. No DB. Fastest, fully
  offline, still uses production logic (not a hand-built wordingText).
- **D1b — in-memory repositories:** implement thin in-memory repos (mirroring `tests/support/*-memory.ts`)
  behind `PatternServiceDeps` and the pattern repo, so the real service performs the DRAFT→APPROVED
  transition and revalidation exactly as production. Higher fidelity, more code.
Recommendation: **D1a for 7A4A**, with an optional D1b integration test that runs against the guarded
`outreach_test` DB only (never production Supabase) if state-transition fidelity must be proven.

---

## 6. Deterministic quality rubric (100 points, exact weights)

Modeled on `evaluation/audit/graders.ts`: every sub-check is a reproducible boolean/measurement over the
recorded artifacts, ledger, plan, and package — **no model-graded scores in default mode.** New module
`email-quality-rubric.ts`.

| Category | Weight | Deterministic checks (each artifact) |
|---|---:|---|
| Prospect specificity | 20 | Prospect observation present and first; references the exact primary verified finding category; cites ≥1 prospect evidence id from the ledger; names the concrete issue (booking CTA on mobile) not a generic phrase. |
| Material relevance of competitor context | 20 | Selected pattern's category is in `AUDIT_TO_EVIDENCE_ALIGNMENT[primaryIssue]`; competitor section maps to the same issue; contrast (if any) ties to the primary issue; consequence label matches the aligned category. Baseline scores 0 here by construction (no competitor context) — this is the intended differentiator. |
| Evidence & traceability integrity | 20 | Every substantive sentence has a ledger entry; every `COMPETITOR_PATTERN`/`PROSPECT_CONTRAST`/`CAUTIOUS_CONSEQUENCE` entry references a pattern id + evidence refs; claim spans resolve to rendered text; `composedMessageHash` reproducible; package hash equals stored approved hash. **Must be 20/20 to accept the enriched email.** |
| Clarity & readability | 15 | Sentence-length bounds; no duplicated sentences; single clean paragraph ordering; no glued tokens (e.g. de-glued category words); no leftover template placeholders. |
| Brevity & focus | 10 | Total word/char count within the existing email length gate; exactly one competitor section; no redundant restatement of the prospect issue. |
| Recommendation & CTA coherence | 10 | Exactly one recommendation; exactly one CTA; CTA present and non-competitor; recommendation aligns with the prospect issue; no competitor language in subject or CTA. |
| Naturalness / non-template feel | 5 | Consequence sentence is from the approved template but not repeated; no obviously mechanical stitching (e.g. two adjacent identical connectives); anonymized count phrase reads as prose ("two nearby clinics"), not "2/3". |

### 6.1 Exact deterministic point allocation (APPROVED — every sub-check has a fixed integer value)

Each category's sub-checks sum EXACTLY to its weight. The same function scores both artifacts. A NONE-mode
(baseline) artifact earns competitor-specific sub-checks only "vacuously" where there is nothing to violate
(noted per row); it earns 0 on Material relevance by construction. Total = 100.

**Prospect specificity (20):** observation section present & non-empty (5); observation is the FIRST body
section (5); ledger/evidence cites the primary verified finding evidence id (5); body contains the concrete
issue keyword for the primary category (booking/appointment for `BOOKING_FRICTION`) (5).

**Material relevance (20):** exactly one competitor section present (5); selected pattern category ∈ the
aligned evidence categories for the primary issue (5); competitor sentence cites ≥1 competitor evidence id
(4); consequence label equals the aligned category's mapped consequence (3); a prospect contrast tied to the
primary category is present (3). *Baseline = 0 (no competitor context) — the intended differentiator.*

**Evidence & traceability integrity (20) — must be 20/20 to accept enriched:** every body section maps to a
ledger entry (4); every COMPETITOR_PATTERN/PROSPECT_CONTRAST/CAUTIOUS_CONSEQUENCE entry references a pattern
id (4, *vacuous-pass in NONE mode when none exist*); competitor-claim entry cites ≥1 competitor evidence id
(3, *vacuous-pass in NONE*); prospect-observation entry cites ≥1 prospect evidence id (3); composed-message
hash recomputes identically (3, *baseline uses its own rendered-artifact hash*); package hash equals the
stored approved hash / revalidation matched (3, *NONE mode: awarded iff the artifact correctly reports NONE
with no competitor sentence*).

**Clarity & readability (15):** no paragraph exceeds the per-paragraph length bound (4); no duplicated
sentence in the body (4); no glued/concatenated tokens — `/[a-z][A-Z]/` intra-word or de-glue check (3);
paragraph count within 2–4 (2); no leftover markdown/placeholder except renderer tokens (2).

**Brevity & focus (10):** body word count ≤ `MAX_EMAIL_WORDS` (120) (4); at most one competitor section (3);
issue keyword restated in ≤ 2 sentences (no redundant restatement) (3).

**Recommendation & CTA coherence (10):** exactly one recommendation section (3); exactly one CTA — valid
`primary_cta` + single rendered CTA sentence (3); CTA/subject carry no competitor wording (2); recommendation
text contains the issue keyword (aligned to the prospect issue) (2).

**Naturalness & non-template feel (5):** consequence sentence appears at most once (2); no mechanical
stitching — no doubled sentence, no double spaces, no consecutive sentences sharing the same opening 3 words
(2); anonymized count phrase reads as prose ("…nearby clinics", not a bare digit ratio) (1).

> **Pre-coding gate satisfied:** every sub-check above has an exact integer point value and the per-category
> values sum to the approved weights. No allocation is left undefined, so implementation proceeds (no stop).

**Enriched-email acceptance (all required):**
- total ≥ **80/100**
- enriched ≥ baseline + **8**
- **no** category scores 0
- Evidence & traceability integrity = **20/20**
- Material relevance ≥ **16/20**
- **every** hard safety validator (§7) passes

A higher quality score **never** overrides a safety failure (§7 is evaluated first and is absolute).

---

## 7. Hard safety gates (absolute — any one fails ⇒ FAIL)

Most already exist in `validateEnrichedComposition` / schema / composer; the harness aggregates them and adds
the ordering/subject/section/mode/schema checks. Enriched email **auto-fails** on any of:

1. Unsupported competitor claim (sentence not verbatim from approved wording).
2. Unsupported prospect claim (prospect sentence not backed by a prospect evidence id).
3. Competitor identity or domain leakage (`competitor_identity_leak:*`).
4. Incorrect competitor count (`competitor_count_wording_mismatch` / `..._form_inconsistent`).
5. Sample-of-one comparison (`usableDenominator < 2` or `presentCount < 2`).
6. Stale / invalidated / superseded / unsafe evidence at compose time (revalidation fails).
7. Package hash mismatch (recomputed ≠ stored approved hash).
8. Missing claim traceability (`missing_comparative_traceability` / `*_missing_*refs`).
9. Any performance/conversion/revenue/ranking/customer-volume claim (`prohibited_claim:*`).
10. Competitor context appears in the subject.
11. Competitor context appears before the prospect observation (composition-plan ordering).
12. More than one competitor section.
13. Consequence not supported by the approved label (`consequence_not_from_template` /
    `consequence_label_unsupported`).
14. Final artifact still reports `competitor_evidence_used = NONE`.
15. Final schema is not `email-copy-schema-3`.

The runner records **which** gate failed (violation code) so the report is auditable. Gates are checked
before scoring; a failure short-circuits to FAIL and the rubric total is reported but non-authoritative.

---

## 8. Quality comparison report (structure)

Typed `ValidationReport` (new `validation-report.ts`), renderable as JSON + a human-readable text/markdown
summary. Contains:

- baseline subject + body; enriched subject + body
- final schema version + evidence mode for each
- selected package id/version/hash, selected pattern, selected contrast (+ why selected)
- exact evidence references (prospect + competitor) per claim
- full claim ledger (both artifacts)
- baseline rubric score (per-category + total)
- enriched rubric score (per-category + total)
- score difference (enriched − baseline)
- hard-gate results (each gate: pass/fail + violation code)
- length comparison (words/chars)
- explanation of what materially improved (derived deterministically from category deltas)
- explanation of any awkward/mechanical wording (from the naturalness sub-checks that missed)
- **PASS / REVISE / FAIL** result

The report explicitly separates three layers:
1. **Deterministic factual/safety validation** (§7) — authoritative, blocking.
2. **Deterministic quality scoring** (§6) — advisory ranking, cannot override §7.
3. **Optional future AI critique** (§10) — advisory only, never blocking, must itself pass §7 validators.

---

## 9. CLI proposal (do **not** create yet)

Following `src/cli/index.ts` commander conventions and the `competitor-*` / `outreach-compose-preview`
shape. All three are fixture-only/offline by default.

- **`competitor-email-validation-plan`** — read-only; prints the synthetic scenario, the expected pipeline
  stages (1–10), the rubric weights, and the hard gates. Zero writes, zero network.
- **`competitor-email-validation-run`** — fixture-only by default; runs the full baseline-vs-enriched
  comparison and writes a local report to `.local-data/phase-7a4/` (git-ignored). No production DB write, no
  network, no live model, no Gmail/Sheets. A `--live-advisory` path is reserved for 7A4B and requires the
  explicit gates in §10 (default off; fails closed, never falls back to live silently).
- **`competitor-email-validation-review`** — read-only; loads a saved report and prints the side-by-side
  bodies, rubric breakdown, claim ledger, and hard-gate results.

---

## 10. Optional live-model validation (planned; not implemented, not run in 7A4A)

A later, separately-approved **7A4B** mode may:
- use **GPT-5.6 Terra** for the normal base-email composition, and
- use **GPT-5.6 Sol** for **advisory** quality critique only.

Requirements (all mandatory, mirroring the Gate A/B precedent):
- explicit live-model provider selection (`provider.name !== 'mock'`) — no hidden default;
- explicit operator confirmation flag (e.g. `--confirm-live-model`);
- **no automatic fallback** from live to mock (fail closed, nonzero exit, like `selectReplyReader`);
- fictional fixture data only; no Gmail drafting/sending; no Sheets; no production DB write;
- AI critique is **advisory** — it cannot override any deterministic safety gate (§7) or change PASS/FAIL;
- model output must still pass **all** existing validators (schema-3, copy gate, enriched-body validator).

Default 7A4 execution stays fixture-only and offline. Model names come from env config, never hardcoded
(per CLAUDE.md architecture boundary).

---

## 11. Failure-handling design (no silent success anywhere)

| Condition | Behavior |
|---|---|
| No valid competitor pattern exists | Harness stops; report = FAIL with reason `NO_ENRICHABLE_PATTERN`; does **not** emit a passing prospect-only-as-enriched result. |
| Prospect evidence cannot support alignment | `planEnrichment` fails closed; FAIL `ALIGNMENT_UNSUPPORTED` (never a silent prospect-only email under an explicit package request). |
| Package approval fails (validator/revalidation) | FAIL `PACKAGE_NOT_APPROVABLE`; no compose. |
| Enriched email fails validation (§7) | FAIL with the specific violation code(s). |
| Enriched score below baseline (or +8 delta unmet) | REVISE `INSUFFICIENT_IMPROVEMENT` (safety passed but quality bar unmet). |
| Enriched improves specificity but sounds unnatural | REVISE `NATURALNESS_BELOW_BAR` (naturalness/clarity sub-checks flagged). |
| Claim-ledger spans don't match rendered text | FAIL `TRACEABILITY_SPAN_MISMATCH` (hard gate #8 family). |
| Final message hash changes unexpectedly | FAIL `HASH_UNSTABLE` (non-determinism detected). |

Every terminal state carries an explicit machine reason; nothing "passes by omission".

---

## 12. Artifact & storage policy

- All synthetic artifacts and reports live under **`.local-data/phase-7a4/`** (already git-ignored via
  `.gitignore:36`). Never staged, never committed.
- Fixtures (synthetic prospect, three clinics, base draft) live under `src/fixtures/phase-7a4/` and/or
  `fixtures/phase-7a4/`, clearly named `synthetic-*`, and contain **no** real company, domain, person,
  address, phone, review, credential, or copied external asset.
- Deterministic fixture hashes: fixtures carry stable content hashes; a fixed fixture clock (never wall
  clock) makes every run byte-identical (mirrors the 3C-B render determinism approach).
- No screenshots, no raw HTML retained (content hash only, per 7A2 rules).
- Bounded report retention: the run command keeps the latest report by scenario id; older reports overwritten
  or pruned. Validation reports are excluded from Git **unless** one is deliberately curated as a synthetic
  example under `docs/examples/` (explicitly marked synthetic).

---

## 13. Testing plan (fixture-only; no paid calls, no network, no Gmail/Sheets)

Unit/integration tests (Vitest; mock providers only) covering:

- complete fixture pipeline (stages 1–10) succeeds and yields a report;
- baseline and enriched use the **same** base issue, recommendation, CTA, language, base draft;
- the competitor package is produced through the **actual** 7A1→7A3A path (assert wordingText/counts come
  from pattern logic, not a literal);
- final enriched artifact uses **schema-3** and mode `APPROVED_COMPETITOR_PATTERN_PACKAGE`;
- competitor paragraph materially aligns with the prospect issue (Material relevance ≥ 16/20);
- enriched score exceeds baseline by **≥ 8**;
- enriched score below threshold → REVISE or FAIL (negative fixture);
- a safety failure overrides a high quality score (inject a violation; expect FAIL);
- identity leakage fails; count mismatch fails; stale evidence fails; traceability failure fails;
- competitor paragraph in subject fails; competitor paragraph before opening fails; >1 competitor section
  fails; unsupported consequence fails;
- message hash and claim spans remain stable across repeated runs;
- fixture-only mode performs **zero** network requests (assert no HTTP client constructed / a network guard);
- **no** production DB write (assert against a write-throwing DB double or in-memory repo);
- **no** live model call (assert `provider.name === 'mock'` in default mode);
- **no** Gmail or Sheets method reachable; **no** drafting or sending path invoked.

Any DB-backed fidelity test (D1b) runs only against the loopback `outreach_test` database behind
`test-database-guard.ts`.

---

## 14. Milestones, acceptance criteria, risks, rollback, files

### 14.1 Milestone boundaries (recommend smaller reviewable steps)

- **Phase 7A4A — offline synthetic end-to-end harness (first coding milestone).** Fixtures + rubric +
  hard-gate aggregation + report + the three CLI commands (offline paths only) + tests. No live model.
- **Phase 7A4B — guarded fictional live-model quality run.** Adds the `--live-advisory` path (Terra base +
  Sol critique) with the §10 gates; advisory only. Separate approval; not run during implementation.
- **Phase 7A4C — operator review & final go/no-go.** Human reviews a 7A4A (and optionally 7A4B) report and
  records the go/no-go for using enrichment on real prospects. Real-prospect use and real sending remain
  **outside** all of 7A4.

### 14.2 Acceptance criteria (7A4A)

- The harness drives the real 7A1→7A3A→7A3B code path (no hand-built final package).
- Produces both artifacts + one report with all §8 fields.
- Enriched artifact: schema-3, mode `APPROVED_COMPETITOR_PATTERN_PACKAGE`, all §7 gates pass, total ≥ 80,
  ≥ baseline + 8, no zero category, integrity 20/20, material relevance ≥ 16.
- Report result is PASS for the primary scenario; negative fixtures produce the correct REVISE/FAIL codes.
- lint/typecheck/build green; full unit suite green; zero network, zero DB write, zero live model, zero
  Gmail/Sheets in the default run.
- Deterministic: two runs produce identical hashes and identical report bodies.

### 14.3 Risks & mitigations

- **R1 — "full path" is faked.** Mitigation: assert package wording/counts derive from pattern logic; test
  forbids literal wordingText in fixtures.
- **R2 — unfair baseline (enriched wins only because of unrelated copy).** Mitigation: pin the identical base
  draft/issue/recommendation/CTA; Material-relevance is the *only* category baseline can't earn.
- **R3 — quality score masks a safety regression.** Mitigation: §7 evaluated first and absolute.
- **R4 — non-determinism (hash drift).** Mitigation: fixed fixture clock, canonical hashing, stability test.
- **R5 — scenario too easy (always passes).** Mitigation: include negative fixtures (misaligned pattern,
  sample-of-one, stale evidence, leaked identity, count mismatch) that must FAIL/REVISE.
- **R6 — accidental live/prod touch.** Mitigation: default mock provider, in-memory/throwing DB double,
  network guard, no Gmail/Sheets import in the harness.

### 14.4 Rollback strategy

7A4A adds only new modules, fixtures, CLI commands, tests, and git-ignored artifacts — **no migration, no
schema change, no production-code change** to the existing pipeline. Rollback = revert the additive commit;
nothing to un-migrate, no state to restore. (The composer/enrichment/validators are consumed read-only.)

### 14.5 Expected files/modules (implementation, not done here)

- `src/domain/email/email-quality-rubric.ts` — deterministic 100-pt rubric (new).
- `src/domain/email/email-validation-gates.ts` — aggregates §7 hard gates (thin; mostly re-exports existing
  validators + adds subject/ordering/section/mode/schema checks). *(May fold into the rubric module.)*
- `src/evaluation/email/validation-runner.ts` — drives stages 1–10 (mirrors `eval-runner.ts`).
- `src/evaluation/email/validation-report.ts` — typed report + JSON/markdown renderer.
- `src/fixtures/phase-7a4/synthetic-dental-scenario.ts` (+ optional contact-friction variant) — prospect,
  three clinics, evidence, base draft; deterministic hashes.
- `src/cli/commands/competitor-email-validation-{plan,run,review}.ts` — three commands; register in
  `src/cli/index.ts`.
- `tests/unit/email-quality-rubric.test.ts`, `tests/unit/email-validation-gates.test.ts`,
  `tests/unit/phase-7a4-harness.test.ts` — plus negative-fixture tests.
- (Optional D1b) `tests/support/competitor-pattern-memory.ts` + a `*.pg.test.ts` against `outreach_test`.

---

## 15. Final report

**1. Recommended Phase 7A4A scope.** Build the offline synthetic harness only: synthetic dental-clinic
fixtures (prospect + three clinics + explicit scoped negative + fixed base draft), driven through the real
7A1→7A3A→7A3B code path via pure-function assembly (D1a); a deterministic 100-point rubric; aggregation of
the existing hard safety gates plus subject/ordering/section/mode/schema checks; a typed side-by-side report
(PASS/REVISE/FAIL) written to git-ignored `.local-data/phase-7a4/`; three read-only/offline CLI commands; and
a test suite including negative fixtures. No live model, no DB write, no network, no Gmail/Sheets.

**2. Architecture gaps blocking implementation.** None block 7A4A. Two items to resolve at implementation
start, both with a recommended default already chosen: **D1 persistence style** (recommend D1a pure-function
assembly for 7A4A, optional D1b in-memory/`outreach_test` fidelity test) and confirmation that a fixture may
inject an **explicit scoped negative** prospect primitive to exercise the contrast path (G1) — legitimate for
a fictional fixture, no production change.

**3. Expected code & fixture files.** As listed in §14.5: `email-quality-rubric.ts`, the
`evaluation/email/{validation-runner,validation-report}.ts`, `fixtures/phase-7a4/synthetic-dental-scenario.ts`
(+ optional contact-friction variant), three `competitor-email-validation-*` CLI commands (registered in
`src/cli/index.ts`), and the unit/negative tests (plus an optional in-memory repo helper for D1b).

**4. Exact acceptance criteria.** §14.2: real path exercised (no hand-built package), both artifacts + full
report produced, enriched = schema-3 + `APPROVED_COMPETITOR_PATTERN_PACKAGE` + all §7 gates pass + total ≥ 80
+ ≥ baseline + 8 + no zero category + integrity 20/20 + material relevance ≥ 16; negative fixtures produce
the correct REVISE/FAIL codes; deterministic (stable hashes/report across runs); lint/typecheck/build/tests
green; zero network/DB-write/live-model/Gmail/Sheets in the default run.

**5. Decisions requiring operator approval.**
- Approve Phase 7A4 planning and the 7A4A/7A4B/7A4C split; approve **7A4A** as the next coding milestone.
- **D1:** confirm pure-function assembly (D1a) for 7A4A, with D1b as an optional guarded-DB fidelity test.
- Confirm the synthetic fixture may inject an explicit scoped negative prospect primitive (G1) to exercise
  the contrast path.
- Confirm the exact rubric sub-checks and thresholds in §6 (weights are fixed by the brief; the per-category
  deterministic checks are proposed and open to adjustment).
- Confirm the three CLI command names (§9) and the artifact location `.local-data/phase-7a4/`.
- Confirm 7A4B live-model gating (Terra base / Sol advisory) is deferred and **not** implemented in 7A4A.
- English-only for 7A4 confirmed; German/Hebrew localization is a separate later milestone.

**6. Confirmation of no side effects.** This task created **only** `docs/phase-7a4-email-validation.md`. No
code, migration, or fixture was written or modified; `AGENTS.md` was not touched; nothing was committed or
pushed; no website, prospect, live AI model, Gmail, Google Sheets, or production database was accessed; no
Gmail draft, email, or record was created. Planning only.

---

---

## 17. Phase 7A4A implementation record (2026-08-03)

**Status: IMPLEMENTED. lint + typecheck + build green; 1113 unit tests pass (107 files), including 23 new
7A4A cases. No migration was created (none is needed — the harness is fixture/in-memory only).**

### What the harness executes (real services, in-memory adapters)

The synthetic dental scenario is driven through the genuine Phase 7A1–7A3B code path:

1. `CompetitorResearchService` selects **3** comparable clinics (real normalization/scoring/selection).
2. `CompetitorCaptureService` + `MockCaptureProvider` capture fixture homepages; the real
   `deriveCompetitorObservations` rules yield **15** evidence items (a `BOOKING_CTA_VISIBLE` per profile).
3. `CompetitorPatternService.build/run` produces the DRAFT package (`ALL_OBSERVED`, HIGH, present 3 /
   denominator 3), with a verified prospect **contrast** from the explicit scoped negative (Decision G1).
4. Real approval gates (`validatePackage` + `isApprovableConfidence` + live-state freshness recheck) pass,
   then a named synthetic operator moves the package DRAFT → APPROVED in the in-memory store.
5. Composition-time revalidation recomputes the package and confirms the stored hash re-matches.
6. `planEnrichment` + `composeEnrichedEmail` build the BASELINE (mode NONE) and ENRICHED
   (`APPROVED_COMPETITOR_PATTERN_PACKAGE`, `email-copy-schema-3`) emails from the **same** pinned base draft.

### Result of the shipped synthetic run

- **Result: PASS.** Baseline **80/100** → Enriched **97/100** (difference **+17**, ≥ 8).
- Enriched per-category: Prospect specificity 20/20, **Material relevance 20/20**, **Integrity 20/20**,
  Clarity 15/15, Brevity 7/10, Recommendation & CTA 10/10, Naturalness 5/5 (no category zero).
- **All 16 hard safety gates PASS.** Determinism: report hash, composed-message hash, and package hash are
  byte-identical across repeated runs.

### Files added / changed

- `src/fixtures/competitor-email-validation/synthetic-dental-scenario.ts` — synthetic scenario + pinned base
  draft + explicit scoped prospect negative (Decision G1).
- `src/evaluation/email/inmemory-competitor-stores.ts` — in-memory adapters over the 7A1/7A2/7A3A ports.
- `src/evaluation/email/harness.ts` — the offline orchestrator (real pipeline, deterministic ids).
- `src/evaluation/email/email-quality-rubric.ts` — the 100-point rubric (§6.1 allocation).
- `src/evaluation/email/hard-gates.ts` — the 16 aggregated hard safety gates (§7).
- `src/evaluation/email/validation-report.ts` — typed report + renderer + determinism hash + pure
  `qualityShortfalls` / `decideResult` (safety overrides score).
- `src/evaluation/email/constants.ts` — approved weights/thresholds/keywords.
- `src/cli/commands/competitor-email-validation-{plan,run,review}.ts` + registration in `src/cli/index.ts`.
- `tests/unit/competitor-email-validation.test.ts` — 23 cases.

### Artifacts & git

- Reports are written to `.local-data/competitor-email-validation/` (git-ignored; never staged/committed).
- No migration, no schema change, no production-code change to the existing pipeline (additive only).

### Confirmation of no side effects

No production database write, network request, live AI model call, Gmail, Sheets, draft, or send occurred
during implementation or tests. `AGENTS.md` was not touched. The mock capture provider and the pinned base
draft are the only "providers"; the operational `DATABASE_URL` pool is never opened by the harness or its
CLI. 7A4B (live-model advisory) and 7A4C (operator go/no-go) remain unimplemented and unapproved.
