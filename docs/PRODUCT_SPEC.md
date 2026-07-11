# Product Specification

**Status:** Phase 0 (draft, approved-pending)
**Last updated:** 2026-07-11

## 1. Mission

A controlled, auditable AI outreach operating system that turns a chosen niche + geography into a small,
high-quality, human-reviewable daily batch of personalized cold emails backed by verifiable evidence.

Quality over volume. Reversible over fast. Human-approved sending until explicitly changed.

## 2. Who it is for

A single operator selling **website design** and (potentially) **AI automation** services to local
businesses. The operator reviews and sends; the system prepares and justifies.

## 3. In scope

- Niche research and selection support (human-approved).
- Lead collection (Google Places via a provider abstraction; mock-first).
- Deterministic deduplication + qualification.
- Website capture + evidence extraction (Playwright).
- AI website audit + opportunity analysis (evidence-bound).
- Optional competitor research for higher-value leads.
- Demo decision (`NONE`/`SHARED`/`BRANDED`) + a reusable per-niche demo template.
- Evidence-limited email writing + independent review.
- Local-first outputs: files, DB records, and a later review dashboard.
- Later approved phases: Netlify preview deploys, Gmail draft creation, scheduling, controlled sending.

## 4. Out of scope

- n8n as a core dependency (optional external add-on only).
- Unrelated brands/projects (PureCrunch, KP Medical, etc.).
- Kubernetes, microservices, Redis, queues, event buses in the MVP.
- Autonomous multi-agent orchestration before a simple deterministic pipeline is proven.
- Any outbound action before its phase is approved and feature flags are enabled.

## 5. Lead lifecycle (high level)

`NEW → NORMALIZED → (DUPLICATE | REJECTED_AUTOMATICALLY | READY_FOR_QUALIFICATION) → QUALIFIED →
READY_FOR_AUDIT → AUDITED → OPPORTUNITY_READY → (COMPETITOR_RESEARCH_READY) → DEMO_DECIDED → DEMO_READY →
EMAIL_DRAFTED → (EMAIL_REVIEW_FAILED | EMAIL_APPROVED) → READY_FOR_HUMAN_APPROVAL → HUMAN_APPROVED →
DRAFT_CREATED → SENT → (REPLIED | UNSUBSCRIBED | BOUNCED | FAILED)`

`NEEDS_MANUAL_REVIEW` and `REJECTED` are reachable from multiple stages. Full state machine in
[ARCHITECTURE.md](ARCHITECTURE.md).

## 6. Core invariants

1. **Human approval** — until an explicitly approved later phase: never send email, never publish a branded
   prospect demo publicly, never modify a prospect's systems, never contact a prospect, never create a Gmail
   draft, never auto-schedule follow-ups. Early versions produce local files / DB records / dashboard entries only.
2. **Evidence** — every personalization claim maps to stored `Evidence`. The writer uses only approved evidence.
   Unverifiable facts never appear as factual statements.
3. **No fabrication** — see the hallucination list in [CLAUDE.md](../CLAUDE.md). Use `unknown` /
   `needs_manual_review` when evidence is insufficient.
4. **Respectful research** — no CAPTCHA/auth/anti-bot bypass, no private-area scraping, no form submission, no
   full-site copying, no impersonation. Public business info only. Rate-limited, timed out, retried, descriptive UA.
5. **Cost + safety limits** — configurable per-run and per-lead caps; the pipeline stops safely at a limit.
6. **Kill switch** — `OUTBOUND_ACTIONS_ENABLED=false` blocks all sending integrations regardless of state.

## 7. Evidence model

```ts
type Evidence = {
  id: string;
  leadId: string;
  sourceType:
    | "google_places" | "website_html" | "website_screenshot"
    | "website_metadata" | "competitor_website" | "manual";
  sourceUrl: string | null;
  capturedAt: string;
  claim: string;
  rawEvidence: string;
  confidence: number;
  screenshotPath?: string;
  selector?: string;
};
```

## 8. Key agent outputs (contracts)

`QualificationResult`, `AuditFinding`, `EmailDraft`, `EmailReview` — schemas defined in
[ARCHITECTURE.md](ARCHITECTURE.md) and enforced with Zod. Deterministic scoring is never modified by a model.

## 9. Success criteria (product-level)

- The operator can, for every generated statement, trace **why** it was written (evidence + audit + prompt version).
- Low unsupported-claim rate; high email factual accuracy; manageable daily batch size.
- Full metric set tracked per [EVALUATION.md](EVALUATION.md).

## 10. Non-goals for the MVP

Maximizing lead count, full automation of sending, or a polished public product. The MVP is a disciplined,
inspectable pipeline the operator trusts.
