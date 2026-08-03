/**
 * Phase 7A4B — build and SANITIZE the Sol advisory-critique input, then make the single Sol call. Sol
 * receives the two rendered emails, the fictional business context, deterministic rubric + hard-gate
 * results, a sanitized issue description, and ANONYMIZED competitor-pattern metadata only. It NEVER receives
 * competitor identities, domains, or raw source text. `assertNoCompetitorIdentities` scans the exact
 * serialized request and fails closed if any identity token leaks. A malformed Sol response fails closed as
 * a documented advisory failure — it can never modify or approve an email or override deterministic safety.
 */

import { buildSolCritiqueMessages, SOL_CRITIQUE_PROMPT_VERSION, type SolCritiqueInput } from '../../../prompts/email/sol-critique.js';
import { SOL_CRITIQUE_JSON_SCHEMA, SOL_CRITIQUE_SCHEMA_NAME, solCritiqueSchema, type SolCritiqueParsed } from '../../../domain/email/sol-critique-schema.js';
import { type LlmProvider, type ReasoningEffort } from '../../../integrations/llm/provider.js';
import { type HarnessSuccess } from '../harness.js';
import { type ValidationReport } from '../validation-report.js';
import { LiveCallBudget, type LiveModelCall, toModelCall } from './live-types.js';

const CATEGORY_LABELS: Record<string, string> = {
  prospectSpecificity: 'Prospect specificity',
  materialRelevance: 'Material relevance',
  integrity: 'Evidence & traceability integrity',
  clarity: 'Clarity & readability',
  brevity: 'Brevity & focus',
  recommendationCta: 'Recommendation & CTA coherence',
  naturalness: 'Naturalness & non-template feel',
};

/** Build the sanitized, anonymized Sol input from the harness outcome + deterministic report. Pure. */
export function buildSolCritiqueInput(outcome: HarnessSuccess, report: ValidationReport): SolCritiqueInput {
  const plan = outcome.plan;
  const finding = outcome.emailInputs.findings[0];
  const baseline = report.baseline!;
  const enriched = report.enriched!;

  const businessContext = 'Fictional single-location general dental clinic (synthetic scenario; no real entity).';
  const verifiedIssueDescription = finding
    ? `${finding.category} (${finding.findingRef}): ${finding.observation}`
    : 'Verified prospect usability issue (mobile booking discoverability).';

  return {
    businessContext,
    verifiedIssueDescription,
    baselineSubject: baseline.subject,
    baselineBody: baseline.body,
    enrichedSubject: enriched.subject,
    enrichedBody: enriched.body,
    anonymizedPattern: {
      patternForm: plan.selection.pattern.result,
      presentCount: plan.selection.pattern.presentCount,
      usableDenominator: plan.selection.pattern.usableDenominator,
      consequenceLabel: plan.selection.pattern.consequenceLabel ?? '',
      countPhrase: plan.selection.pattern.wordingText ?? '',
      contrastPresent: plan.selection.contrast !== null,
    },
    deterministicRubric: {
      baselineTotal: baseline.rubric.total,
      enrichedTotal: enriched.rubric.total,
      scoreDifference: report.scoreDifference ?? enriched.rubric.total - baseline.rubric.total,
      categories: enriched.rubric.categories.map((c) => ({
        label: CATEGORY_LABELS[c.category] ?? c.category,
        baseline: baseline.rubric.categories.find((x) => x.category === c.category)?.points ?? 0,
        enriched: c.points,
        max: c.max,
      })),
    },
    hardGates: { allPassed: report.hardGates!.allPassed, failedIds: report.hardGates!.failedIds },
  };
}

export class SolSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolSanitizationError';
  }
}

/**
 * Fail closed if any competitor identity token appears anywhere in the EXACT serialized Sol request. Tokens
 * come from the approved package's identity list (competitor business names + parent brands). Case-insensitive.
 */
export function assertNoCompetitorIdentities(input: SolCritiqueInput, identityTokens: string[]): void {
  const { system, user } = buildSolCritiqueMessages(input);
  const haystack = `${system}\n${user}`.toLowerCase();
  for (const raw of identityTokens) {
    const token = raw.trim().toLowerCase();
    if (token.length >= 4 && haystack.includes(token)) {
      throw new SolSanitizationError(`competitor identity token leaked into Sol input: "${raw}"`);
    }
  }
}

export interface SolCritiqueConfig {
  model: string;
  effort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type SolCritiqueResult =
  | { ok: true; critique: SolCritiqueParsed; call: LiveModelCall }
  | { ok: false; reason: 'SOL_MALFORMED_RESPONSE' | 'SOL_PROVIDER_ERROR'; violations: string[]; call: LiveModelCall | null };

export interface SolCritiqueDeps {
  provider: LlmProvider;
  budget: LiveCallBudget;
  config: SolCritiqueConfig;
  input: SolCritiqueInput;
  identityTokens: string[];
  now: () => Date;
}

export async function runSolCritique(deps: SolCritiqueDeps): Promise<SolCritiqueResult> {
  // Defense-in-depth: never send an input that carries a competitor identity token.
  assertNoCompetitorIdentities(deps.input, deps.identityTokens);
  const msgs = buildSolCritiqueMessages(deps.input);

  deps.budget.reserve('SOL_CRITIQUE');
  const res = await deps.provider.generate({
    task: 'email_review',
    system: msgs.system,
    user: msgs.user,
    images: [],
    outputSchema: SOL_CRITIQUE_JSON_SCHEMA,
    schemaName: SOL_CRITIQUE_SCHEMA_NAME,
    model: deps.config.model,
    reasoningEffort: deps.config.effort,
    store: deps.config.store,
    timeoutMs: deps.config.timeoutMs,
    maxOutputTokens: deps.config.maxOutputTokens,
    maxRetries: 0,
  });
  const call = toModelCall('SOL_CRITIQUE', SOL_CRITIQUE_SCHEMA_NAME, res, deps.now().toISOString());

  if (res.status !== 'ok') {
    return { ok: false, reason: 'SOL_PROVIDER_ERROR', violations: [res.refusal ?? res.incompleteReason ?? res.status], call };
  }
  const parsed = solCritiqueSchema.safeParse(res.rawJson);
  if (!parsed.success) {
    return { ok: false, reason: 'SOL_MALFORMED_RESPONSE', violations: parsed.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`), call };
  }
  return { ok: true, critique: parsed.data, call };
}

export { SOL_CRITIQUE_PROMPT_VERSION };
