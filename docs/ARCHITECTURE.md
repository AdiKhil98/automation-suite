# Architecture

**Status:** Phase 0 (draft, approved-pending)
**Last updated:** 2026-07-11

## 1. Guiding principles

- **Deterministic pipeline first.** Small, testable, single-responsibility modules chained explicitly. No
  autonomous multi-agent orchestration until a simpler bounded design is proven insufficient by evaluation.
- **Deterministic logic before AI.** Code owns arithmetic, thresholds, dedup, state transitions, validation,
  URL normalization, rate limiting, retries, filtering, cost/sending limits, suppression. AI is confined to
  interpretation, summarization, positioning comparison, angle selection, and email drafting/review.
- **Provider-agnostic AI.** All model access flows through one `LlmProvider` interface. Model names live in env.
- **Structured output only.** Every model call returns Zod-validated structured data. No prose regex parsing.
- **Reversible + auditable.** Migrations for schema, feature flags for incomplete integrations, audit logs for
  state transitions and model calls.

## 2. Runtime shape

CLI-first. A single Node process runs a pipeline over leads, one stage at a time, each stage idempotent and
resumable. A review dashboard arrives only in Phase 9. No long-running services, queues, or brokers in the MVP.

```
niche/campaign config
   → collect → normalize → dedup → qualify
   → capture (Playwright) → extract evidence
   → AI audit → opportunity → [competitor research]
   → demo decision → [demo build]
   → email write → email review
   → READY_FOR_HUMAN_APPROVAL  ── (human) ──▶ approve
   → [Gmail draft] → [send]      (later, flag-gated phases)
```

## 3. Repository structure

Root is **`automation-suite/`** (documented deviation from the spec's `outreach-system/`; see
[DECISIONS.md](DECISIONS.md) D-0003). Tables/modules are introduced only when their phase requires them.

```text
automation-suite/
├── src/
│   ├── cli/
│   ├── config/                 # env schema + validation, versioned rule/weight config
│   ├── domain/                 # leads, evidence, audits, demos, emails, campaigns
│   ├── pipeline/               # stage orchestration + state machine
│   ├── agents/                 # qualification, website-audit, opportunity,
│   │                           # competitor-research, demo-decision, email-writer, email-reviewer
│   ├── integrations/           # google-places, browser, openai, anthropic, gmail, google-sheets, netlify
│   ├── persistence/            # db client, repositories, migrations glue
│   ├── prompts/                # versioned prompt files
│   ├── evaluation/             # eval harness + scoring
│   └── utils/
├── demo-site/
├── migrations/
├── tests/ { unit, integration, fixtures, evaluation }
├── scripts/
├── docs/
├── .github/workflows/
├── docker-compose.yml
├── .env.example
├── CLAUDE.md
└── README.md
```

## 4. Lead state machine

States:

```text
NEW NORMALIZED DUPLICATE REJECTED_AUTOMATICALLY READY_FOR_QUALIFICATION QUALIFIED NEEDS_MANUAL_REVIEW
REJECTED READY_FOR_AUDIT AUDITED OPPORTUNITY_READY COMPETITOR_RESEARCH_READY DEMO_DECIDED DEMO_READY
EMAIL_DRAFTED EMAIL_REVIEW_FAILED EMAIL_APPROVED READY_FOR_HUMAN_APPROVAL HUMAN_APPROVED DRAFT_CREATED
SENT REPLIED UNSUBSCRIBED BOUNCED FAILED
```

Rules:

- Transitions are validated in code via an explicit allowed-transition map.
- An invalid transition throws a typed `InvalidStateTransitionError` and writes a `pipeline_events` audit row.
- `NEEDS_MANUAL_REVIEW` and `REJECTED` are terminal-ish holding states reachable from most active states.
- `UNSUBSCRIBED` is absorbing and gated by the suppression list — a suppressed lead can never re-enter sending.

Proposed allowed transitions (finalized in Phase 1):

```
NEW → NORMALIZED
NORMALIZED → DUPLICATE | REJECTED_AUTOMATICALLY | READY_FOR_QUALIFICATION
READY_FOR_QUALIFICATION → QUALIFIED | READY_FOR_ENRICHMENT | REJECTED | NEEDS_MANUAL_REVIEW
QUALIFIED → READY_FOR_CAPTURE                                   # capture precedes audit (Phase 5)
READY_FOR_ENRICHMENT → ENRICHED | NEEDS_MANUAL_REVIEW | FAILED   # Phase 4 enrichment
ENRICHED → READY_FOR_QUALIFICATION                              # re-qualify with enriched facts
READY_FOR_CAPTURE → CAPTURED | NEEDS_MANUAL_REVIEW | FAILED      # Phase 5 capture
CAPTURED → READY_FOR_AUDIT
READY_FOR_AUDIT → AUDITED | NEEDS_MANUAL_REVIEW | FAILED
AUDITED → OPPORTUNITY_READY | NEEDS_MANUAL_REVIEW
OPPORTUNITY_READY → COMPETITOR_RESEARCH_READY | DEMO_DECIDED
COMPETITOR_RESEARCH_READY → DEMO_DECIDED
DEMO_DECIDED → DEMO_READY | EMAIL_DRAFTED         # DEMO_READY only when demo tier ≠ NONE
DEMO_READY → EMAIL_DRAFTED
EMAIL_DRAFTED → EMAIL_APPROVED | EMAIL_REVIEW_FAILED
NEEDS_MANUAL_REVIEW → READY_FOR_QUALIFICATION | READY_FOR_ENRICHMENT | READY_FOR_AUDIT | REJECTED
EMAIL_REVIEW_FAILED → EMAIL_DRAFTED | NEEDS_MANUAL_REVIEW    # one rewrite cycle only
EMAIL_APPROVED → READY_FOR_HUMAN_APPROVAL
READY_FOR_HUMAN_APPROVAL → HUMAN_APPROVED | REJECTED
HUMAN_APPROVED → DRAFT_CREATED                     # Phase 11+, flag-gated
DRAFT_CREATED → SENT                               # Phase 13+, flag-gated
SENT → REPLIED | BOUNCED | FAILED
(any active) → UNSUBSCRIBED                         # suppression overrides everything
```

## 5. Domain entities (design now, create per phase)

```text
niches campaigns locations leads lead_sources business_contacts website_snapshots evidence
qualification_results website_audits competitor_snapshots opportunities demo_decisions demo_instances
email_drafts email_reviews human_approvals suppression_list pipeline_runs pipeline_events model_calls cost_records
```

Phase 1 creates only: `leads`, `evidence`, `pipeline_runs`, `pipeline_events`, plus a `model_calls` record type
(table when first model call exists). Others land in their owning phase.

## 6. Provider abstraction

```ts
export interface LlmProvider {
  generateStructured<TInput, TOutput>(request: {
    task: string;
    input: TInput;
    outputSchema: unknown;             // Zod schema
    model: string;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
    maxOutputTokens?: number;
    timeoutMs?: number;
    previousResponseId?: string;
  }): Promise<{
    output: TOutput;
    provider: string;
    model: string;
    responseId?: string;
    usage?: {
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      estimatedCostUsd?: number;
    };
  }>;
}
```

Implementations: a **mock provider** (tests, deterministic) and **one configurable production provider**
(chosen via env). OpenAI and Anthropic implementations must be addable without touching business logic.

### Env-driven model selection

```text
LLM_PROVIDER=
LLM_MODEL_RESEARCH=
LLM_MODEL_AUDIT=
LLM_MODEL_EMAIL_WRITER=
LLM_MODEL_EMAIL_REVIEWER=
```

## 7. Agent output contracts (Zod-enforced)

```ts
// PRE_AUDIT qualification (Phase 3). `ACCEPT` = worth enriching/auditing, NOT
// outreach-ready. Deterministic; no AI. opportunityScore stays null until Phase 6.
type QualificationResult = {
  leadId: string; campaign: string; qualificationStage: "PRE_AUDIT";
  rulesVersion: string; rulesConfigHash: string; evaluatedAt: string;
  businessViabilityScore: number | null; auditabilityScore: number | null;
  contactabilityScore: number | null; opportunityScore: number | null;
  deterministicScore: number | null;                         // composite = 0.6*viability + 0.4*auditability
  decision: "ACCEPT" | "REVIEW" | "REJECT";
  priority: "HIGH" | "MEDIUM" | "LOW" | "UNASSIGNED";
  nextStep: "AUDIT" | "WEBSITE_DISCOVERY" | "NEEDS_ENRICHMENT" | "MANUAL_REVIEW" | "SKIP";
  triggeredRules: string[]; missingRequiredFacts: string[]; reasons: string[];
  inputFingerprint: string; inputFactIds: string[];          // via qualification_result_facts join
};

// Facts carry per-fact provenance in `lead_facts` (authoritative); `leads.*` fact
// columns are a derived current-value projection. Qualification reads only current
// facts with source_type in {mock, manual, website} — never Google content.

type AuditFinding = {
  issue: string; evidenceIds: string[]; businessImpact: string;
  confidence: number; safeForOutreach: boolean;
};

type EmailDraft = {
  subject: string; body: string; evidenceIdsUsed: string[]; personalizationPoints: string[];
  ctaType: "ASK_IF_RELEVANT" | "ASK_FOR_FEEDBACK" | "ASK_TO_SEND_DETAILS" | "ASK_FOR_SHORT_CALL";
  wordCount: number;
};

type EmailReview = {
  pass: boolean; overallScore: number;
  scores: { accuracy: number; personalization: number; clarity: number; brevity: number;
            humanTone: number; credibility: number; cta: number };
  unsupportedClaims: string[]; problems: string[];
  finalSubject: string; finalBody: string;
};
```

The deterministic qualification score is computed in code from versioned weights. AI may annotate/interpret
but must never mutate the numeric score.

## 8. Validation + failure handling

- On schema-validation failure: retry once with a schema-repair instruction → if still failing, record the
  failure and mark the lead `NEEDS_MANUAL_REVIEW`.
- Every external call: timeout, retry policy, max retries, exponential backoff where appropriate, structured
  error logging. Model calls log usage + estimated cost; secrets are never logged.

## 9. Idempotency

Stable lead identity derived from an appropriate combination of Google Place ID, normalized domain,
normalized business name, and location. Each stage is safely repeatable — a rerun updates/resumes a record
rather than creating uncontrolled duplicates.

## 10. Chosen technical foundation

Node 22 LTS · TypeScript strict · pnpm · Zod · Vitest · Playwright · Pino · ESLint · Prettier · PostgreSQL ·
**Drizzle ORM** (see D-0001) · Docker Compose for local Postgres · env validation at startup · GitHub Actions
CI · Netlify for demos · CLI-first (dashboard later). No dependency without a documented reason.

## 11. Browser runtime distinction

There are two distinct "browsers" in this project; they must not be conflated:

- **Development / research / QA browser (Claude Code):** Claude Code's built-in web browsing and screenshot
  capability may be used during development, research, debugging, and visual QA. It is a tool for *building*
  the system.
- **Production browser runtime (Playwright):** The deployed daily automation performs all website capture and
  evidence extraction with **Playwright**, beginning in Phase 4. Playwright is the only browser runtime the
  running pipeline depends on.

Claude Code's browsing is never part of the production pipeline, and Playwright is never used merely for
development convenience. Any website-capture code committed to the pipeline targets Playwright.

**Phase 4 uses HTTP only.** Enrichment (website discovery/verification) uses SSRF-hardened HTTP GET +
deterministic cheerio parsing — no browser. Client-rendered pages that cheerio cannot read are returned as
`BROWSER_REQUIRED` and deferred to the Phase 5 Playwright capture.

## 12. Enrichment pipeline (Phase 4)

Layered `EnrichmentContextProvider → CandidateProvider → WebsiteVerifier → verified facts`. Context
(facts/manual/google/mock) is in-memory only; the official website is the sole authoritative durable source.
Nine-outcome taxonomy (VERIFIED, AMBIGUOUS, INSUFFICIENT_CONTEXT, NO_CANDIDATE, NO_VERIFIED_CANDIDATE,
BROWSER_REQUIRED, TRANSIENT_ERROR, POLICY_BLOCKED, INVALID_INPUT) maps to lead states; lead-level `FAILED` is
reserved for internal unrecoverable errors. Network runs outside the DB transaction; a single per-lead
transaction then writes attempt + candidates + signals + facts (idempotent, provenance-aware) + projection +
state transition + event. Facts: `official_domain` / `official_website_url` / `official_location_page_url` are
distinct (branches share a domain). Per-fact provenance strength website > manual > mock; manual conflicts are
preserved and routed to review, never auto-superseded.

## 13. Website capture (Phase 5)

Playwright renders Phase-4-verified official websites (mock provider by default; no LLM). Two purposes:
`AUDIT_CAPTURE` (normal, for leads with verified official facts → `CAPTURED` → `READY_FOR_AUDIT`) and
`VERIFICATION_CAPTURE` (re-render a Phase-4 `BROWSER_REQUIRED` candidate and re-run the deterministic verifier
on the rendered DOM — only a verified official association writes facts; it never becomes audit-ready merely by
rendering). A nine-outcome taxonomy maps to lead states; lead-level `FAILED` is reserved for internal errors.
A fresh isolated context per lead **and per profile** (desktop 1440×900, mobile 390×844), SSRF-hardened
navigation, and a PSL-aware `VerifiedOriginPolicy`. Browser/network runs outside the DB transaction; a single
per-lead transaction writes run + pages + artifact metadata + evidence + errors + fact writes + state + event,
with content-addressed screenshot blobs committed after commit / discarded on rollback. No full HTML persisted.
Real captures require a hardened, network-isolated container (docs/deploy/hardened-browser.md).

## 14. AI website audit & opportunity analysis (Phase 6)

The first LLM stage. Flow per `READY_FOR_AUDIT` lead:
`EvidencePackageBuilder → generator call → deterministic validation → ReviewerPackageBuilder → independent
adversarial reviewer call → deterministic acceptance → deterministic opportunity scoring → atomic persistence`.

- **Provider port:** the domain depends only on `LlmProvider` (`src/integrations/llm/provider.ts`).
  `MockLlmProvider` is the default (tests/CI/mock runs are free); `OpenAiResponsesProvider` adapts the OpenAI
  Responses API (json_schema strict output, multimodal input of primary viewport screenshots, `store:false`,
  no tools). Paid calls require the separate `ALLOW_PAID_LLM_CALLS` kill switch + key + verified price table.
- **Model classifies, code decides:** the model proposes findings with temporary `findingRef`s citing evidence
  IDs from the package; code validates (evidence membership, canonical-URL checks, forbidden-claim denylists),
  applies reviewer decisions/revisions, caps to ≤5 findings (≤3 outreach-safe), generates DB UUIDs, and
  computes all scores from versioned rules with a persisted per-finding breakdown.
- **Call budget:** ≤2 generator + ≤2 reviewer attempts (≤4 calls/lead), plus run-level call/cost caps; every
  attempt is recorded in `model_calls` even on failure. 12-outcome taxonomy routes leads
  (AUDITED → OPPORTUNITY_READY; transient/rate-limit/budget stay READY_FOR_AUDIT; rest → NEEDS_MANUAL_REVIEW).
- **Crash economics:** model calls happen outside the DB transaction; a local recovery envelope is written
  (atomic rename) *before* the transaction, deleted on success, and replayed idempotently by `resume-audit` —
  a DB failure never repeats a paid call.
- **Injection posture:** website text is pinned as untrusted data; validators + the Gate-B eval dataset
  (with planted attacks) verify resistance deterministically.
