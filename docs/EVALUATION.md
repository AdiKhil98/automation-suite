# Evaluation Strategy

**Status:** Phase 0 (design; harness lands in Phase 5).
**Last updated:** 2026-07-11

Quality is judged by fixed fixtures and measurable evaluations — never by whether a model response "sounds
good."

## Tracked metrics

- Qualification precision
- Duplicate rate
- Website capture success rate
- Unsupported-claim rate
- Audit usefulness
- Email factual accuracy
- Manual approval rate
- Average cost per accepted lead
- Average cost per approved email
- Time per lead
- Eventual reply rate / positive reply rate / meeting rate
- Unsubscribe rate / bounce rate

## Evaluation dataset (fixtures)

Curated, controlled cases — no live prospect data in the standard suite:

- Clearly strong leads; clearly weak leads.
- Modern websites that should be **rejected** (good site ≠ target).
- Old websites with strong conversion paths (age alone ≠ opportunity).
- Websites with insufficient evidence.
- Chain businesses (should be filtered).
- Missing websites.
- Ambiguous CTAs.
- Multiple languages.
- Unreachable websites.

## Prompt versioning

Every agent prompt is a versioned file. For each, record:

```text
prompt name
prompt version
model
reasoning setting
schema version
evaluation score
date activated
```

A production prompt is never silently replaced. A new version must be evaluated against the fixtures and
recorded before activation.

## Deterministic qualification (Phase 3)

Qualification is fully deterministic, so it is exactly reproducible for evaluation: every result stores the
`rulesVersion` and a `rulesConfigHash`, plus an `inputFingerprint` computed from canonically-sorted rule and
fact inputs (timestamps and ids excluded). Identical inputs always yield an identical fingerprint and
decision, making qualification-precision measurable against fixtures without model variance. Results are
append-only, so rule changes preserve prior qualification history for before/after comparison.

## Enrichment (Phase 4)

Website verification is deterministic and reproducible: strict signal scoring against fixed HTML fixtures with
a stubbed fetcher yields identical outcomes every run. Track: official-site verification precision, ambiguous
rate, browser-required rate, no-verified-candidate rate, and (when the Google context provider is enabled)
reads + estimated cost per accepted lead. No model, so there is no output variance to average out.

## Website capture (Phase 5)

Capture is deterministic and non-subjective (no quality judgements — those are Phase 6). Versioned inputs
(emulation profile, page-selection policy, extractor, browser/Playwright version) are stored per run, and a
normalized evidence fingerprint (timestamps/nonces excluded) enables semantic unchanged-page detection.
Track: capture success rate, partial-capture rate, browser-blocked / bot-challenge / auth-required rates,
mobile-overflow incidence, and artifact dedup ratio. The mock provider gives fully reproducible fixtures; the
real browser is exercised by `pnpm test:browser` against local fixtures.

## AI website audit (Phase 6)

The first model-dependent stage, so evaluation is two-layered:

**Deterministic layer (every call, production + eval):** all acceptance gates are code — schema validity (Zod),
evidence-ID membership in the sent package, canonical-URL membership, forbidden-claim/placeholder/prompt-leak
denylists, reviewer-ref mapping, finding caps (≤5, ≤3 outreach-safe). Opportunity scores are computed from
versioned rules (`opp-rules-1`; config hash + per-finding breakdown rows persisted), so every score is exactly
reproducible from the DB.

**Eval matrix (Gate B):** `pnpm cli eval-audit` runs a fixed 16-case dataset
(`src/evaluation/audit/eval-cases.ts`) — good/weak sites, missing CTA/contact/trust, mobile overflow,
desktop↔mobile mismatch, minimal evidence, Hebrew content, stale info, and **4 prompt-injection attacks**
(instruction in heading/CTA, prompt-leak request, attacker-URL bait) — across generator×reviewer model combos
(asymmetric allowed). Graders are deterministic only: schema validity, evidence grounding, injection-marker
absence, attacker-URL absence, review mapping, finding-count range, expected-category presence. Reports are
JSON under `eval-reports/` with per-case per-grader results; model selection is made from these numbers.

Reproducibility stamps persisted per audit run: rubric/generator-prompt/reviewer-prompt/schema/rules versions,
input fingerprint (lead + evidence ids + image hashes + versions), resolved model, reasoning effort, image
detail, token/cost usage per call. Mock provider passes the full safety layer at 100% and runs free in CI;
category-judgment graders are expected to be meaningful only for real models.

## Quality gates

- Phase 5 (audit) and Phase 8 (email) each define a documented minimum quality threshold on the fixture set
  that must be met before the phase is approved.
- No paid API calls in the standard test suite; evaluation uses the mock provider or recorded fixtures.
