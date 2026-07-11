# Risk Register

Ranked by current exposure. Reviewed at each phase gate.

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| R-01 | Model hallucination introduces fabricated facts into emails. | Med | High | Evidence rule + Zod validation + independent reviewer + hard-fail conditions + one rewrite cap → manual review. | System | Mitigated by design |
| R-02 | Accidental outbound action (send/draft/publish) before approval. | Low | High | Global `OUTBOUND_ACTIONS_ENABLED` kill switch + approved-state gates + dry-run default + phase gating. | System | Mitigated by design |
| R-03 | Uncontrolled API/model cost. | Med | Med | Per-run + per-lead cost caps; field-restricted API calls; pipeline stops safely at limit; usage logged. | System | Planned (P2/P5) |
| R-04 | Docker Desktop / WSL 2 setup friction on Windows blocks Phase 1. | Med | Med | Decision D-0002 documented; `DATABASE_URL` abstraction allows native/Supabase fallback. | User | Open (pre-P1) |
| R-05 | Duplicate processing/contacting of the same lead. | Med | Med | Stable identity keys + deterministic dedup + idempotent, resumable stages. | System | Planned (P1/P2) |
| R-06 | Disrespectful/ToS-violating scraping. | Low | High | Public info only; no CAPTCHA/auth/anti-bot bypass; no form submits; rate limits, timeouts, descriptive UA. | System | Mitigated by design |
| R-07 | Secret leakage (API keys committed or logged). | Low | High | `.env` git-ignored; `.env.example` only; startup env validation; secret redaction in logs; least-privilege keys. | System | Mitigated by design |
| R-08 | Deceptive demo mistaken for the live site. | Low | High | noindex/nofollow; concept/demo disclosure; no fabricated content; local-only before P10. | System | Planned (P7/P10) |
| R-09 | Email deliverability / spam / legal exposure at sending. | Med | High | Sending isolated to P13 behind explicit request + separate sending plan (SPF/DKIM/DMARC, unsubscribe, suppression, bounce, ramp). | User+System | Deferred (P13) |
| R-10 | Over-engineering / premature abstraction slows delivery. | Med | Med | Deterministic-pipeline-first; no infra without proven need; dependency justification rule. | System | Ongoing |
| R-11 | Provider lock-in to one LLM vendor. | Low | Med | `LlmProvider` interface + env-driven model names + mock provider; concrete provider deferred to P5. | System | Mitigated by design |
| R-12 | Prompt regressions silently degrade quality. | Med | Med | Versioned prompt files + eval fixtures + documented quality thresholds; never silently replace a prod prompt. | System | Planned (P5/P8) |
