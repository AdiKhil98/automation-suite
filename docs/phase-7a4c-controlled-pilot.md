# Phase 7A4C — Production Go/No-Go and First Controlled Outreach Pilot (Planning)

> **STATUS: PLANNING ONLY — NOT APPROVED, NOT IMPLEMENTED.** This document is a readiness assessment and an
> operator playbook. It writes no code, contacts no prospect, accesses no live competitor website, calls no
> Terra/Sol or any live model, touches no Gmail/Sheets/production DB, creates no migration, changes no model
> routing, and does not commit, push, or touch `AGENTS.md`. It only creates this file. Every side-effectful
> action described below is an **operator-run** step requiring separate, explicit authorization.

Verified against commit **`a67628a`** (`fix(outreach): remove redundant competitor email copy`) on `main`.

---

## 0. Executive summary

The pipeline is **technically capable of preparing and internally approving real prospect emails today** — the
competitor research → capture → pattern → enrichment → composition → validation → tracking → reconciliation
stack is implemented, default-off, and covered by tests. However, **sending is blocked by an unresolved
deliverability failure**: the only real send this project ever attempted (the Phase 17B smoke test from
`admin@scaleflow.it.com` to `kheadi10@gmail.com`) was rejected by Gmail with `550 5.7.1 — likely unsolicited
mail`, and **no repository or operator evidence records any later successful manual delivery** from that mailbox
to a personal Gmail inbox. A manually written email was reportedly also rejected.

Therefore the honest overall status is:

> ### `TECHNICALLY_READY_BUT_DELIVERABILITY_BLOCKED`

Preparation **may** begin (prepare + research + compose + internally approve up to five prospects). Sending
**may not** begin until a fresh, simple, human-written email from `admin@scaleflow.it.com` is proven to land in
a personal Gmail inbox (Inbox or Spam, no `550`). Recommended first pilot size: **three prospects**, one niche,
one market, one prospect at a time. Recommended model routing: **Option B** — a pilot-only override that mirrors
the validated behaviour (Terra writer, Sol reviewer), **not** a global production-default change.

**No code is required to *prepare* the pilot** — every needed CLI command already exists. A small, optional
readiness-check command is a nice-to-have, not a blocker. The one genuine operational gap is that there is **no
CLI path for the plain manual deliverability probe** (step 2 below); that is deliberately a human action in the
Gmail UI.

---

## 1. Current verified state (by inspection, not by documentation)

### 1.1 Git + migrations

- HEAD `a67628a`; branch `main`; working tree clean except an untracked `AGENTS.md` (not touched here).
- Migration journal is contiguous through **`0032_email_competitor_enrichment.sql`**. Outreach tracking and
  delivery reconciliation land at `0026` (tracking), `0027` (delivery events), `0028` (delivery-event
  supersede/correction). Competitor stack: `0029` (research) → `0030` (evidence capture) → `0031` (pattern
  packages) → `0032` (email enrichment). **No migration is required for Phase 7A4C preparation.**

### 1.2 Phase 7 competitor stack (all implemented, default-off)

| Sub-phase | What exists | Flag (default) |
|---|---|---|
| 7A1 | deterministic competitor candidate selection (`comp-cmp-1`, threshold 70, ≤3, radius 5→10 km) | `COMPETITOR_RESEARCH_ENABLED=false` |
| 7A2 | verified website evidence capture (`comp-ev-1`, ≤2 pages/competitor, 30-day freshness, no raw HTML) | `COMPETITOR_CAPTURE_ENABLED=false` |
| 7A3A | deterministic pattern packages + human approval (`competitor-pattern-2026-08-01`) | `COMPETITOR_PATTERN_ENABLED=false` |
| 7A3B | approved-package email enrichment (`email-copy-schema-3`, model never authors competitor text) | `COMPETITOR_EMAIL_ENRICHMENT_ENABLED=false` |
| 7A4A | offline synthetic end-to-end harness (baseline→enriched, 17 hard gates) | (test harness) |
| 7A4B / B1 / B2 | guarded fictional Terra/Sol live validation + determinism + copy-flow fixes | `COMPETITOR_EMAIL_LIVE_VALIDATION_ENABLED=false` |

Final fictional live re-review (as reported): Terra calls 0, Sol calls 1, deterministic **PASS**, all 17 hard
gates pass, baseline 77 → enriched 97 (+20), Sol preferred **ENRICHED** (quality 83→93),
`mechanicalWordingDetected=false`, `unsupportedClaimSuspected=false`, `criticalIssues=[]`,
`advisoryVerdict=PASS`, `combinedStatus=READY_FOR_OPERATOR_REVIEW`. Validated external sentence:
*"All three comparable nearby clinics make booking available directly from their homepage."* **This is
fictional validation, not production approval.**

### 1.3 Outreach + delivery infrastructure (implemented; sends nothing by default)

- **Tracking (17A):** 17-state machine, immutable message snapshots + content hash, duplicate-active guard,
  reply/bounce/unsubscribe interrupts, follow-ups computed but never auto-sent.
- **Read-only Gmail reply sync (17A2):** separate `gmail.readonly` credential, GET-only, exact-scope guard,
  no mutation method by construction.
- **Google Sheets projection (17A3):** one-way, idempotent, stable column-A row ids, never reads back into
  Postgres, never dumps bodies (Messages tab references content hash).
- **Controlled first send (17B):** a dedicated, heavily-gated single-send path (draft → verify → dispatch),
  allowlisted recipient, exact sender match, valid unexpired human approval, no Cc/Bcc, no bulk path.
- **Delivery reconciliation (17C / 17C1):** read-only DSN detection, deterministic correlation
  (Message-ID → Gmail message id → thread → time-bounded recipient), permanent bounce → `BOUNCED` + follow-up
  cancellation, temporary → `DELIVERY_UNKNOWN`, never auto-retries, supersede-not-delete correction.

### 1.4 Verified CLI command names (confirmed in `src/cli/index.ts`)

Preparation/enrichment: `competitor-research-{plan,run,review}`,
`competitor-capture-{plan,run,review,invalidate}`,
`competitor-pattern-{plan,run,review,approve,reject,invalidate}`, `outreach-compose-preview`,
`generate-emails`. Tracking/send/recovery: `outreach-init`, `outreach-track`, `outreach-record-message`,
`outreach-transition`, `outreach-{schedule,cancel,postpone}-followup`, `outreach-followups-due`,
`outreach-sync-replies`, `outreach-sync-sheet`, `outreach-sheet-verify`, `outreach-timeline`,
`outreach-readiness`, `outreach-reconcile-delivery`, `outreach-correct-delivery-events`,
`outreach-smoke-{init,approve,send,reconcile}`, `gmail-auth`, `gmail-read-auth`, `sheets-auth`.
Lead prep: `list-leads`, `lead-state`, `collect-leads`, `qualify-leads`, `enrich-lead(s)`,
`capture-websites`, `audit-websites`, `review-dashboard`.

### 1.5 Safety defaults (confirmed in `src/config/env.ts`)

All default-off: `DRY_RUN=true`, `OUTBOUND_ACTIONS_ENABLED=false`, `SENDING_ENABLED=false`,
`OUTREACH_TRACKING_ENABLED=false`, `GMAIL_REPLY_SYNC_ENABLED=false`, `GOOGLE_SHEETS_SYNC_ENABLED=false`,
`OUTREACH_SMOKE_TEST_ENABLED=false`, and every `COMPETITOR_*_ENABLED=false`. The outbound kill switch is
intact: no send is possible without `OUTBOUND_ACTIONS_ENABLED=true` **and** an approved lead state.

### 1.6 Deliverability incident (confirmed in `docs/OPERATIONS.md`)

Phase 17B sent one tracked message from `admin@scaleflow.it.com` to `kheadi10@gmail.com`; it recorded
`INITIAL_SENT` but Gmail emitted a separate `550 5.7.1` DSN (likely unsolicited) in a different thread and the
recipient never received it. SPF/DKIM/DMARC/Postmaster were reportedly configured. **No document records a
subsequent successful manual delivery.** The reconciliation and correction commands exist and were exercised
against the incident record, but they only fix *state accounting* — they are not evidence of deliverability.

### 1.7 Documentation drift found

1. **Progress understated in the contracts.** `CLAUDE.md` and the "current approved phase" note say "Phases
   0–16 complete," but `docs/CURRENT_STATUS.md` documents 17A, 17A2, 17A3, 17B, 17C, 17C1, and 7A4B/B1/B2 as
   implemented. The status doc is the authoritative handoff; the CLAUDE.md header lags. **No functional impact**
   — every 17x path is default-off — but the header should eventually be reconciled.
2. **No CLI for a plain manual deliverability probe.** Recovery/reconciliation commands exist, but there is no
   command that sends a simple human-written email; the mandated manual probe (§9 step 2) is a Gmail-UI human
   action, by design. Flag this so no one looks for a nonexistent command.
3. **Routing wording.** Docs describe the *live-validation* path (Terra writer / Sol critic) via dedicated
   `COMPETITOR_EMAIL_LIVE_VALIDATION_*` flags, but the **production** email composer
   (`generate-emails` / `outreach-compose-preview`) routes via `EMAIL_WRITER_MODEL` (default `gpt-5.6-sol`) and
   `EMAIL_REVIEWER_MODEL` (default `gpt-5.6-terra`) — the *inverse*. See §8; this is a real decision, not drift
   in the code, but it is easy to misread.

---

## 2. Go/No-Go readiness matrix

Legend: **READY** · **READY_WITH_CONDITIONS** · **BLOCKED** · **NOT_VERIFIED**.

### 2.1 Technical safety — **READY**

| Control | Status | Evidence |
|---|---|---|
| Immutable evidence + package/message history | READY | versioned/superseded, never deleted (0029–0032, 0026–0028) |
| Deterministic competitor counts | READY | `comp-cmp-1` scoring, one branch per brand, cap 3 |
| Freshness checks | READY | 30-day, re-derived at generation **and** re-checked at approval/compose |
| Package approval (human, explicit `--operator`) | READY | `competitor-pattern-approve`, no auto-approval |
| Email traceability (claim ledger, spans, hashes) | READY | `email-copy-schema-3`, `deriveClaimSpans`, canonical composed hash |
| Bounce reconciliation | READY | 17C/17C1, correlation fail-closed on ambiguity + time window |
| Follow-up cancellation on bounce/reply/unsubscribe | READY | enforced in state machine |
| Default-off sending | READY | all sending flags default-off (§1.5) |
| Explicit operator approval before send | READY | valid unexpired approval + `APPROVED_TO_SEND` required |

### 2.2 Evidence quality — **READY**

| Control | Status | Evidence |
|---|---|---|
| Comparability threshold (70) | READY | `comp-cmp-1` gates |
| Minimum two competitors for a pattern | READY | denominator ≥2 **and** presentCount ≥2 |
| Evidence freshness | READY | 30-day, live re-check at approval |
| Explicit UNKNOWN vs ABSENT | READY | UNKNOWN never negative; ABSENT needs scoped negative (not emitted by 7A2 today) |
| Source traceability | READY | every pattern refs stored evidence ids + source URL |
| Prohibited performance/revenue/ranking claims | READY | hard validator FAILS closed |
| Anonymized competitor wording | READY | count-bound phrasing; names never externalized |

### 2.3 Email quality — **READY (fictional)**

| Control | Status | Evidence |
|---|---|---|
| Prospect evidence appears first | READY | structured `PROSPECT_OBSERVATION` section always first |
| Competitor section materially aligns with the issue | READY | explicit audit-category↔evidence-category map; fail-closed |
| ≤ one competitor sentence | READY | `decideCompetitorRender` (structured, not semantic) |
| No competitor identity leakage | READY | leakage validator + sanitizer, fail-closed |
| No repetitive consequence | READY | 17th hard gate `structured_copy_redundancy` |
| One recommendation / one CTA | READY | composition plan enforces |
| Live Terra/Sol validation outcome | READY_WITH_CONDITIONS | strong **fictional** result; not yet exercised on real prospect data |

### 2.4 Deliverability — **BLOCKED**

| Control | Status | Evidence |
|---|---|---|
| Successful manual mailbox→Gmail delivery | **BLOCKED / NOT_VERIFIED** | last attempt = `550 5.7.1`; no later success recorded |
| Sender authentication (SPF/DKIM/DMARC) | NOT_VERIFIED | reportedly configured; not re-confirmed post-incident |
| Gmail bounce status | BLOCKED | permanent `550 5.7.1` on record |
| Postmaster state | NOT_VERIFIED | not re-checked in repo context |
| Bounce monitoring | READY | 17C/17C1 read-only DSN reconciliation exists |
| Established sender history / reputation | BLOCKED | brand-new domain, prior rejection = poor reputation signal |
| Should sending remain blocked? | **YES** | until a fresh manual delivery is proven |

### 2.5 Operational readiness — **READY_WITH_CONDITIONS**

| Control | Status | Evidence |
|---|---|---|
| Operator review process | READY | `review-dashboard`, `outreach-compose-preview`, timeline |
| Exact commands documented | READY_WITH_CONDITIONS | verified (§1.4); reconcile the CLAUDE.md header lag |
| Migration status | READY | contiguous through 0032; none needed for prep |
| Feature flags | READY | all default-off, documented |
| Google Sheet visibility | READY | one-way projection (17A3) |
| Rollback + stop procedures | READY | §15; flags + supersede-not-delete |
| Who approves each email | READY_WITH_CONDITIONS | single named operator; must be recorded per email |

---

## 3. Final readiness status

> ## `TECHNICALLY_READY_BUT_DELIVERABILITY_BLOCKED`

Rule applied: `READY_TO_SEND_CONTROLLED_PILOT` requires verified evidence that a **recent, simple, manual**
email from `admin@scaleflow.it.com` reached a personal Gmail inbox. No such evidence exists in the repository or
operator record. Therefore the maximum allowed status is `TECHNICALLY_READY_BUT_DELIVERABILITY_BLOCKED`. The
system may **prepare and internally approve** pilot emails while blocked; it may **not send**.

---

## 4. Active blockers

1. **B-DELIVER (hard, sending-blocking).** No proven manual delivery from `admin@scaleflow.it.com` to a
   personal Gmail inbox since the `550 5.7.1` rejection. Blocks all real sending. Does **not** block preparation.
2. **B-REPUTATION (contributing).** New sending domain with a prior unsolicited-mail rejection = weak/negative
   reputation; even with authentication fixed, first sends risk Spam placement. Mitigate with volume=1 and
   manual observation.
3. **B-ROUTING (decision, non-blocking).** Production composer defaults route Sol=writer / Terra=reviewer,
   the inverse of the validated Terra=writer / Sol=reviewer behaviour. Must be an explicit operator decision
   (§8) before composing real pilot emails, so the copy that ships matches what was validated.
4. **B-REALDATA (scope).** All validation to date is fictional. Real prospects introduce real evidence and real
   competitor sites; the pilot is partly a first real-data exercise of the same deterministic gates.

---

## 5. Recommended pilot size

**Start with three prospects** (hard maximum five). One niche, one market, one prospect at a time, manual review
at every stage, no automatic follow-ups, no automatic retries, stop immediately on a bounce or serious complaint,
only legitimate published business contact details.

Rationale: three is the smallest set that still produces meaningful operational feedback (composition quality,
approval workflow, delivery, bounce handling, Sheet projection, operator workload) while capping blast radius and
reputational exposure on a domain that has already been rejected once. Expand to five only after the first three
deliver cleanly with no bounce, no Spam placement, and no operator-corrected copy. **Do not select real
prospects during planning.**

---

## 6. Prospect eligibility (hard rules)

A pilot prospect is eligible **only if all** hold:

1. Legitimate, currently operating business.
2. Active public website (reachable, not parked/expired).
3. Clear, single business category.
4. Matches the chosen target market (geo + language).
5. Verified business email **or** a legitimate published contact route (from the business's own site/listing).
6. A specific, evidence-backed prospect-site issue (booking/contact/CTA friction of the kind the pipeline
   verifies).
7. Sufficient stored source evidence to support every factual claim in the email.
8. No legal/contact restriction preventing outreach (e.g. explicit no-solicitation notice).
9. No duplicate prior outreach (duplicate-active guard clean).
10. No prior bounce, unsubscribe, or do-not-contact state.
11. No unsupported personal-data enrichment (no scraped personal names/roles beyond published business contact).

### Rejection reasons (record the exact reason on rejection)

`NOT_OPERATING`, `NO_ACTIVE_SITE`, `AMBIGUOUS_CATEGORY`, `MARKET_MISMATCH`, `NO_LEGITIMATE_CONTACT`,
`NO_VERIFIED_ISSUE`, `INSUFFICIENT_EVIDENCE`, `CONTACT_RESTRICTION`, `DUPLICATE_OUTREACH`, `SUPPRESSED_STATE`
(bounce/unsubscribe/DNC), `UNSUPPORTED_PERSONAL_DATA`.

---

## 7. Competitor-enrichment eligibility

Enrichment is **optional** and used **only when all** hold:

1. At least two distinct comparable competitors exist.
2. The pattern package is `APPROVED`.
3. The package belongs to the **same lead**.
4. All supporting evidence is fresh (30-day) and active (non-superseded/invalidated).
5. The competitor pattern directly aligns with the prospect's **primary** verified issue (audit↔evidence map).
6. Anonymized wording passes every validator (no leakage, no prohibited claims, count-safe).
7. The competitor sentence **materially improves** the email (not filler).

Otherwise: send a **prospect-only** email. An explicit invalid competitor-package request must **fail closed**
(never silently degrade to prospect-only under an explicit `--competitor-package`). **Do not force competitor
language into every pilot email.**

---

## 8. Model-routing decision

**Verified facts.** Production composer routes by env: `EMAIL_WRITER_MODEL` default `gpt-5.6-sol` (Sol writes),
`EMAIL_REVIEWER_MODEL` default `gpt-5.6-terra` (Terra reviews). The fictional validation exercised the *inverse*
(Terra writes the base email, Sol gives the advisory critique) through the dedicated
`COMPETITOR_EMAIL_LIVE_VALIDATION_*` flags — a **separate path** from the production composer.

| Option | Description | Cost | Quality/consistency | Blast radius | Rollback | Verdict |
|---|---|---|---|---|---|---|
| **A** | Keep current production routing (Sol writer / Terra reviewer) unchanged for the pilot | baseline | pilot copy would **not** match validated Terra-writer behaviour | global default; every future run | n/a | Not recommended — ships un-validated routing |
| **B** | Pilot-only override: **Terra writer + Sol reviewer**, via per-run env override, production defaults untouched | matches validated run | matches the validated fictional result | pilot runs only; production defaults intact | unset the override | **Recommended** |
| **C** | Change production defaults globally to Terra writer / Sol reviewer | matches validated | consistent everywhere | **global**; affects demos/other flows too | revert env/commit | Premature — decide after the pilot |

**Recommendation: Option B.** A pilot-scoped override is strictly safer than a global default change: it makes
the real pilot emails match the exact routing that produced the validated result, while leaving every other flow
(and the committed production defaults) untouched, so rollback is a single env change. Defer Option C until the
pilot has demonstrably worked. **Do not implement the routing change in this planning milestone;** record it as
operator decision **D-1** (§18).

---

## 9. Deliverability recovery sequence (mandatory before any real send)

No real prospect send may bypass this sequence.

1. Keep **all** automation sending disabled (`SENDING_ENABLED=false`, `OUTBOUND_ACTIONS_ENABLED=false`,
   `DRY_RUN=true`, `OUTREACH_SMOKE_TEST_ENABLED=false`).
2. **Manual probe (human, Gmail UI — no CLI exists for this).** From `admin@scaleflow.it.com`, send one simple,
   plain, human-written message to a personal Gmail inbox. No tracking, no template, no links-heavy body.
3. Confirm it reaches **Inbox or Spam without a `550` rejection**.
4. Wait for / inspect any DSN (there should be none on success).
5. Verify authentication headers where visible (SPF=pass, DKIM=pass, DMARC=pass in the received message's
   "Show original").
6. **Only then** run one new tracked internal smoke send (`outreach-smoke-*`, §10 Stage 2) to a controlled
   internal recipient.
7. Verify recipient delivery.
8. Verify outreach status (`outreach-timeline`).
9. Verify Gmail reply/bounce synchronization (`outreach-sync-replies`, `outreach-reconcile-delivery --mock`
   then live read-only).
10. Verify Google Sheet projection (`outreach-sync-sheet --preview` then `--confirm-sheet-write`).
11. **Only then** unlock the first real prospect (Stage 3).

### Branch conditions

| Condition | Action |
|---|---|
| Manual email still bounces (`550`) | **STOP.** Remain `DELIVERABILITY_BLOCKED`. Investigate domain reputation / Postmaster / warmup; do not proceed. |
| Tracked smoke bounces | STOP. Reconcile to `BOUNCED` (17C), cancel follow-ups, re-diagnose before any prospect. |
| Message reaches **Spam** | Treat as not-yet-ready. Improve reputation/warmup; a Spam landing is not a pass for prospect sends. |
| Delivers but reply/bounce sync fails | STOP prospect rollout; fix sync before trusting delivery accounting. |
| Status remains `DELIVERY_UNKNOWN` | Do **not** assume delivered; do not send the next prospect; reconcile first. |
| Provider error | Fail closed; no retry; diagnose; do not advance stage. |

---

## 10. Staged sending rollout (one at a time)

| Stage | Action | Sending? |
|---|---|---|
| **0** | Prepare prospects + compose + internally approve emails | No |
| **1** | Manual mailbox delivery test (§9 steps 2–5) | Manual human email only |
| **2** | One internal tracked smoke send (`outreach-smoke-*`) to a controlled recipient | One tracked send |
| **3** | First **real** prospect email | One send |
| **4** | Review delivery, logs, and Sheet **before** prospect two | No send |
| **5** | Continue one at a time up to the approved maximum (3, then optionally 5) | One send each, stop-review between |

A **stop review is required after every send**. No follow-ups and no retries during the initial pilot.

---

## 11. Per-prospect operator workflow (exact commands where they exist)

For **one** prospect, in order (flags set per-command; nothing enabled globally):

1. **Qualify lead** — `qualify-leads` / `lead-state <id>`.
2. **Inspect prospect evidence** — `review-dashboard` / prospect audit output; confirm the specific site issue.
3. **Competitor candidate research** (optional) — `competitor-research-plan` then
   `competitor-research-run --apply` (`COMPETITOR_RESEARCH_ENABLED=true`, fixture/operator_csv provider only).
4. **Review selected competitors** — `competitor-research-review`.
5. **Bounded capture** — `competitor-capture-plan` then `competitor-capture-run`
   (`COMPETITOR_CAPTURE_ENABLED=true`; ≤2 pages/competitor). *Live capture is the point where real competitor
   sites are read — operator-executed only.*
6. **Review evidence** — `competitor-capture-review`.
7. **Generate pattern package** — `competitor-pattern-plan` then `competitor-pattern-run`
   (`COMPETITOR_PATTERN_ENABLED=true`).
8. **Approve or reject package** — `competitor-pattern-approve --operator <name>` / `competitor-pattern-reject`.
9. **Compose prospect-only preview** — `outreach-compose-preview --lead <id>`.
10. **Compose enriched preview when eligible** —
    `outreach-compose-preview --lead <id> --competitor-package <id>`
    (`COMPETITOR_EMAIL_ENRICHMENT_ENABLED=true`). Under the **Option B** routing override.
11. **Compare and choose** prospect-only vs enriched (§12 checklist).
12. **Run deterministic validators** — inherent to compose/preview (schema, leakage, prohibited claims,
    redundancy gate, claim ledger, hashes).
13. **Human review** of the exact subject + body (§12).
14. **Record approval identity** — capture into tracking: `outreach-init` → `outreach-track` →
    `outreach-record-message` → `outreach-transition` to `AWAITING_APPROVAL`/`APPROVED_TO_SEND`
    (`OUTREACH_TRACKING_ENABLED=true`).
15. **Wait for sending authorization** — Stages 1–2 (§10) must have passed; explicit operator go.
16. **Send one message** — the pilot send path. **GAP:** the only implemented real-send path is the Phase 17B
    `outreach-smoke-*` allowlisted single-send, whose recipient is pinned to `OUTREACH_SMOKE_TEST_RECIPIENT`.
    A **real-prospect** send to an arbitrary eligible recipient is **not yet a first-class command** — see §17.
17. **Verify delivery state** — `outreach-timeline --record <id>`;
    `outreach-reconcile-delivery --record <id> --confirm-gmail-read` (read-only).
18. **Sync Sheet** — `outreach-sync-sheet --confirm-sheet-write`.
19. **Monitor reply/bounce** — `outreach-sync-replies --confirm-gmail-read`; reconcile DSNs read-only.
20. **Decide whether to continue** — stop review before the next prospect.

Steps 1–14 (preparation + internal approval) use **only** existing commands and are authorized to *prepare*.
Steps 15–19 (send + verify) are **blocked** until §9 passes and depend on resolving the §17 send-path gap.

---

## 12. Human email review checklist (per email, before approval)

- [ ] Correct business and correct recipient address.
- [ ] Prospect issue is factual and evidence-backed (link/reference resolves).
- [ ] Prospect evidence reference works.
- [ ] Competitor count is correct (matches the approved package denominator).
- [ ] Competitor sentence is relevant to the prospect's primary issue.
- [ ] No competitor names or domains appear externally.
- [ ] No unsupported result/performance/revenue/ranking claim.
- [ ] No accusatory or shaming language.
- [ ] Subject contains no competitor context.
- [ ] Message is concise (within length/tone gates).
- [ ] Recommendation is concrete and singular.
- [ ] CTA is singular and low-friction.
- [ ] Sender identity/signature is correct (`ScaleFlow` / `admin@scaleflow.it.com`).
- [ ] No placeholder or template token remains.
- [ ] No duplicate outreach record for this lead×contact.
- [ ] Sending flags remain disabled until final authorization.

---

## 13. Pilot metrics (operational only)

Track per prospect and in aggregate: prepared · approved · sent · delivered · bounced · delivery-unknown ·
replied · positive reply · negative reply · unsubscribe/do-not-contact · Gmail Spam placement (when manually
observable) · time spent per prospect · enrichment used vs not · operator corrections required · evidence or
validation failures.

**Do not draw response-rate conclusions from three to five emails.** Valid targets for this pilot are
operational: evidence-pipeline execution, composition quality, approval workflow, Gmail delivery, bounce
handling, reply synchronization, Sheet projection, operator workload, and message traceability.

---

## 14. Stop conditions (halt the pilot immediately)

Permanent bounce · multiple temporary failures · Gmail unsolicited-mail (`550`) rejection · authentication
failure · message sent to the wrong recipient · unsupported claim discovered after approval · stale evidence
discovered · competitor identity leakage · broken reply/bounce synchronization · a follow-up unexpectedly
scheduled or sent · sending beyond the approved count · provider exceeding the approved call budget · any
complaint or unsubscribe · any safety-flag bypass.

**Required remediation before resuming:** disable all sending; reconcile the affected record to its true state
(`BOUNCED`/`DELIVERY_UNKNOWN`/`DO_NOT_CONTACT`); cancel pending follow-ups; root-cause the trigger; if a claim or
evidence defect, invalidate the email approval and (if implicated) the competitor package; re-run deterministic
validators; obtain a fresh explicit operator go before the next send.

---

## 15. Rollback and containment

- **Disable all sending:** set `SENDING_ENABLED=false`, `OUTBOUND_ACTIONS_ENABLED=false`, `DRY_RUN=true`,
  `OUTREACH_SMOKE_TEST_ENABLED=false` (default state; the kill switch alone stops sending).
- **Cancel pending follow-ups:** `outreach-cancel-followup` (bounce/reply/unsubscribe already auto-cancel).
- **Invalidate an email approval:** transition the record out of `APPROVED_TO_SEND`; a changed body/package
  yields a new email id (history never mutated).
- **Invalidate a competitor package:** `competitor-pattern-invalidate` (supersede, never delete).
- **Preserve immutable sent history:** sent-message rows are never mutated; `BOUNCED` is a record-state change,
  not a message edit.
- **Mark bounce/unsubscribe/do-not-contact:** via reconciliation + state machine; `add-suppression` for DNC.
- **Correct Sheet projection:** re-run `outreach-sync-sheet` (idempotent, overwrites stale rows).
- **Prevent accidental rerun:** duplicate-active guard; `outreach-smoke-*` refuses a second send; reconcile
  refuses if a send is already recorded.
- **Revert pilot-specific model routing:** unset the Option B per-run override (no code/commit to revert).
- **Retain audit evidence:** supersede-not-delete throughout; delivery-event corrections append immutable events.

---

## 16. Phase 7A4C boundaries

**May approve (with explicit operator execution):** preparing real prospects; real public-website research
after explicit operator run; internal email previews; manual email approval; a future controlled send **only**
after deliverability passes (§9).

**Must not automatically:** select real prospects; research them; approve packages; approve emails; enable
sending; create Gmail drafts; send email; schedule follow-ups; change production routing; or make a global
go-live decision. Every such step is a separately authorized, operator-run action.

---

## 17. Implementation recommendation / gaps

**Preference: no code for the preparation milestone.** Steps 1–14 of §11 are fully served by existing commands.
Phase 7A4C's core deliverable is this operator playbook plus the deliverability recovery gate.

**One genuine gap for the *send* milestone (not preparation):** the only implemented real-send path is the
Phase 17B `outreach-smoke-*` flow, whose recipient is **allowlisted to `OUTREACH_SMOKE_TEST_RECIPIENT`** and
whose data model uses a single synthetic internal test lead. Sending to a **real, arbitrary, eligible prospect**
is therefore not yet a first-class, guarded command. Options, in order of preference:

- **G-1 (recommended):** defer. Do all preparation + internal approval now; only after §9 passes, scope a small,
  separate, heavily-gated *controlled real-prospect single-send* milestone (mirroring 17B's guard set but binding
  the recipient to the approved tracked record's contact instead of a fixed allowlist constant). One prospect at
  a time, no bulk path, explicit per-send confirmation.
- **G-2:** temporarily point the existing smoke path at one real recipient — **not recommended** (overloads a
  test-only path, weakens the allowlist guarantee).

Also nice-to-have (optional, non-blocking): a `pilot-readiness` reporting command that aggregates flag state,
deliverability-gate status, and per-prospect eligibility into one operator view. Prefer documentation first.

If code is approved, it should be a **separate milestone after operator approval**, one clean commit + one tag,
per the CLAUDE.md phase protocol.

---

## 18. Exact operator decisions required

| ID | Decision | Recommended | **Recorded (2026-08-04)** |
|---|---|---|---|
| **D-1** | Model routing for the pilot: A (keep production) / **B (pilot-only Terra-writer/Sol-reviewer override)** / C (global change) | **B** | ✅ **B** — Terra writer, Sol reviewer, this pilot only |
| **D-2** | First pilot size: **3** or 5 prospects | **3**, expand to 5 only after clean delivery | ✅ **3 prospects** |
| **D-3** | Niche + market for the pilot (one each) | operator picks; not selected in planning | ✅ **Independent dental clinics in London with English-language websites** |
| **D-4** | Who is the single named approver recorded on each email | operator names | ✅ **Adi** |
| **D-5** | Send-path gap: **G-1 (separate gated real-send milestone)** or G-2 (reuse smoke path) | **G-1** | ✅ **G-1** — defer real-prospect send path until deliverability is proven |
| **D-6** | Whether to run the manual deliverability probe now (§9 step 2) and, on success, proceed to Stage 2 | operator authorizes | ✅ **Authorized** — one manual mailbox→Gmail probe, outside Automation Suite |
| **D-7** | Reconcile the CLAUDE.md "Phases 0–16" header lag (doc-only) | optional cleanup | ✅ **Do NOT modify CLAUDE.md** during this milestone |

---

## 19. Final report

1. **Current go/no-go status:** `TECHNICALLY_READY_BUT_DELIVERABILITY_BLOCKED`.
2. **May preparation begin?** **Yes** — prepare, research (operator-executed), compose, and internally approve
   up to the approved pilot size using existing commands, all flags set per-command, nothing sent.
3. **May sending begin?** **No** — blocked until the §9 manual deliverability probe proves a fresh
   `admin@scaleflow.it.com` → personal-Gmail delivery without a `550`, followed by a clean Stage-2 tracked smoke
   send.
4. **Recommended pilot size:** **3 prospects** (hard max 5), one niche, one market, one at a time.
5. **Recommended production model-routing option:** **Option B** — a pilot-only override matching the validated
   Terra-writer / Sol-reviewer behaviour; production defaults unchanged.
6. **Exact active blockers:** B-DELIVER (hard, sending), B-REPUTATION (contributing), B-ROUTING (decision D-1),
   B-REALDATA (scope). Only B-DELIVER blocks *sending*; none blocks *preparation*.
7. **Are code changes needed?** **Not for preparation.** A small, separate, heavily-gated real-prospect
   single-send milestone (G-1) is needed **before real sending**, and only after §9 passes. An optional
   `pilot-readiness` reporting command is nice-to-have.
8. **Decisions requiring operator approval:** D-1 … D-7 (§18).
9. **Confirmation that only the planning document changed:** This task created **only**
   `docs/phase-7a4c-controlled-pilot.md`. No code, migration, fixture, config, or `AGENTS.md` was created or
   modified; nothing was committed or pushed; no real prospect, live competitor website, Terra/Sol or any live
   model, Gmail, Google Sheets, or production database was accessed; no Gmail draft, email, or send occurred.
   Planning only.

---

## 20. Recommended next milestone

**7A4C-PREP (documentation/operator-execution only, no code):** with operator approval of D-1…D-6, run the
per-prospect preparation workflow (§11 steps 1–14) for **three** real prospects in one niche/market under the
Option B routing override, producing three internally approved emails and their tracking records — **while
sending stays disabled**. In parallel, the operator runs the §9 manual deliverability probe.

**Only if** the probe succeeds and a Stage-2 tracked smoke send delivers cleanly, scope **7A4C-SEND** as a
separate, small, guarded milestone (G-1) to send the first real prospect email, one at a time, with a stop
review after each — per the CLAUDE.md phase protocol (one clean commit, one annotated tag, stop for approval).

---

## 21. 7A4C-PREP execution record (2026-08-04)

**Milestone:** APPROVE PHASE 7A4C-PREP — prepare up to three real prospects, no sending. Decisions D-1…D-7
recorded (§18). Preparation stage executed **read-only only**; it **halted at §2 for lack of eligible leads**.

### 21.1 Verified state (read-only)

- HEAD `a67628a`; migrations `0000–0032` defined (`./migrations/`); production DB = Supabase pooler
  (`aws-0-ap-northeast-1.pooler.supabase.com/postgres`) — the intended Automation Suite database.
- **Sending lock CONFIRMED before and after all operations:** `SENDING_ENABLED=false`,
  `OUTBOUND_ACTIONS_ENABLED=false`, `DRY_RUN=true`, `GMAIL_DRAFT_ACTIONS_ENABLED=false`,
  `GMAIL_DRAFTS_ENABLED=false`, `OUTREACH_SMOKE_TEST_ENABLED=false`, `SCHEDULING_ENABLED=false`,
  `EMAIL_GENERATION_ENABLED=false`.
- **Paid/live gates are OFF:** `ALLOW_PAID_LLM_CALLS=false`, `ALLOW_PAID_READS=false`; every
  `COMPETITOR_*_ENABLED` flag absent from `.env` (defaults false). So no live Terra/Sol, no live capture, and no
  paid Google Places read can occur without explicitly flipping these — which this milestone did **not** do.

### 21.2 Lead inventory (production DB — 7 leads)

| Lead | State | Identity | Eligible? | Reason |
|---|---|---|---|---|
| [REDACTED_LEAD_ID] | NEW | Phase 17B Smoke Test Lead (synthetic) | ❌ | synthetic/internal; prior send + `550` bounce |
| [REDACTED_LEAD_ID] | FINALIZED_EMAIL_PENDING | enriched/VERIFIED, audited (score 10) | ❌ | **prior outreach — `gmail: DRAFT_CREATED` + EMAIL_APPROVED already exist** |
| [REDACTED_LEAD_ID] | READY_FOR_ENRICHMENT | unresolved (enrichment `AMBIGUOUS`) | ❌ | not enriched; no verified name/domain/city/contact |
| [REDACTED_LEAD_ID] | READY_FOR_ENRICHMENT | unresolved | ❌ | not enriched; identity unknown |
| [REDACTED_LEAD_ID] | READY_FOR_ENRICHMENT | unresolved (enrichment `TRANSIENT_ERROR`) | ❌ | not enriched; identity unknown |
| [REDACTED_LEAD_ID] | READY_FOR_ENRICHMENT | unresolved (enrichment `TRANSIENT_ERROR`) | ❌ | not enriched; identity unknown |
| [REDACTED_LEAD_ID] | READY_FOR_ENRICHMENT | unresolved (enrichment `TRANSIENT_ERROR` ×3) | ❌ | not enriched; identity unknown |

### 21.3 Outcome — **SHORTAGE: 0 of 3 eligible existing leads**

Per §2 ("if fewer than three suitable existing leads exist, stop and report the shortage **before** collecting
new leads"), preparation **stopped**. Nothing was enriched, captured, composed, generated, or written.

- 5 real leads are **un-enriched stubs** — no verified business name, website, English-language confirmation,
  independent-clinic confirmation, London confirmation, or legitimate contact route. Enrichment previously
  errored (`TRANSIENT_ERROR`) or was `AMBIGUOUS` on 4 of them. Qualifying them would require paid Google Places
  enrichment (`ALLOW_PAID_READS=true`) **plus** production writes — i.e. *collecting/enriching new* data, which
  §2 directs to defer until after reporting.
- The only fully-processed real lead ([REDACTED_LEAD_ID]) is **ineligible** — it already carries an EMAIL_APPROVED record
  and a **created Gmail draft** from a prior phase (prior-outreach / duplicate conflict). It was not touched.

### 21.4 Operator decisions needed to proceed (each authorizes a paid/live escalation)

1. **Enrich existing stubs?** Authorize `ALLOW_PAID_READS=true` + `enrich-lead` (paid Google Places reads +
   production enrichment writes) on the 5 stubs to discover whether any are London independent dental clinics
   with English sites — accepting that enrichment previously errored and may still fail/return unsuitable.
2. **Or collect fresh London-dental leads?** Authorize `collect-leads` for the niche/market (paid Places).
3. **Then** authorize the live pipeline for accepted prospects: `ALLOW_PAID_LLM_CALLS=true` (Terra/Sol under
   the Option B override), `COMPETITOR_*_ENABLED` as needed, and live prospect/competitor website capture.

No paid read, live model call, website access, enrichment, or production write was performed. The two human
gates (package approve/reject; Adi's per-email approval) were never reached.

---

*7A4C-PREP halted at the §2 eligibility gate. No prospect was prepared. No Gmail draft, email, send, follow-up,
or production write occurred. Awaiting operator direction on enrichment/collection before any paid or live step.*

---

## 22. Fresh targeted collection — decision + blockers (2026-08-04)

**Decision D-8 (recorded).** Operator approved **fresh, targeted collection (shortlist only)** and **declined to
enrich the five unresolved stubs** (identity/location/category/website unverified; prior enrichment returned
`TRANSIENT_ERROR`/`AMBIGUOUS`; not confirmed to match the London dental pilot; retrying them is lower-value than
precisely targeted collection). Scope: ≤10 raw candidates, stop at 3 preliminary-eligible, London independent
dental clinics with English sites, no chains/directories/duplicates. Paid-read guard may be enabled **for this
session only**; `.env` not modified permanently. Sending/LLM/enrichment/competitor/Gmail/Sheets/follow-ups stay
off. Read-only preliminary screening only; stop at the shortlist for Adi's approval.

**Execution BLOCKED — two gaps require an operator decision before any paid collection can run:**

- **Blocker C — no London campaign configured.** `collect-leads --campaign <name>` resolves campaigns from
  `src/config/campaigns.ts`. The only `google_places` campaign there is `dental-manchester-google`
  (query `"dentist in Manchester UK"`) — **wrong market**. There is no London campaign. Collecting London dental
  through the existing integration requires adding a campaign entry (e.g. `dental-london-google`, reusing the
  existing `dentalNiche` with `excludeChains: true`, query `"dentist in London UK"`) — a **code edit to a
  checked-in source file**, which this milestone forbids ("Only the planning document may be edited"; CLAUDE.md
  "no code before discussion"). Using the Manchester campaign would violate the approved London market.

- **Blocker D — `DRY_RUN=true` makes google_places collection inert.** `collect-leads.ts` computes
  `dryRun = DRY_RUN || --dry-run`; for the `google_places` provider it **skips the paid call and returns** when
  dry-run is on ("Set DRY_RUN=false to collect for real"). The command does **not** consult `ALLOW_PAID_READS`.
  So the "paid-read guard required by the existing collection command" is `DRY_RUN=false` — which directly
  conflicts with the milestone's "Keep `DRY_RUN=true`." Real collection needs a **session-only** `DRY_RUN=false`.
  This is safe for *sending* (send still requires `SENDING_ENABLED=true` + `OUTBOUND_ACTIONS_ENABLED=true`, both
  kept false), but it contradicts the literal instruction, so it must be confirmed.

**Nothing was collected, enriched, written, or paid for. The prior-drafted lead ([REDACTED_LEAD_ID]) and the synthetic
smoke lead ([REDACTED_LEAD_ID]) were not touched.** Awaiting operator resolution of Blockers C and D.

### 22.2 Outcome — collection succeeded, but read-only screening is architecturally impossible

- **D-11 (recorded).** Operator authorized a second bounded request with process-only `PLACES_PAGE_SIZE=9`
  (+ `DRY_RUN=false`), total raw candidates capped at 10.
- **Second bounded run:** `collect-leads --campaign dental-london-google --source google_places --limit 9`
  (`PLACES_PAGE_SIZE=9`) → created **8**, refreshed **1**, **1 paid Places request**. Pool now **9 raw London
  candidates**: `Candidate A`, `Prospect 3`, `Prospect 1`, `Prospect 2`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`,
  `[REDACTED_LEAD_ID]`.
- **Cost:** 2 paid Places requests, "Essentials" tier, `estimated_cost_usd` 0.005 each = **≈ $0.01 total**.
- **BLOCKER F (architectural, halts screening).** The Places **text search** runs with
  `field_mask = "places.id,nextPageToken"` — it fetches **only place IDs**. Verified read-only: every collected
  lead has `business_name=null`, `domain=null`, `formatted_address=null`, `city=null`, and **zero `lead_facts`**;
  `source_requests` stores only call metadata (query, field mask, cost), not business data. Business identity
  (name, London confirmation, website, English-language, independent-vs-chain, contact route, observable issue)
  is resolved **only by the enrichment / Place Details step** — which this milestone explicitly disallows ("do
  not run enrichment") and which previously returned `TRANSIENT_ERROR`/`AMBIGUOUS` on the old stubs. Therefore
  **read-only preliminary screening cannot produce a shortlist**: there is nothing screenable to read.
- **Result: 0 of up to 3 candidates screenable/shortlisted.** Collection worked; the approved
  "collect → read-only screen" model assumed collection persists screenable attributes, which in this codebase
  it does not (ID-only text search by design, for cost control).
- **Production records created:** 9 `leads` (status `NEW`, place_id only), 9 `LEAD_COLLECTED` pipeline events,
  2 `pipeline_runs` (`[REDACTED_RUN_ID]…`, `[REDACTED_RUN_ID]…`), 2 `source_requests`. **0** lead_facts, outreach records, emails,
  Gmail drafts, or suppressions. **Untouched:** prior-drafted lead `[REDACTED_LEAD_ID]` and synthetic smoke lead
  `[REDACTED_LEAD_ID]`.
- **Env after:** `DRY_RUN` back to `true` (override was per-process); `PLACES_PAGE_SIZE` back to `1`; every
  sending/LLM/enrichment/competitor/Gmail/Sheets/follow-up flag still disabled. `.env` unmodified.
- **Operator decision needed to reach a shortlist:** (1) authorize a bounded **Place Details enrichment** of
  the 9 place IDs (paid + writes facts) so they can be screened — the step previously declined for the stubs, or
  (2) screen the 9 place IDs outside the system, or (3) halt. No enrichment, audit, model, or draft step was run.

### 22.1 Resolution + execution (2026-08-04)

- **D-9 (recorded).** Operator authorized Blocker C fix: a **config-only** addition of campaign
  `dental-london-google` (provider `google_places`, query `"dentist in London UK"`, reusing `dentalNiche`,
  `excludeChains: true`) to `src/config/campaigns.ts`. No collection/enrichment/email/routing/Gmail/sending/DB
  logic changed. Typecheck clean; `tests/unit/collect-pipeline.test.ts` 5/5 pass.
- **D-10 (recorded).** Operator authorized Blocker D fix: **process-only `DRY_RUN=false`** for the single
  `collect-leads` invocation (not written to `.env`; Node `--env-file` does not override an already-set process
  var; reverts automatically after the command). All other flags stayed off (`SENDING_ENABLED=false`,
  `OUTBOUND_ACTIONS_ENABLED=false`, `GMAIL_DRAFT_ACTIONS_ENABLED=false`, `OUTREACH_SMOKE_TEST_ENABLED=false`,
  `SCHEDULING_ENABLED=false`, `EMAIL_GENERATION_ENABLED=false`, `ALLOW_PAID_LLM_CALLS=false`).
- **First bounded run:** `collect-leads --campaign dental-london-google --source google_places --limit 10` →
  created **1**, duplicates 0, rejected 0, **1 paid Places request / 1 page**. New lead
  `Candidate A` (`NEW`, place `[REDACTED_PLACE_ID]`).
- **Blocker E — result throttle.** `.env` pins `PLACES_PAGE_SIZE=1`, `PLACES_MAX_PAGES=1`,
  `MAX_GOOGLE_CONTEXT_REQUESTS_PER_RUN=1`, so each run returns exactly ONE deterministic top result; re-running
  the same query yields only duplicates (dedup by place id). Reaching the approved pool of up to 10 raw
  candidates / 3 eligible requires a **session-only** `PLACES_PAGE_SIZE` bump (e.g. 10) for one more bounded
  request — a second read-breadth override beyond the enumerated `DRY_RUN` one. **Paused for operator
  authorization.** Running total: 1 paid Places request; 1 raw candidate; 0 screened; 0 shortlisted.

---

## 23. Place Details enrichment — path analysis + scoping blocker (2026-08-04)

**D-12 (recorded).** Operator authorized a bounded **Place Details enrichment** of the **9 fresh London IDs
only** (`Candidate A`, `Prospect 3`, `Prospect 1`, `Prospect 2`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`, `[REDACTED_LEAD_ID]`,
`[REDACTED_LEAD_ID]`); the 5 old stubs must **not** be enriched or touched; one paid read per ID, no auto-retry, stop at
3 accepted. Read-only screening + a ≤2-page public website check per candidate. All LLM/email/competitor/
Gmail/Sheets/follow-up/sending flags stay off.

### 23.1 Verified enrichment mechanics (read-only code review)

- **The viable paid path** is `enrich-leads` with session flags `ENRICHMENT_CONTEXT_PROVIDER=google`
  (fetches Place Details: `displayName`, `formattedAddress`, `types`, `businessStatus`, `websiteUri`) +
  `ENRICHMENT_CANDIDATE_PROVIDER=manual` (so the real `SafeHttpPageFetcher` runs, and the Google `websiteUri`
  hint becomes a `website_hint` candidate — both candidate providers consume `context.candidateUrls`) +
  `ALLOW_PAID_READS=true`. `DRY_RUN` does **not** gate the enrichment read, so it stays `true`.
- **Google Place Details is ephemeral by design** (`persistableFields: []`): screenable identity facts persist
  **only when a website candidate VERIFIES**; the verifier fetches the Google-listed site and writes
  `official_domain`/business facts. This is why bare collection stored nothing (Blocker F) and why the old
  stubs (whose sites didn't verify) show no facts.
- **State advance:** `qualify-leads --campaign dental-london-google --lead <id>` advances a `NEW` lead
  `NEW → NORMALIZED → READY_FOR_QUALIFICATION → READY_FOR_ENRICHMENT` (deterministic, no paid call).

### 23.2 BLOCKER G — `enrich-leads` cannot be scoped to one lead, risking the forbidden stubs + auto-retry

`enrich-leads` selects leads by **global `READY_FOR_ENRICHMENT` status** (`leads.list`, ordered `createdAt
DESC`), sliced by `--limit`; it has **no `--lead` flag**. The 5 forbidden old stubs are currently at
`READY_FOR_ENRICHMENT`. Two hazards:

1. **Stub contamination.** A batch run could enrich a stub. Ordering helps (my Aug-4 leads sort before the
   Jul-22 stubs), but it is fragile for a paid, production-writing op under a hard "don't touch the stubs" rule.
2. **Auto-retry.** Outcomes `TRANSIENT_ERROR`/`NO_CANDIDATE`/`INSUFFICIENT_CONTEXT` **leave the lead at
   `READY_FOR_ENRICHMENT`**; with no per-lead targeting, the next run would re-pick and **re-enrich it (a paid
   auto-retry)** — explicitly prohibited.

**Clean fix (recommended): add a narrow `--lead <id>` filter to `enrich-leads`** — a command-only change
(filter the selected set to the given id; no provider/verification/DB-logic change), in the same spirit as the
approved `dental-london-google` campaign entry. It guarantees exactly-one authorized lead per run, zero chance
of touching a stub, and no auto-retry. **Paused for operator authorization of this change before any paid
enrichment read.** Nothing enriched; no paid read; stubs and prior-drafted/synthetic leads untouched.

### 23.3 Code change shipped (D-13) + enrichment executed

- **D-13 (recorded).** Operator authorized the command-only `--lead <id>` change with fail-closed guards +
  focused tests. Shipped: pure `selectLeadsToEnrich(all, {lead,limit,maxPerRun})` in `enrich-leads.ts` (single-
  lead mode: id must exist and be `READY_FOR_ENRICHMENT`, returns exactly that one lead, no bulk fallback, no
  limit expansion) + `--lead` CLI option. No provider/verification/DB-logic/schema change; no sending/Gmail/
  Sheets/LLM/competitor/routing change. New `tests/unit/enrich-leads-select.test.ts` (10 cases: exact lead,
  stubs never selected, ineligible fails, unknown fails, single-max, no fallback, idempotent/no-retry, batch
  unchanged). **lint + typecheck + build green; full unit suite 1201 pass (+10).** Uncommitted.
- **Enrichment path used (process-only flags):** `ENRICHMENT_CONTEXT_PROVIDER=google` +
  `ENRICHMENT_CANDIDATE_PROVIDER=manual` + `ALLOW_PAID_READS=true`; `DRY_RUN` stayed `true` (does not gate the
  read). Per lead: `qualify-leads --lead <id>` (NEW→READY_FOR_ENRICHMENT, no paid call) then
  `enrich-leads --lead <id>` (exactly one Place Details read → verify the Google-listed site → write facts on
  VERIFIED). One at a time; stopped at 3 accepted.

## 24. 7A4C-PREP shortlist — 3 eligible London independent dental clinics (2026-08-04)

**Processed 4 of 9 fresh IDs, one at a time; stopped at 3 accepted (never reached #5–#9).** 4 Place Details
reads (est $0.035 each ≈ $0.14) + the earlier 2 text-search calls (≈ $0.01) = **≈ $0.15 Google spend.**

| # | Lead ID | Business | Website (HTTP) | London area | Place ID | Verdict |
|---|---|---|---|---|---|---|
| 2 | `Prospect 3` | Prospect 3 | [REDACTED_DOMAIN] (200) | London | `[REDACTED_PLACE_ID]` | **ACCEPTED** |
| 3 | `Prospect 1` | Prospect 1 | [REDACTED_DOMAIN] (200) | London | `[REDACTED_PLACE_ID]` | **ACCEPTED** |
| 4 | `Prospect 2` | Prospect 2 | [REDACTED_DOMAIN] (200) | London | `[REDACTED_PLACE_ID]` | **ACCEPTED** |
| 1 | `Candidate A` | Candidate A | [REDACTED_DOMAIN] (403) | London | `[REDACTED_PLACE_ID]` | **NOT_VERIFIED** — verifier got HTTP 403 (bot protection / access control); not bypassed → `NEEDS_MANUAL_REVIEW` |

**Per-candidate detail** (dental/OPERATIONAL; prior outreach/gmail-draft/email/suppression all 0; no duplicate
domain — all verified):

- **#2 Prospect 3** — [REDACTED_ADDRESS]. Independent **2-site London brand** (two central-London
  sites; own branding, distinct local phone numbers) — **not a national chain**. Contact route:
  homepage phones + "Book now". Preliminary issue (to verify in audit): booking likely via form/callback, not
  real-time online booking. Uncertainty: multi-site brand — confirm the operator is comfortable targeting it,
  and which site; no email captured (phone/form only).
- **#3 Prospect 1** — [REDACTED_ADDRESS]. Independent single private practice (named in-house
  team; "your local London dentist"; no branch nav). Contact: `[REDACTED_EMAIL]` + "Book
  Appointment". Preliminary issue: verify whether "Book Appointment" is real online booking vs. a form; star
  rating shown as placeholders. Uncertainty: confirm booking mechanism.
- **#4 Prospect 2** — [REDACTED_ADDRESS]. Independent single clinic since 1999
  (award-focused; single flagship). Contact: `[REDACTED_EMAIL]` + contact form + "Book
  Consultation". Preliminary issue: booking is consultation-request / "weekend & evening by special request"
  (not directly bookable) → booking friction. Uncertainty: premium/celebrity positioning — confirm offer fit.

**Production writes:** facts (name/domain/address/city/country/category/status, + email for #3/#4, + location
page for #2) for #2–#4, advanced to `READY_FOR_QUALIFICATION`; #1 → enrichment attempt + `NEEDS_MANUAL_REVIEW`
(no facts). Qualification results + enrichment/verification-attempt rows for #1–#4. **No** outreach record,
Gmail draft, email, suppression, or Sheet write. **Untouched:** the 5 old stubs (facts all dated 2026-07-21/22,
0 today), fresh IDs #5–#9 (`NEW`), prior-drafted `[REDACTED_LEAD_ID]`, synthetic `[REDACTED_LEAD_ID]`.

**Confirmed OFF throughout:** Terra, Sol, `ALLOW_PAID_LLM_CALLS`, `EMAIL_GENERATION_ENABLED`, competitor
research/capture/pattern, Gmail drafts/sends, Sheets, follow-ups, `SENDING_ENABLED`, `OUTBOUND_ACTIONS_ENABLED`.
All env overrides were process-only; `.env` unchanged. **Stopped for Adi's approval of the shortlist before any
audit, competitor work, or email preparation. Nothing committed or pushed.**

### 24.1 Shortlist approved (D-14, 2026-08-04)

Operator (Adi) approved the three-prospect shortlist in this order:

1. **Prospect 1** — `Prospect 1` (first to process)
2. **Prospect 2** — `Prospect 2`
3. **Prospect 3** — `Prospect 3`

**Prospect 3 constraint:** approved as a **local independent two-site brand**; use the exact stored
Google Places location; do **not** assume which branch a website feature belongs to; make location-specific
claims only when evidence explicitly supports them, otherwise use **brand-level wording**.
