# Phase 7A4B — Guarded Fictional Live-Model Validation (Planning)

> **STATUS: PLANNING ONLY — NOT APPROVED, NOT IMPLEMENTED.** This document is the design for a single,
> tightly-guarded fictional live-model validation run. No code is written here. No live model is called
> during planning. No real prospect, live website, Gmail, Sheets, production database, migration, or
> `AGENTS.md` change is involved. Phase 7A4A (offline synthetic harness) is implemented and green
> (baseline 80 → enriched 97, +17, all 16 hard gates pass). Phase 7A4B closes the one remaining gap:
> the base email is currently a **pinned fixture draft**; production will generate it with a model.
> Phase 7A4C remains the separate operator go/no-go milestone.

---

## 0. Purpose and the exact gap being closed

Phase 7A4A drove the real 7A1→7A3B pipeline over a fictional dental scenario and proved that deterministic
competitor enrichment improves a **fixed, hand-pinned** base email while remaining fully evidence-backed and
safe. The one thing 7A4A did **not** exercise is the part production will use a model for: **authoring the
prospect-only base email**. In `src/evaluation/email/harness.ts` the base is the literal
`baseEmailDraft` fixture (`src/fixtures/competitor-email-validation/synthetic-dental-scenario.ts`).

Phase 7A4B replaces exactly that one input — and nothing else — with a single live **Terra** generation,
then reuses the identical deterministic enrichment + scoring + hard-gate path from 7A4A, and adds one live
**Sol** advisory critique. It proves five things:

1. a production-style model (Terra) can author an acceptable prospect-only base email;
2. that exact base artifact serves both the baseline and the enriched comparison (no model randomness in the
   delta);
3. deterministic competitor enrichment still improves the *live-model* email;
4. the model introduces no unsupported claim (deterministic validators + Sol advisory both check);
5. a quality-focused critique model (Sol) finds no serious naturalness/clarity/credibility problem.

This remains **fictional validation only**. It is not a real-prospect run and produces no go-live decision.

---

## 1. Repository findings (confirmed by inspection at `e1725ea`)

### 1.1 The LLM boundary is model-agnostic — "Terra vs Sol routing" is a model string, not a provider

- `src/integrations/llm/provider.ts` — `LlmProvider { readonly name; generate(req: LlmRequest) }`. The model
  is a per-request field (`LlmRequest.model: string`), so a single provider instance serves both Terra and
  Sol simply by passing a different `model`. There is **no** separate "Terra provider" or "Sol provider" class,
  and none is needed.
- `src/integrations/llm/openai-responses.ts` — `OpenAiResponsesProvider` (`name = 'openai'`) sends
  `req.model` straight to the Responses API; strict `json_schema` output; `store` from config; per-request
  `timeout`/`maxRetries`; refusal/incomplete/rate-limit/transient mapped to `LlmStatus`; usage + `requestId`
  + `responseId` + `resolvedModel` captured; cost via `estimateCostUsd`. Optional metadata is `null`, never
  fabricated. **This is exactly the metadata the brief asks to record.**
- `src/integrations/llm/mock-llm.ts` — `MockLlmProvider` (`name = 'mock'`), deterministic, zero-cost,
  records every `LlmRequest`. This is the automated-test provider.
- `src/integrations/llm/pricing.ts` — verified prices exist for **both** `gpt-5.6-sol` and `gpt-5.6-terra`;
  `PRICE_VERIFIED_AT`, `priceKnown(model)`, `estimateCostUsd`, and `worstCaseCostUsd(model, inTok, outTok)`
  are the pre-call budget primitives.

**Conclusion for the brief's question #2:** the existing provider architecture **fully supports** Terra and
Sol routing today, via configured model aliases through the one `OpenAiResponsesProvider`. No new provider
class is required.

### 1.2 The approved model aliases already exist — and production email routing is the *inverse* of this brief

`src/config/env.ts` uses the two aliases as string-typed, env-overridable model names (never hardcoded in
business logic):

- `EMAIL_WRITER_MODEL` default **`gpt-5.6-sol`** — i.e. in production **Sol writes** the email.
- `EMAIL_REVIEWER_MODEL` default **`gpt-5.6-terra`** — i.e. in production **Terra reviews** the email.
- (Same pattern for `DEMO_COMPOSER_MODEL`/`_REVIEWER_MODEL` and the Demo V2 creative/translation/visual models.)

**This directly contradicts the 7A4B brief**, which asks for **Terra = generate the base email** and
**Sol = advisory critique**. This is an unresolved decision (see §16, decision U1) and must be settled before
implementation. The plan below follows the **brief's explicit routing** (Terra generates, Sol critiques) via
**dedicated new flags** so it neither silently reuses nor silently overrides the production defaults — but the
inconsistency is flagged loudly for the operator.

Use the exact configured aliases `gpt-5.6-terra` / `gpt-5.6-sol`. Do **not** invent identifiers.

### 1.3 The paid-call gate pattern to copy exactly

`src/cli/commands/email-build.ts::buildEmailProvider` is the canonical "no silent fallback + hard paid gate":

```
LLM_PROVIDER === 'openai'  ⇒ require ALL of:
  ALLOW_PAID_LLM_CALLS === true      (paid kill switch)
  OPENAI_API_KEY present
  PRICE_VERIFIED_AT truthy           (price table reconciled)
  priceKnown(model) for each model   (no unverified-price call)
else ⇒ MockLlmProvider(defaultMockEmailResponder)
```

`src/config/env.ts` also cross-validates (`LLM_PROVIDER=openai && ALLOW_PAID_LLM_CALLS ⇒ OPENAI_API_KEY`).
`ALLOW_PAID_LLM_CALLS` and `LLM_PROVIDER` default safe (`false`/`mock`). 7A4B adds its **own** dedicated
default-off flags on top of this, and *never* falls back to mock when live intent is explicit.

### 1.4 The base-email writer path (reuse the pieces, not the whole service)

- `src/domain/email/email-writer-service.ts::EmailWriterService.write()` runs
  **writer → deterministic `validateEmail` → adversarial reviewer → gate → render → persist**, using
  `buildEmailWriterMessages` / `buildEmailReviewerMessages` (`src/prompts/email/index.js`) and
  `emailWriterSchema` (`src/domain/email/email-schema.ts`, `EMAIL_SCHEMA_VERSION = 'email-copy-schema-3'`,
  `competitor_evidence_used ∈ {NONE, APPROVED_COMPETITOR_PATTERN_PACKAGE}`).
- **Cannot be reused wholesale for 7A4B** because it (a) always makes **two** calls (writer *and* reviewer),
  and (b) **persists to the production DB** via `EmailUnitOfWork.transaction`. 7A4B needs **exactly one**
  Terra call and **zero** DB writes.
- **Reusable sub-pieces (no DB, no second call):** `buildEmailWriterMessages(brief, null)`,
  `provider.generate({ task: 'email_write', model: <terra>, outputSchema: EMAIL_WRITER_JSON_SCHEMA, … })`,
  `emailWriterSchema.safeParse`, and `validateEmail(draft, ctx)`. This is "production-style generation"
  minus persistence and minus the reviewer. The base draft's `competitor_evidence_used` must come back `NONE`.
- Fidelity note: skipping the production reviewer is intentional (7A4B's Sol critique is the advisory reader
  and is *comparative*, not the production adversarial gate). The deterministic validators remain the hard
  authority.

### 1.5 The 7A4A harness is the enrichment/scoring/gate engine to reuse verbatim

- `src/evaluation/email/harness.ts::runValidationHarness()` performs stages 1–6 and today pins the base draft
  at `harness.ts:335,362` (`baseEmailDraft` used for both `renderEmail`/`validateEmail` baseline and as
  `composeEnrichedEmail({ prospectDraft: baseEmailDraft, … })`). **The Terra artifact plugs in here** — it is
  the drop-in replacement for `baseEmailDraft`, and the same-artifact-for-both contract falls out for free.
- `src/domain/email/competitor-enrichment.ts::planEnrichment` and
  `src/domain/email/competitor-email-composer.ts::composeEnrichedEmail` are pure; the composer flips
  `competitor_evidence_used → APPROVED_COMPETITOR_PATTERN_PACKAGE` **only on the enriched artifact**, re-runs
  schema + base copy gate + `validateEnrichedComposition`, builds the claim ledger, and computes the canonical
  `composedMessageHash`.
- `src/evaluation/email/hard-gates.ts` (16 aggregated hard safety gates),
  `email-quality-rubric.ts` (100-pt rubric, §6.1 of 7A4A), and
  `validation-report.ts` (`buildReport`, `qualityShortfalls`, `decideResult`, `hashReport`,
  `renderReportText`) are all reused unchanged. `decideResult` already encodes "safety overrides score".

### 1.6 Artifact + git-ignore conventions

- `/.local-data/` and `eval-reports/` are git-ignored (`.gitignore:31,36`).
- 7A4A already writes to `.local-data/competitor-email-validation/`
  (`src/cli/commands/competitor-email-validation-run.ts:19`). 7A4B writes to the **`live/`** sub-path:
  `.local-data/competitor-email-validation/live/` (still git-ignored; never staged/committed).

### 1.7 Gaps / constraints found (shape the design)

- **F1 — Routing inversion (see §1.2).** Blocking decision U1.
- **F2 — No comparative-critique task/schema exists.** `LlmRequest.task` is the closed union
  `website_audit | audit_review | demo_design | demo_design_review | email_write | email_review`, and
  `emailReviewSchema` is the *single-email* adversarial reviewer shape (booleans + problems), **not** the
  comparative `preferredVersion/…` schema the brief wants. 7A4B needs a **new Zod schema + new prompt** for
  Sol. Recommended: reuse the existing `task: 'email_review'` **literal** with a distinct `schemaName`
  (e.g. `email_comparative_critique`) so the closed `task` union in `provider.ts` is **not** modified
  (keeps the production LLM boundary untouched). Adding a new task literal is the alternative (decision U2).
- **F3 — Terra base skips the production reviewer** (see §1.4). Intentional; documented.
- **F4 — English-only.** 7A3B enrichment is English-only; the fixture is English. Unchanged.
- **F5 — Harness base draft is hardcoded.** A small **additive, backward-compatible** refactor is needed:
  give `runValidationHarness` an optional injected base draft (default = fixture) so 7A4A behavior is byte
  identical and 7A4B passes the Terra draft. No 7A4A output changes.

---

## 2. Reusable vs new components

| Concern | Reuse (unchanged) | New (7A4B) |
|---|---|---|
| LLM boundary | `LlmProvider`, `OpenAiResponsesProvider`, `MockLlmProvider` | — |
| Paid gate | `buildEmailProvider` gate pattern, `priceKnown`, `PRICE_VERIFIED_AT`, `worstCaseCostUsd` | live-validation provider builder w/ dedicated flags |
| Terra base gen | `buildEmailWriterMessages`, `EMAIL_WRITER_JSON_SCHEMA`, `emailWriterSchema`, `validateEmail`, `buildEmailContext` | slim single-call generator (no DB, no reviewer) |
| Enrichment/scoring/gates | `runValidationHarness` stages 1–6, `planEnrichment`, `composeEnrichedEmail`, `hard-gates.ts`, `email-quality-rubric.ts`, `validation-report.ts` | inject Terra draft as base |
| Sol critique | `LlmProvider.generate` (`task:'email_review'`, new `schemaName`) | new `sol-critique-schema.ts` (Zod) + new prompt + sanitizer |
| Fixture | `synthetic-dental-scenario.ts` (prospect, 3 clinics, evidence, leadFacts, findings) | reuse; Terra replaces the pinned `baseEmailDraft` |
| Artifacts | `.local-data/competitor-email-validation/` convention, git-ignore | `live/` sub-path, live report schema |
| CLI | commander registration in `src/cli/index.ts`, 7A4A command shape | three `*-live-validation-*` commands |

---

## 3. Architecture and exact call flow

```
competitor-email-live-validation-run  (requires ALL guards in §7; fails closed, nonzero on any gap)
  │
  ├─ 0. Guard check: flags on, providers selected, fixture id = synthetic dental, --confirm-live,
  │     --confirm-no-real-prospect, --max-live-calls 2, price table verified, priceKnown(terra), priceKnown(sol)
  │
  ├─ 1. Build fictional Terra brief  ── from fixture leadFacts + safeFindings ONLY (prospect-only).
  │        Brief.competitorPackage = null.  NO competitor names/domains/HTML/evidence/counts.
  │
  ├─ 2. TERRA CALL #1 (the ONLY base-generation call; no retries, no fallback, no parallel)
  │        provider.generate({ task:'email_write', model:<terra>, schemaName:'email_write',
  │                            outputSchema: EMAIL_WRITER_JSON_SCHEMA, maxRetries:0, … })
  │        record usage/latency/requestId/responseId/resolvedModel/estimatedCost
  │        ─ malformed/refusal/incomplete/rate_limited/transient ⇒ FAIL CLOSED, write failed report, STOP
  │
  ├─ 3. Deterministic base validation (BEFORE any enrichment, BEFORE Sol):
  │        emailWriterSchema.safeParse  → schema ok
  │        validateEmail(draft, ctx)    → prospect evidence support, subject/opening/reco/CTA, prohibited
  │                                       claims, length, punctuation/tone, NO competitor language
  │        assert draft.competitor_evidence_used === 'NONE'
  │        assert no competitor identity/domain token present (defense-in-depth)
  │        ─ any failure ⇒ produce FAILED base-validation report, DO NOT enrich, (default) DO NOT call Sol, STOP
  │
  ├─ 4. Deterministic enrichment (identical to 7A4A; NO model rewrites the competitor paragraph):
  │        runValidationHarness({ baseDraft: terraDraft })  ── reuses stages 3–6:
  │          revalidate package hash + evidence freshness + approval (synthetic approved package)
  │          select pattern via implemented deterministic order
  │          composeEnrichedEmail → email-copy-schema-3, competitor_evidence_used=APPROVED_…_PACKAGE
  │          full claim ledger + composedMessageHash
  │        rerun all 16 hard gates; compute rubric for baseline (Terra, NONE) and enriched
  │        ─ enrichment/gate/hash failure ⇒ deterministic FAIL report (Sol still may critique — see §16 U3), STOP-or-continue
  │
  ├─ 5. Build Sol critique input (SANITIZED — §5): baseline subj/body, enriched subj/body, fictional
  │        business context, rubric results, hard-gate results, sanitized issue description,
  │        ANONYMIZED competitor-pattern metadata (no identities, no raw source)
  │
  ├─ 6. SOL CALL #1 (the ONLY critique call; advisory only; no retries, no fallback)
  │        provider.generate({ task:'email_review', model:<sol>, schemaName:'email_comparative_critique',
  │                            outputSchema: SOL_CRITIQUE_JSON_SCHEMA, maxRetries:0, … })
  │        solCritiqueSchema.safeParse
  │        ─ malformed ⇒ documented advisory failure (advisoryVerdict=FAIL surrogate), does NOT override §4
  │
  └─ 7. Combine (§8) → deterministic result + Sol advisory result + combined operator status
           write local live report to .local-data/competitor-email-validation/live/  (git-ignored)
```

**Fair-comparison contract (enforced):** Terra is called **exactly once**; its resulting `EmailWriterParsed`
is the single `baseDraft` fed to both the baseline render and `composeEnrichedEmail`. The enriched version may
differ from the baseline **only** by: deterministic approved competitor insertion, schema/provenance metadata,
the resulting claim ledger, and the resulting message hash. There is **no** second Terra call for the enriched
version. A test asserts `terraCallCount === 1`.

---

## 4. Live-call budget (hard cap 2)

- Max **one** Terra request + **one** Sol request per run. Absolute ceiling **2** live calls.
- `--max-live-calls` must equal `2` (any other value exits nonzero). A shared counter increments on every
  `provider.generate` where `provider.name !== 'mock'`; exceeding 2 throws before the call.
- **No retries** (`maxRetries: 0` per request, matching `EMAIL_MAX_RETRIES`/`DEMO_COMPOSER_MAX_RETRIES`
  defaults). No multi-agent, no parallel alternatives, no automatic fallback to mock, no automatic model
  switch, no "regenerate until better".
- A failed/malformed live response **fails closed** (never retried, never mocked-over).
- Pre-call budget: `worstCaseCostUsd(model, worstCaseInputTokens, maxOutputTokens)` projected before each
  call; if projection is `null` (unknown price) or would exceed `…_MAX_COST_USD`, do not call.
- **Recorded per call (where the provider supplies it):** configured model, request count, input/output
  (and cached/reasoning) tokens, latency, provider `requestId`/`responseId`, `resolvedModel`, estimated cost,
  validation timestamp (fixture-stable where a hash depends on it; wall-clock only in non-hashed metadata).
- **Never stored:** API keys, `Authorization`/raw provider headers, raw internal provider diagnostics.

---

## 5. Terra input/output contract and Sol sanitization

### 5.1 Terra input (prospect-only)

Terra receives **only** the fictional prospect data + verified prospect evidence needed for a normal base
email, via the existing `EmailBrief` built from the fixture `leadFacts` + `safeFindings` with
`competitorPackage: null`. Terra **must not** receive: competitor names, competitor domains, raw competitor
HTML, competitor excerpts, competitor evidence records, pattern counts, or any package contents. A test
asserts the serialized Terra request contains none of the fixture competitor identity tokens.

### 5.2 Terra output contract

`EmailWriterParsed` (email-copy-schema-3 writer shape) with `competitor_evidence_used = NONE`. Must pass
§3 step 3 validators before enrichment.

### 5.3 Sol input contract (sanitized, anonymized)

Sol receives: baseline subject/body, enriched subject/body, fictional business context, deterministic rubric
results, hard-gate results, a **sanitized** description of the verified issue, and **anonymized**
competitor-pattern metadata (e.g. `{ patternForm, presentCount, usableDenominator, consequenceLabel }` and a
prose count phrase like "two nearby clinics"). Sol **must not** receive competitor identities, competitor
domains, or any raw source/HTML/excerpt. A sanitizer strips identity tokens and asserts none survive; a test
asserts the serialized Sol request contains no competitor identity/domain token.

### 5.4 Sol output contract (strict schema — advisory only)

```ts
solCritiqueSchema = {
  preferredVersion: 'BASELINE' | 'ENRICHED' | 'TIE',
  baselineQualityScore: number (0..100, int),
  enrichedQualityScore: number (0..100, int),
  naturalnessAssessment: string,
  credibilityAssessment: string,
  flowAssessment: string,
  mechanicalWordingDetected: boolean,
  unsupportedClaimSuspected: boolean,
  criticalIssues: string[],
  improvementSuggestions: string[],
  advisoryVerdict: 'PASS' | 'REVISE' | 'FAIL',
}
```

Sol is **advisory only**. It cannot override a deterministic safety failure, approve a package or an email,
modify the email, trigger a second generation, or send/draft anything. Its output influences only the
**combined operator status** (and can only *downgrade*, never upgrade — see §8).

---

## 6. Deterministic acceptance gates (unchanged from 7A4A; authoritative)

The Terra base email must pass all prospect-only validators (§3 step 3). The enriched email must pass **all 16
hard safety gates** (`hard-gates.ts`) and the 7A4A rubric thresholds:

- enriched deterministic score **≥ 80**
- enriched deterministic improvement **≥ 8** (enriched − baseline)
- Evidence & traceability integrity **= 20/20**
- Material relevance **≥ 16/20**
- final artifact uses **`email-copy-schema-3`**
- final evidence mode **`APPROVED_COMPETITOR_PATTERN_PACKAGE`**
- all package/message hashes and claim spans stable (byte-identical on repeat, given the same Terra output)

A higher quality score never overrides a safety failure (`decideResult` enforces this).

---

## 7. Security and feature guards (default-off; live intent never falls back to mock)

New env flags (all default safe):

```
COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED           boolString(false)
COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_MODEL        default 'gpt-5.6-terra'   (existing verified alias)
COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_MODEL          default 'gpt-5.6-sol'     (existing verified alias)
COMPETITOR_EMAIL_LIVE_VALIDATION_TERRA_EFFORT       enum, default 'medium'
COMPETITOR_EMAIL_LIVE_VALIDATION_SOL_EFFORT         enum, default 'medium'
COMPETITOR_EMAIL_LIVE_VALIDATION_MAX_COST_USD       nonnegative, default 0.40
COMPETITOR_EMAIL_LIVE_VALIDATION_MAX_OUTPUT_TOKENS  positive,   default 1_500
COMPETITOR_EMAIL_LIVE_VALIDATION_TIMEOUT_MS         positive,   default 120_000
COMPETITOR_EMAIL_LIVE_VALIDATION_RETENTION_DAYS     positive,   default 30
```

(The brief lists `…_TERRA_PROVIDER` / `…_SOL_PROVIDER`; because provider selection is already `LLM_PROVIDER`
plus the `buildEmailProvider` gate, 7A4B keeps a single `LLM_PROVIDER=openai` provider and routes by **model**
alias — modeling per-side "provider" as a per-side **model** flag. Decision U2 confirms this.)

Live execution requires **all** of:

- `COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=true`
- `LLM_PROVIDER=openai` + `ALLOW_PAID_LLM_CALLS=true` + `OPENAI_API_KEY` (existing gate)
- `PRICE_VERIFIED_AT` truthy + `priceKnown(terraModel)` + `priceKnown(solModel)`
- explicit CLI `--confirm-live`
- explicit fictional fixture id (`--fixture synthetic-dental`; the only allowed value)
- explicit `--confirm-no-real-prospect`
- explicit `--max-live-calls 2`

Any missing guard exits **nonzero** before any model call. Explicit live intent **must never** fall back to
mock — if `LLM_PROVIDER=openai` is set but a paid precondition is missing, **throw**; do not construct a mock.
(The mock provider is reachable only when `LLM_PROVIDER` is not `openai`, and then only for the automated test
suite — never under `--confirm-live`.)

---

## 8. Combined-result logic

Three layers, reported separately; advisory can only downgrade.

**Deterministic result** (authoritative): baseline score, enriched score, difference, all 16 hard-gate
results, schema/evidence mode, package + message hashes, and a deterministic verdict:

- `FAIL` if any hard gate fails, Terra base fails validation, enrichment fails, integrity < 20/20,
  score < 80, or delta < 8.
- `REVISE` if all gates pass but a secondary quality bar is unmet (`qualityShortfalls` non-empty:
  e.g. material relevance < 16, or a naturalness/brevity shortfall).
- `PASS` otherwise.

**Sol advisory result**: preferredVersion, both quality scores, the three assessments, mechanical-wording,
unsupported-claim, critical issues, suggestions, advisory verdict.

**Combined operator status** (the only allowed outputs; **never** an automatic go-live approval):

| Combined status | When |
|---|---|
| `VALIDATION_FAILED` | deterministic result = FAIL (Sol cannot rescue this). |
| `REQUIRES_REVISION` | deterministic = REVISE; **or** deterministic PASS but Sol downgrades: `unsupportedClaimSuspected=true`, or `criticalIssues` non-empty, or Sol rates enriched **materially worse** (§9), or `advisoryVerdict ∈ {REVISE, FAIL}`, or Sol response malformed. |
| `READY_FOR_OPERATOR_REVIEW` | deterministic = PASS **and** Sol clean: no unsupported-claim suspicion, no critical issues, not materially worse, `advisoryVerdict = PASS`. |

Sol's score can never upgrade a deterministic FAIL/REVISE, and never override §6. Phase 7A4C makes the final
go/no-go.

---

## 9. "Sol rates enriched materially worse" — proposed numeric definition

**Materially worse ⇔ `enrichedQualityScore ≤ baselineQualityScore − 10`** (enriched is 10+ points below
baseline on Sol's 0–100 scale). A gap of 1–9 points is "not materially worse" (noise/subjectivity tolerance).
`preferredVersion = BASELINE` alone is *not* sufficient (advisory opinion, within tolerance) unless the 10-point
gap is also met. Rationale: 10 points is a full quality band on a 0–100 rubric, large enough to signal a real
regression while ignoring critique jitter. This is advisory: it can push the combined status to
`REQUIRES_REVISION` but can never override a deterministic PASS on safety.

---

## 10. Artifact schema and retention

Path: **`.local-data/competitor-email-validation/live/`** (git-ignored via `/.local-data/`; never staged).

Stored per run (`live-report.json` + `live-report.txt`):

- sanitized Terra input (brief; no secrets), Terra structured output, Terra usage metadata;
- sanitized Sol input, Sol structured output, Sol usage metadata;
- baseline artifact (subject/body/mode/schema), enriched artifact (subject/body/mode/schema);
- deterministic validation report (7A4A `ValidationReport` shape: rubric per-category + totals, delta, 16
  hard-gate results, hashes, claim ledger);
- Sol advisory critique (strict schema);
- combined operator status;
- report hash (`hashReport` + a live-extension hash covering model metadata);
- timestamps (fixture clock for hashed fields; wall-clock for run metadata only).

**Never stored:** API keys, authorization/raw provider headers, raw provider diagnostics containing secrets,
real prospect data, competitor identities, production database exports.

**Retention:** bounded **30 days** (`…_RETENTION_DAYS`, matching the 30-day evidence-freshness convention);
keep at most the latest **5** live reports per fixture id, prune older on each run. Reports are excluded from
git; a report is only ever committed if an operator deliberately curates a redacted example under
`docs/examples/` (explicitly marked synthetic).

---

## 11. Failure matrix (no silent retry, no silent fallback)

| Condition | Behavior |
|---|---|
| Terra response malformed (parse/schema fail) | FAIL CLOSED; `LIVE_TERRA_MALFORMED`; no enrichment; (default) no Sol; write failed report; nonzero exit. |
| Terra refusal / incomplete / rate_limited / transient | FAIL CLOSED with the mapped status code; no enrichment; no Sol; report; nonzero. |
| Terra email fails deterministic validation | Stop; `LIVE_TERRA_VALIDATION_FAILED` + violation codes; no enrichment; (default) no Sol (§16 U3); report; nonzero. |
| Terra introduces competitor language / `competitor_evidence_used ≠ NONE` | Treated as a validation failure (`LIVE_TERRA_COMPETITOR_LEAK`); same as above. |
| Package stale at compose time | Deterministic FAIL `PACKAGE_STALE` (reuses 7A4A revalidation); no compose; report. |
| Deterministic enrichment / hard gate / hash failure | Deterministic FAIL with the specific gate/violation code; report. |
| Sol response malformed | Documented **advisory failure**: combined status ≥ `REQUIRES_REVISION`; never overrides deterministic result; `LIVE_SOL_MALFORMED` noted; nonzero only if deterministic already failed. |
| Sol flags `unsupportedClaimSuspected` | Combined `REQUIRES_REVISION` (advisory); deterministic result unchanged. |
| Sol prefers baseline / materially worse (§9) | Combined `REQUIRES_REVISION` (advisory). |
| Sol detects mechanical wording | Combined `REQUIRES_REVISION` (advisory). |
| Provider timeout | Mapped to `transient`; FAIL CLOSED; no retry. |
| Provider rate limit | Mapped to `rate_limited`; FAIL CLOSED; no retry. |
| Token/budget limit would be exceeded | Do not call; `LIVE_BUDGET_BLOCKED`; nonzero. |
| Artifact write failure | Surface the IO error; nonzero; never silently drop the result. |

Every terminal state carries an explicit machine reason. Nothing passes by omission.

---

## 12. CLI design (repository-consistent; do **not** implement yet)

Register in `src/cli/index.ts` alongside the 7A4A `competitor-email-validation-*` commands.

- **`competitor-email-live-validation-plan`** — read-only. Prints fixture id, the two configured models,
  the call budget (max 2), the expected stages, and every required guard. **No model call, no writes.**
- **`competitor-email-live-validation-run`** — requires the full §7 guard set + `--confirm-live`. Performs
  **at most one Terra + one Sol** call. Writes only the local `live/` artifact. **No production DB write,
  no Gmail, no Sheets, no draft, no send.**
- **`competitor-email-live-validation-review`** — read-only. Loads the saved live report and prints model
  metadata, deterministic scores/gates, the Sol critique, and the combined operator status. **No model call.**

---

## 13. Test matrix (mocked providers only; no live call in impl/CI)

- exactly one Terra call (`terraCallCount === 1`); exactly one Sol call (`solCallCount === 1`);
- the **same** Terra base artifact is used for baseline and enriched (identity assertion on the base object);
- Terra failure prevents enrichment (and, default, prevents Sol);
- no competitor context in the serialized Terra request (identity-token scan);
- no raw competitor identity/domain in the serialized Sol request (sanitizer scan);
- explicit live flags required — each missing guard exits nonzero (table-driven);
- live intent never falls back to mock (`LLM_PROVIDER=openai` + missing precondition ⇒ throw, not mock);
- call budget cannot exceed two (`--max-live-calls != 2` ⇒ nonzero; counter guard ⇒ throw on 3rd call);
- Terra malformed response fails closed;
- Sol malformed response fails closed **or** yields the documented advisory failure (assert combined status);
- deterministic safety overrides Sol (inject a hard-gate violation + a glowing Sol PASS ⇒ `VALIDATION_FAILED`);
- Sol cannot approve or modify the email (no code path lets Sol output mutate the artifact/package/status
  beyond downgrade);
- fictional fixture only (`--fixture` accepts one value);
- no production DB write (write-throwing UoW double / in-memory stores; assert no pool opened);
- no Gmail / Sheets method reachable; no draft/send path invoked;
- provider usage metadata recorded safely (no key/header fields present in the artifact);
- retention prune keeps ≤ 5 latest and drops > 30-day-old reports.

Automated tests use `MockLlmProvider` responders (`defaultMockEmailResponder` for Terra; a new
`defaultMockSolCritiqueResponder` fixture for Sol). **No live call during implementation or CI.**

---

## 14. Implementation checklist (for the eventual coding milestone — not done here)

1. Add the §7 env flags to `src/config/env.ts` (default-off) + cross-validation.
2. `src/evaluation/email/live/terra-base-generator.ts` — slim single Terra call → validate → `EmailWriterParsed`
   (no DB, no reviewer); reuses `buildEmailWriterMessages` + `emailWriterSchema` + `validateEmail`.
3. Additive refactor: `runValidationHarness({ baseDraft? })` (default = fixture) so 7A4B injects the Terra draft.
4. `src/domain/email/sol-critique-schema.ts` — Zod `solCritiqueSchema` + `SOL_CRITIQUE_JSON_SCHEMA`.
5. `src/prompts/email/sol-critique.ts` — versioned Sol comparative-critique prompt (system+user builder).
6. `src/evaluation/email/live/sol-critique-input.ts` — sanitizer (baseline/enriched + anonymized metadata).
7. `src/evaluation/email/live/live-orchestrator.ts` — §3 call flow + budget counter + failure matrix.
8. `src/evaluation/email/live/live-report.ts` — live report schema, renderer, hash, retention prune.
9. `src/evaluation/email/live/live-provider.ts` — provider builder w/ the full §7 gate; no mock fallback under live.
10. `src/cli/commands/competitor-email-live-validation-{plan,run,review}.ts` + register in `src/cli/index.ts`.
11. `src/fixtures/mock-sol-critique-responses.ts` — deterministic Sol responder for tests.
12. `tests/unit/competitor-email-live-validation.test.ts` — the §13 matrix.
13. Docs: update `docs/CURRENT_STATUS.md` + `docs/ROADMAP.md`; final phase commit + annotated tag
    `phase-7a4b-live-model-validation` **after** the (separately-approved) live run — per CLAUDE.md.

---

## 15. Expected files/modules

New: `src/evaluation/email/live/{terra-base-generator,sol-critique-input,live-orchestrator,live-report,live-provider}.ts`,
`src/domain/email/sol-critique-schema.ts`, `src/prompts/email/sol-critique.ts`,
`src/fixtures/mock-sol-critique-responses.ts`,
`src/cli/commands/competitor-email-live-validation-{plan,run,review}.ts`,
`tests/unit/competitor-email-live-validation.test.ts`.
Modified (additive/backward-compatible): `src/config/env.ts` (flags), `src/evaluation/email/harness.ts`
(optional `baseDraft` param), `src/cli/index.ts` (registration), `docs/CURRENT_STATUS.md`, `docs/ROADMAP.md`.

## 15.1 Rollback plan

7A4B adds only new modules, default-off flags, three CLI commands, tests, and git-ignored `live/` artifacts;
the one existing-code touch (`runValidationHarness` optional param) is backward-compatible and defaults to the
7A4A fixture. No migration, no schema change, no production pipeline behavior change. Rollback = revert the
additive commit and reset the new flags to default; nothing to un-migrate, no state to restore, no live effect
to undo (the run writes only local git-ignored files and, when enabled, makes at most two paid read-style API
calls that leave no server-side state under `store: false`).

---

## 16. Decision approval table

Compact extract of the U1–U5 decisions. **Status** records operator action recorded 2026-08-03:
U1, U3, U4, U5 are **PRE-APPROVED**; **U2 remains OPEN** (options shown; approval NOT assumed).

| ID | Exact question | Options | Recommended | Reason | Implementation impact | Status |
|---|---|---|---|---|---|---|
| **U1** | Which model routing should 7A4B use, given production defaults (`EMAIL_WRITER_MODEL=gpt-5.6-sol`, `EMAIL_REVIEWER_MODEL=gpt-5.6-terra`) are the inverse of this brief? | **(a)** Dedicated 7A4B flags: **Terra generates**, **Sol critiques**; leave production defaults unchanged. **(b)** Reuse production `EMAIL_WRITER_MODEL`/`EMAIL_REVIEWER_MODEL` (⇒ Sol writes / Terra reviews). **(c)** Change production defaults to match the brief. | **(a)** | Honors the brief's explicit Terra=generate / Sol=critique routing without silently reusing or mutating production config; the mismatch is recorded for 7A4C to reconcile. | New `…_TERRA_MODEL` / `…_SOL_MODEL` flags (§7), independent of the production email models. No production-default change. | **✅ PRE-APPROVED (a)** |
| **U2** | How should the Sol comparative critique be wired through the closed `LlmRequest.task` union, and how are the two "sides" selected? | **(a)** Reuse `task:'email_review'` + a new `schemaName` (`email_comparative_critique`); route per side by **model** flag under a single `LLM_PROVIDER=openai`. **(b)** Add a new `email_comparative_critique` task **literal** to the `provider.ts` union + literal `…_TERRA_PROVIDER`/`…_SOL_PROVIDER` flags. | **(a)** | Minimal surface: leaves the production `LlmProvider` boundary/task union untouched; model-alias routing is already the established pattern. | (a) new Zod schema + prompt + `schemaName` only. (b) additionally edits the closed `task` union in `provider.ts` (production LLM boundary) + two extra flags. | **✅ RESOLVED — APPROVED (a) 2026-08-03** |
| **U3** | Call Sol when the Terra base email fails deterministic validation? | **(a)** Stop before Sol (no Sol call on Terra failure). **(b)** Always call Sol for advisory diagnosis. **(c)** Stop by default, but offer an opt-in `--diagnose-with-sol` single advisory diagnostic call. | **(a)** | A Sol critique of an invalid, un-enriched base spends a paid call for no operator-actionable signal and cannot change the deterministic FAIL; stopping keeps the budget at one call and the report crisp. | On Terra failure: no Sol call; successful path budget stays **one Terra + one Sol**. `--diagnose-with-sol` **not implemented** in 7A4B. | **✅ PRE-APPROVED (a); no `--diagnose-with-sol`** |
| **U4** | Live-artifact retention period and keep-count? | **(a)** 30-day retention, keep latest 5 per fixture. **(b)** Different window/keep-count. **(c)** Keep all (no prune). | **(a)** | Matches the 30-day evidence-freshness convention; bounded local footprint; artifacts stay git-ignored. | `…_RETENTION_DAYS` default 30; prune to latest 5 per fixture id in `live-report.ts`; artifacts under git-ignored `.local-data/competitor-email-validation/live/`. | **✅ PRE-APPROVED (a)** |
| **U5** | Numeric definition of "Sol rates enriched materially worse"? | **(a)** `enrichedQualityScore ≤ baselineQualityScore − 10`. **(b)** A different gap (e.g. 5 or 15). **(c)** `preferredVersion = BASELINE` alone. | **(a)** | A full 10-point band signals a real regression while ignoring critique jitter; `preferredVersion` alone is within tolerance. | Advisory-only downgrade rule in the combined-status logic (§8/§9); never overrides a deterministic PASS. | **✅ PRE-APPROVED (a)** |

**Recorded pre-approvals (2026-08-03).** U1 = dedicated 7A4B flags, Terra generates / Sol critiques,
production `EMAIL_WRITER_MODEL` / `EMAIL_REVIEWER_MODEL` **unchanged**, mismatch recorded for 7A4C review.
U3 = stop before Sol on Terra failure; `--diagnose-with-sol` **not** implemented in 7A4B; successful-path
budget strictly **one Terra + one Sol**. U4 = 30-day retention, latest 5 per fixture, git-ignored live dir.
U5 = `enrichedQualityScore ≤ baselineQualityScore − 10`.

**U2 RESOLVED — APPROVED option (a) 2026-08-03:** reuse `task: 'email_review'`; add
`schemaName: 'email_comparative_critique'`; route Terra and Sol via dedicated Phase 7A4B model flags through
the existing `OpenAiResponsesProvider` boundary; **do not** add a new task literal; **do not** modify the
production `LlmProvider` task union; **do not** change production `EMAIL_WRITER_MODEL` / `EMAIL_REVIEWER_MODEL`
defaults. All of U1–U5 are now resolved; Phase 7A4B implementation is approved.

---

## 17. Final report

**1. Recommended exact Phase 7A4B coding scope.** A guarded live path that: (a) builds a prospect-only
`EmailBrief` from the existing synthetic dental fixture and makes **exactly one** Terra `email_write` call
through the existing `OpenAiResponsesProvider`, validating the result with `emailWriterSchema` + `validateEmail`
(no DB, no reviewer); (b) injects that single validated base draft into the existing 7A4A
`runValidationHarness` (via a new optional `baseDraft` param) so deterministic enrichment, the 16 hard gates,
and the 100-point rubric run unchanged and the same artifact serves baseline and enriched; (c) makes **exactly
one** Sol comparative-critique call over a **sanitized/anonymized** input using a new strict `solCritiqueSchema`
(advisory only); (d) combines results into `READY_FOR_OPERATOR_REVIEW` / `REQUIRES_REVISION` /
`VALIDATION_FAILED` where Sol can only downgrade and never override deterministic safety; (e) writes a local,
git-ignored `live/` report; (f) exposes three read-only/guarded CLI commands. Default-off flags, hard 2-call
budget, no retries, no mock fallback under live intent, fixture-only, no DB/Gmail/Sheets/draft/send.

**2. Does the existing provider architecture support Terra and Sol routing?** **Yes.** The `LlmProvider`
boundary is model-agnostic: one `OpenAiResponsesProvider` serves both by passing the configured
`gpt-5.6-terra` / `gpt-5.6-sol` aliases per request; both have verified prices; the paid-call gate pattern
(`buildEmailProvider`) is ready to copy. **No new provider class is needed.** The one caveat is the *routing
semantics* inversion (U1), not an architectural gap.

**3. Proposed numeric definition of "Sol rates enriched materially worse".**
`enrichedQualityScore ≤ baselineQualityScore − 10` (a full 10-point band below baseline on Sol's 0–100 scale);
`preferredVersion = BASELINE` alone does not qualify within tolerance. Advisory-only.

**4. Should Sol be called when Terra fails deterministic validation?** **No** by default — stop before Sol.
Rationale in U3: a Sol critique of an invalid, un-enriched base spends a paid call for no operator-actionable
or override capability. Provide an explicit `--diagnose-with-sol` opt-in for a single advisory diagnostic if
qualitative feedback on a failure is ever wanted.

**5. Proposed artifact-retention period.** **30 days**, keep the latest **5** live reports per fixture id,
pruned each run; artifacts stay under git-ignored `.local-data/competitor-email-validation/live/`.

**6. Expected files/modules.** As listed in §15 (five new `live/` modules, `sol-critique-schema.ts`, the Sol
prompt, the mock Sol responder, three CLI commands, one test file) plus additive edits to `env.ts`,
`harness.ts` (optional `baseDraft`), `cli/index.ts`, and the two status docs.

**7. Confirmation that only the planning document changed.** This task created **only**
`docs/phase-7a4b-live-model-validation.md`. No production code, migration, fixture, or `AGENTS.md` was created
or modified; nothing was committed or pushed; no live model, real prospect, live website, Gmail, Google
Sheets, or production database was accessed; no Gmail draft, email, or record was created. Planning only.

---

Stop after creating this planning document. Phase 7A4B is **not** approved and **not** implemented. Reply
`APPROVE PHASE 7A4B` (with any decisions on U1–U5) to authorize the coding milestone.

---

## 18. Phase 7A4B implementation record (2026-08-03)

**Status: IMPLEMENTED. lint + typecheck + build green; 1137 unit tests pass (108 files), including 24 new
7A4B cases. No migration created (none needed — the path is fixture/in-memory + one optional guarded provider).
U1–U5 resolved as approved; U2 = option (a): reuse `task:'email_review'` with `schemaName:'email_comparative_critique'`.**

### What was built

- **Routing (U1).** Dedicated default-off flags `COMPETITOR_EMAIL_LIVE_VALIDATION_*` (Terra/Sol model,
  effort, cost, tokens, timeout, retention). Terra GENERATES the base email; Sol performs the ADVISORY
  critique. Production `EMAIL_WRITER_MODEL` / `EMAIL_REVIEWER_MODEL` were **not** changed.
- **Terra base generation** (`live/terra-base-generator.ts`): exactly one `email_write` call via the existing
  `OpenAiResponsesProvider`, reusing `buildEmailWriterMessages` + `EMAIL_WRITER_JSON_SCHEMA` + `emailWriterSchema`
  + `validateEmail`; no reviewer call, no DB. Fails closed on malformed/refusal/invalid and asserts
  `competitor_evidence_used=NONE`.
- **Fair comparison.** The single validated Terra draft is injected into `runValidationHarness(baseDraft)`
  (additive, backward-compatible param; `HarnessSuccess.baseDraft` now threads the actual base through, and
  `validation-report.ts` scores that draft instead of the pinned fixture). Baseline and enriched derive from
  the one artifact.
- **Sol critique** (`domain/email/sol-critique-schema.ts`, `prompts/email/sol-critique.ts`,
  `live/sol-critique-input.ts`): one `email_review` call with `schemaName='email_comparative_critique'` over a
  sanitized/anonymized input; `assertNoCompetitorIdentities` fails closed on any identity-token leak; strict
  Zod output; advisory only.
- **Budget + fail-closed** (`live/live-types.ts`, `live/live-orchestrator.ts`): `LiveCallBudget` hard ceiling
  of 2; Terra failure stops before Sol; deterministic FAIL skips Sol; real-provider runs are pre-gated on a
  worst-case cost projection. No retries, no mock fallback under live intent, no third call.
- **Combined status** (`live/live-report.ts`): `decideCombinedStatus` yields only
  READY_FOR_OPERATOR_REVIEW / REQUIRES_REVISION / VALIDATION_FAILED; Sol can only downgrade, never override a
  deterministic FAIL. Stable `reportHash` excludes volatile provider metadata; 30-day / latest-5 retention.
- **Guards** (`live/live-provider.ts`): default = deterministic mock; `--confirm-live` enforces every guard
  (feature flag, `LLM_PROVIDER=openai`, `ALLOW_PAID_LLM_CALLS`, `OPENAI_API_KEY`, verified prices,
  `--fixture synthetic-dental`, `--confirm-no-real-prospect`, `--max-live-calls 2`) and throws on any gap —
  never falls back to mock.
- **CLI**: `competitor-email-live-validation-{plan,run,review}` registered via `withConfigOnly` (no
  operational DB pool). Artifacts under git-ignored `.local-data/competitor-email-validation/live/`.

### Result of the shipped MOCK run

Combined status **READY_FOR_OPERATOR_REVIEW**: Terra base (mock) → deterministic baseline **80** → enriched
**PASS** with all 16 hard gates passing → Sol advisory **PASS** (clean). Exactly one Terra + one Sol call.

### Confirmation of no side effects

**No actual live model call occurred** during implementation or tests — the default provider is the
deterministic mock and every automated test uses mocked providers. No production database write, network
request, Gmail, Sheets, draft, or send occurred. `AGENTS.md` was not touched. No migration or production-model
default was changed (additive only). Phase 7A4C (operator go/no-go) remains a separate, unapproved milestone.

---

## 19. Phase 7A4B1 — live-email determinism fix (2026-08-03)

**Status: IMPLEMENTED. lint + typecheck + build green; standard unit suite (`vitest run tests/unit`) passes
with 24 new determinism cases. No live model, network, production DB, Gmail, Sheets, draft, or send occurred.**

### 19.1 Root cause

The first real fictional **LIVE** Terra run produced a strong result (baseline 77 → enriched 97, +20) but
`combinedStatus = VALIDATION_FAILED` on a single hard gate: `unstable_claim_spans_or_hash` —
"composed message hash not reproducible."

The composition was **never** non-deterministic. The defect was entirely inside the hard gate. Gate 16 in
`src/evaluation/email/hard-gates.ts` re-composes the email to check hash stability, but it re-composed from
the **pinned fixture** `baseEmailDraft` instead of `result.baseDraft` — the ACTUAL draft the artifact under
test was composed from:

```ts
// BEFORE (defective)
const recomposed = composeEnrichedEmail({ prospectDraft: baseEmailDraft, /* … */ });
```

- In the **offline 7A4A** path, `runValidationHarness()` defaults `baseDraft = baseEmailDraft`, so the two
  coincided and the gate passed — the bug was invisible.
- In the **live 7A4B** path, the base draft is the live **Terra** output (different subject + body). Gate 16
  re-composed from the fixture, produced a different subject/body, and therefore a different composed-message
  hash → a false "not reproducible."

**Proof it was a gate defect, not real nondeterminism:** the quality rubric's own reproducibility check
(`validation-report.ts::buildEnrichedRubricInput`) already re-composed from `result.baseDraft` (correctly)
and **passed** in the same failed run (integrity 20/20, `composed_hash_reproducible: true`). Only the
fixture-importing hard gate disagreed. Replaying the saved failed artifact offline reproduces its stored
composed-message hash `0d7e742c…` exactly.

**Exact differing field:** the `subject` and `body` inputs to the canonical composed-message hash — both
derived from the base draft, and the gate fed it the wrong (fixture) base draft.

### 19.2 The fix

- **Gate 16 recomposes from `result.baseDraft`** (the actual base draft), never a pinned fixture; the
  `baseEmailDraft` import was removed from `hard-gates.ts`. A safety gate must not depend on a test fixture.
  The claim-span check now uses the real body-derived spans and the gate emits a bounded, secret-free
  diagnostic (differing field, expected vs recomputed hash, body/subject/spans/provenance differed) on
  failure.

### 19.3 Canonical composed-message hash contract

`computeComposedMessageHash` (exported from `competitor-email-composer.ts`) is now the single source of truth
reused by the composer, the hard gate, and the offline replay. It binds every semantic + provenance-critical
field and EXCLUDES ephemeral execution metadata:

- **Included (semantic / provenance-critical):** final schema version, subject, rendered body, competitor-
  evidence mode, package id + version + hash, selected pattern id, selected contrast id, enrichment rules
  version, and the normalized claim ledger (each claim's text + prospect/competitor evidence references +
  pattern/contrast ids).
- **Excluded (ephemeral):** provider request/response ids, token usage, cost, latency, and report-generation
  timestamps — none are inputs to the hash. A required audit timestamp remains persisted OUTSIDE the hash
  input (`generatedAt`, provider `call` metadata), so it never changes the semantic hash.
- **Determinism guarantees:** canonically sorted object keys, sorted evidence-reference arrays (equivalent
  references in any order hash identically), normalized newlines (CRLF/CR → LF), UTF-8-stable `JSON.stringify`
  encoding, explicit null handling. These normalizations are **no-ops** on already-canonical input — the
  stored `0d7e742c…` hash is byte-identical before and after — so the contract is a stabilization, not a
  value change for well-formed artifacts.

### 19.4 Claim-span contract

`deriveClaimSpans(finalBody, ledger)` (in `competitor-enrichment.ts`) derives bounded `{ start, end, valid }`
offsets for every substantive claim from the FINAL rendered body:

- offsets are exact and `valid` iff `body.slice(start,end) === text` (bounded, verified traceability);
- ordering follows the ledger, which mirrors body order by construction;
- a forward-advancing cursor assigns each claim the first occurrence at/after the previous span's end, so
  **duplicate sentence text maps to distinct, unambiguous offsets**;
- the CTA marker claim (`cta:<KIND>`) is intentionally excluded (not body text);
- pure and deterministic — no randomness, no current-timestamp or locale/timezone dependency. The
  missing-traceability validation is unchanged (a claim that does not resolve fails the gate).

### 19.5 Offline replay command

`competitor-email-live-validation-replay` (module `src/evaluation/email/live/replay.ts`) validates the fix
without spending another paid live call. It:

- accepts the saved local report (default `.local-data/competitor-email-validation/live/latest.json`);
- verifies the live report hash and the deterministic-report determinism hash first (fails on any
  altered/incomplete artifact);
- **FULL** mode (report carries the persisted sanitized Terra base draft): re-runs the entire deterministic
  pipeline from that exact draft and compares the recomputed composed hash, claim spans, and determinism hash
  to the stored report;
- **REDUCED** mode (legacy report without the base draft): recomputes the composed hash canonically from the
  stored rendered subject/body + claim ledger (fixture harness supplies deterministic package provenance) and
  re-derives + validates the claim spans;
- makes **zero** Terra/Sol calls, **zero** network requests, and performs **zero** Gmail/Sheets/draft/send or
  production-database actions.

Going forward the live report persists the sanitized Terra base draft (`terraBaseDraft`, fictional-prospect
copy only, no provider metadata/secrets) to enable FULL replay; it is intentionally excluded from
`reportHash` so existing report hashes are unchanged.

### 19.6 Requirement before another paid live run

The offline replay MUST pass (`REPRODUCIBLE`) against the latest saved artifact before authorizing another
paid live Terra/Sol run. Exact commands are in `docs/OPERATIONS.md`.

## 20. Phase 7A4B2 — competitor copy-flow fix + Sol-only re-review

### 20.1 Root cause (copy flow)

The first fictional LIVE run scored well (deterministic PASS, baseline 77 → enriched 97; Sol preferred
ENRICHED 89 vs 80) but combined status was `REQUIRES_REVISION` because Sol raised two copy defects:

1. **The booking-discoverability consequence was stated twice.** The competitor section rendered a fixed
   `CAUTIOUS_CONSEQUENCE` sentence (`That may make booking harder for a first-time visitor to find.`) while the
   Terra-authored recommendation paragraph already expressed the same booking-friction consequence.
2. **Mechanical wording.** A hardcoded contrast sentence (`On your own site this option is not currently
   surfaced the same way.`) and the frame verb "surface" read like inserted rubric language rather than
   outreach copy.

Both were hardcoded strings that rendered unconditionally, regardless of what the base draft already said.

### 20.2 Revised rendering rule (structured, not semantic)

`buildCompositionSections` now derives, from the STRUCTURED base composition (its opening
`PROSPECT_OBSERVATION` section and any following `RECOMMENDATION` section — presence/absence, never word
matching), whether the base already carries an aligned prospect observation and an aligned
recommendation/consequence:

- **Default (base has both):** the external competitor section is EXACTLY ONE competitor-pattern sentence. No
  contrast, no cautious consequence.
- **Base lacks an aligned recommendation:** the cautious consequence is rendered to supply the missing aligned
  element.
- **Base lacks an aligned prospect observation (and the package holds a contrast):** the contrast is rendered.
- If a lack cannot be proven deterministically, the extra sentence is omitted (fail-safe).

`decideCompetitorRender` is the single pure decision; `buildClaimLedger` re-derives it from the built sections
so the ledger, the redundancy gate, and the final-body validator stay consistent with what was rendered.

### 20.3 Before → after (synthetic scenario)

```
before: All three comparable nearby clinics surface a booking action directly on their homepage. On your own
        site this option is not currently surfaced the same way. That may make booking harder for a first-time
        visitor to find.
after:  All three comparable nearby clinics make booking available directly from their homepage.
```

Final flow: Terra prospect observation → one concise competitor-pattern sentence → Terra recommendation →
Terra CTA. Baseline/enriched scores (77 → 97) and the exact three-of-three count are unchanged; the composed
message hash changes by design (`09dbc2bd…` → `ad6ae0c4…`).

### 20.4 Claim ledger + provenance

The claim ledger contains ONLY sentences rendered externally — for the synthetic scenario:
`PROSPECT_OBSERVATION → COMPETITOR_PATTERN → RECOMMENDATION → CTA` (no `PROSPECT_CONTRAST`, no
`CAUTIOUS_CONSEQUENCE`). The contrast/consequence label and evidence references remain internal
package/plan provenance (`plan.selection.contrast`, `plan.selection.pattern.consequenceLabel`), so material
alignment and the rubric's material-relevance checks are unaffected.

### 20.5 Natural category templates (§4)

The three enrichable categories carry fixed conversational, count-safe templates (the exact stored count
phrase is inserted verbatim; no "surface"): booking → `…make booking available directly from their
homepage.`; phone → `…show a direct phone option on their homepage.`; direct messaging → `…offer a direct
messaging option on their homepage.` No evidence capability is broadened (location/hours and FAQ remain
non-aligned and are not rendered).

### 20.6 Structured redundancy gate (§5)

`detectStructuredRedundancy` (surfaced as the 17th hard gate `structured_copy_redundancy`) fails closed when:
a rendered consequence duplicates the label of the base recommendation; more than one external sentence serves
the one approved consequence label; or a contrast is rendered although the base already supplies the prospect
observation. It is derived from the structured ledger, never from word overlap.

### 20.7 Offline recomposition command (§6)

`competitor-email-live-validation-recompose` (module `src/evaluation/email/live/recompose.ts`) loads a saved
full live report, verifies report + determinism + baseline + package hashes, reuses the EXACT saved Terra base
draft, rebuilds the enriched email/ledger/hashes with the current templates, reruns the rubric + all hard
gates, and writes a NEW local report. It never overwrites the source and makes ZERO Terra/Sol, network,
Gmail, Sheets, draft, send, or production-DB calls.

### 20.8 Guarded Sol-only re-review command (§7)

`competitor-email-live-validation-rereview` (module `src/evaluation/email/live/rereview.ts`) requires a valid
full source artifact, reuses the exact stored Terra draft (NO Terra call), recomposes with current
deterministic logic, REQUIRES a deterministic PASS before Sol, then makes EXACTLY ONE Sol call using the
approved `gpt-5.6-sol` flag over sanitized fictional data. Guards (all required for the paid path):
`COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=true`, `LLM_PROVIDER=openai`, `ALLOW_PAID_LLM_CALLS=true`, an API
key, `--confirm-live`, `--fixture synthetic-dental`, `--confirm-no-real-prospect`, and `--max-live-calls 1`.
It never retries, never falls back to mock under live intent, and never modifies either email after Sol
responds. The new report links back to the source by `sourceReportHash`.

### 20.9 Combined status policy (unchanged)

`READY_FOR_OPERATOR_REVIEW` still requires deterministic PASS, no Sol unsupported-claim suspicion, no Sol
critical issue, enriched not materially worse, and a Sol PASS verdict. Mechanical wording without a critical
issue may remain advisory; any Sol critical issue still yields `REQUIRES_REVISION`. The acceptance policy was
not loosened.
