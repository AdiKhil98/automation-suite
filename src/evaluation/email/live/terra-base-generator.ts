/**
 * Phase 7A4B — Terra base-email generation. Makes EXACTLY ONE `email_write` call (the only base-generation
 * call in a run) using the production writer prompt + schema, then runs the deterministic prospect-only
 * validators. It reuses the production writer pieces WITHOUT the second (reviewer) call and WITHOUT any DB
 * persistence. Terra receives ONLY the fictional prospect data — no competitor names, domains, evidence,
 * HTML, excerpts, counts, or package contents. Any malformed/refused/invalid result fails CLOSED.
 */

import { buildEmailWriterMessages, EMAIL_WRITER_PROMPT_VERSION, type EmailBrief } from '../../../prompts/email/index.js';
import { type LlmProvider, type ReasoningEffort } from '../../../integrations/llm/provider.js';
import { EMAIL_WRITER_JSON_SCHEMA, emailWriterSchema, type EmailWriterParsed } from '../../../domain/email/email-schema.js';
import { buildEmailContext, type EmailFinding, type EmailInputs } from '../../../domain/email/email-render.js';
import { validateEmail } from '../../../domain/email/email-validation.js';
import { type LeadFact } from '../../../domain/lead-facts/lead-fact.js';
import { LiveCallBudget, type LiveModelCall, toModelCall } from './live-types.js';

export interface TerraGenConfig {
  model: string;
  effort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type TerraFailureReason =
  | 'TERRA_PROVIDER_REFUSAL'
  | 'TERRA_RATE_LIMITED'
  | 'TERRA_TRANSIENT_ERROR'
  | 'TERRA_MALFORMED_RESPONSE'
  | 'TERRA_VALIDATION_FAILED'
  | 'TERRA_COMPETITOR_LEAK';

export type TerraBaseResult =
  | { ok: true; draft: EmailWriterParsed; brief: EmailBrief; call: LiveModelCall }
  | { ok: false; reason: TerraFailureReason; violations: string[]; call: LiveModelCall | null };

/** Build a prospect-only writer brief from fixture facts + findings. competitorPackage is always null. */
export function buildProspectOnlyBrief(facts: LeadFact[], findings: EmailFinding[]): EmailBrief {
  const currentFacts = facts.filter((f) => f.isCurrent && f.value.trim() !== '');
  const val = (type: string): string | null => currentFacts.find((f) => f.factType === type)?.value.trim() ?? null;
  const inputs: EmailInputs = { facts, findings, demo: null };
  return {
    businessName: val('business_name'),
    contactName: val('contact_name'),
    language: buildEmailContext(inputs).language,
    facts: currentFacts.map((f) => ({ evidenceId: f.id, type: f.factType, value: f.value.trim() })),
    findings: findings.map((f) => ({
      evidenceId: f.id,
      findingRef: f.findingRef,
      category: f.category,
      observation: f.observation,
      recommendation: f.recommendation,
    })),
    demoLinkAllowed: false,
    approvedDemoFindingRefs: [],
    competitorPackage: null,
  };
}

export interface TerraGenDeps {
  provider: LlmProvider;
  budget: LiveCallBudget;
  config: TerraGenConfig;
  facts: LeadFact[];
  findings: EmailFinding[];
  now: () => Date;
}

export async function generateTerraBaseEmail(deps: TerraGenDeps): Promise<TerraBaseResult> {
  const { provider, budget, config } = deps;
  const brief = buildProspectOnlyBrief(deps.facts, deps.findings);
  const emailInputs: EmailInputs = { facts: deps.facts, findings: deps.findings, demo: null };
  const ctx = buildEmailContext(emailInputs);
  const msgs = buildEmailWriterMessages(brief, null);

  budget.reserve('TERRA_BASE');
  const res = await provider.generate({
    task: 'email_write',
    system: msgs.system,
    user: msgs.user,
    images: [],
    outputSchema: EMAIL_WRITER_JSON_SCHEMA,
    schemaName: 'email_write',
    model: config.model,
    reasoningEffort: config.effort,
    store: config.store,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: 0,
  });
  const call = toModelCall('TERRA_BASE', 'email_write', res, deps.now().toISOString());

  if (res.status === 'refusal') return { ok: false, reason: 'TERRA_PROVIDER_REFUSAL', violations: [res.refusal ?? 'refused'], call };
  if (res.status === 'rate_limited') return { ok: false, reason: 'TERRA_RATE_LIMITED', violations: ['provider rate limited'], call };
  if (res.status === 'transient' || res.status === 'incomplete' || res.status === 'input_too_large') {
    return { ok: false, reason: 'TERRA_TRANSIENT_ERROR', violations: [res.incompleteReason ?? res.status], call };
  }
  const parsed = emailWriterSchema.safeParse(res.rawJson);
  if (!parsed.success) {
    return { ok: false, reason: 'TERRA_MALFORMED_RESPONSE', violations: parsed.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`), call };
  }
  const draft = parsed.data;

  // Prospect-only base MUST declare NONE; the deterministic composer sets the enriched mode later.
  if (draft.competitor_evidence_used !== 'NONE') {
    return { ok: false, reason: 'TERRA_COMPETITOR_LEAK', violations: [`competitor_evidence_used=${draft.competitor_evidence_used} (must be NONE)`], call };
  }

  const check = validateEmail(draft, ctx);
  if (!check.ok) {
    // Competitor language in the body is caught by validateEmail's competitor gate; classify it distinctly.
    const reason: TerraFailureReason = check.violations.some((v) => v.startsWith('competitor'))
      ? 'TERRA_COMPETITOR_LEAK'
      : 'TERRA_VALIDATION_FAILED';
    return { ok: false, reason, violations: check.violations, call };
  }

  return { ok: true, draft, brief, call };
}

export { EMAIL_WRITER_PROMPT_VERSION };
