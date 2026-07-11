# Assumptions

Safest-reversible defaults recorded where information was missing. Each is challengeable; none fabricates a
user preference. Update or promote to a decision (`DECISIONS.md`) when confirmed.

| ID | Assumption | Basis | Reversibility | Status |
|---|---|---|---|---|
| A-0001 | Single operator / single-tenant system (no multi-user auth in MVP). | Mission describes one operator reviewing/sending. | Auth + tenancy addable at dashboard phase. | Open |
| A-0002 | First niche + geography will be provided as config, not auto-selected. | Spec: "first implementation may use a configured niche." | Niche-research module can automate later. | Open |
| A-0003 | Dentistry is used only as a fixture/example, never a permanent hardcoded niche. | Spec instruction. | N/A — fixture only. | Confirmed |
| A-0004 | Target market/language for early tests is English-language local businesses. | Example campaign `dental-manchester-test`. | Multi-language handled in eval + writer later. | Open |
| A-0005 | GitHub remote will exist and be the source of truth; Phase 0 commits locally until a remote is added. | Dev preference: GitHub as source of truth. | Add remote + push any time. | Open |
| A-0006 | Screenshots/artifacts stored on local filesystem in early phases (storage abstraction hides this). | "Local files only" before publishing phases. | Swap to object storage behind the abstraction. | Open |
| A-0007 | Estimated model cost is computed from a versioned local price table, not a live pricing API. | No paid calls until Phase 5; simplicity. | Update price table; refetch official pricing at Phase 5. | Open |
| A-0008 | One demo template per niche, data-driven, serving many `/demo/<lead-slug>` routes from one deploy. | Spec demo-system design. | Additional templates addable per niche. | Open |
| A-0009 | Node 22 LTS is the target runtime (matches installed v22.18.0). | Discovery finding. | Version pinned in `package.json` engines; upgradable. | Confirmed |
| A-0010 | Timezone/locale for daily-batch scheduling is the operator's local time. | Daily-batch operator workflow. | Configurable via env at Phase 12. | Open |
