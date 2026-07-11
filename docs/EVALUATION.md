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

## Quality gates

- Phase 5 (audit) and Phase 8 (email) each define a documented minimum quality threshold on the fixture set
  that must be met before the phase is approved.
- No paid API calls in the standard test suite; evaluation uses the mock provider or recorded fixtures.
