import { type Logger } from 'pino';
import { type LlmProvider, type ReasoningEffort } from '../../integrations/llm/provider.js';
import { estimateCostUsd, worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { buildExtractorMessages } from '../../prompts/decision-makers/index.js';
import { DECISION_MAKER_JSON_SCHEMA, DECISION_MAKER_SCHEMA_VERSION, decisionMakerExtractionOutputSchema, type DecisionMakerExtractionOutputParsed } from './schema.js';
import { classifyTitlePriority, type TitlePriority } from './title-priority.js';
import { MAX_EVIDENCE_CHARS_PER_PAGE } from './evidence-extraction.js';
import { type EvidencePage } from './website-evidence.js';

export interface DecisionMakerLlmDeps {
  provider: LlmProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  store: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  maxCallsPerLead: number;
  maxCostUsdPerLead: number;
  minConfidence: number;
  logger: Logger;
}

export interface ProvenancedCandidate {
  fullName: string;
  title: string;
  priority: TitlePriority;
  confidence: number;
  sourceUrl: string;
  evidenceSnippet: string;
}

export type RejectionReason = 'evidence_unresolvable' | 'low_confidence' | 'unmapped_title' | 'duplicate' | 'not_a_person';

/** Corporate-entity wording in a "name". A chain's About page can state that its majority owner is a
 * holding company; that is an organisation, never an outreach decision-maker. */
const ORGANIZATION_NAME_RE = /\b(ltd|limited|llc|llp|plc|inc|gmbh|ag|bv|nv|holdings?|capital|group|partners|investments?|corporation|corp|company)\b/i;
export interface RejectedCandidate {
  fullName: string;
  title: string;
  reason: RejectionReason;
}

export type ExtractionOutcome =
  | { status: 'ok'; accepted: ProvenancedCandidate[]; rejected: RejectedCandidate[]; insufficientEvidence: boolean; costUsd: number }
  | { status: 'no_pages' }
  | { status: 'budget_blocked' }
  | { status: 'schema_invalid'; errors: string[] }
  | { status: 'provider_error'; message: string };

const ALIAS_RE = /^E(\d+)$/;

/** Resolve a model-supplied evidence tag (e.g. "E2") to the real page it refers to, positionally over
 * the SAME pages array sent in the prompt — never invents a mapping for an unknown/out-of-range tag. */
function resolvePageAlias(tag: string, pages: readonly EvidencePage[]): EvidencePage | null {
  const m = ALIAS_RE.exec(tag.trim());
  if (!m) return null;
  const idx = Number(m[1]) - 1;
  return idx >= 0 && idx < pages.length ? (pages[idx] ?? null) : null;
}

/**
 * Pure deterministic pipeline applied to every model-proposed candidate, regardless of what the model
 * returned: unresolvable evidence citation -> reject; below-threshold confidence -> reject; title that
 * doesn't map to a qualifying tier -> reject (ordinary staff never slip through); duplicate name ->
 * reject; then sort by (priority asc, confidence desc) and hard-cap to 3.
 */
export function filterAndRankCandidates(
  parsed: DecisionMakerExtractionOutputParsed,
  pages: readonly EvidencePage[],
  practiceName: string | null,
  minConfidence: number,
): { accepted: ProvenancedCandidate[]; rejected: RejectedCandidate[] } {
  const seenNames = new Set<string>();
  const scored: ProvenancedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const cand of parsed.candidates) {
    if (ORGANIZATION_NAME_RE.test(cand.fullName)) {
      rejected.push({ fullName: cand.fullName, title: cand.title, reason: 'not_a_person' });
      continue;
    }
    const resolvedPages = cand.evidenceIds
      .map((tag) => resolvePageAlias(tag, pages))
      .filter((p): p is EvidencePage => p !== null);
    if (resolvedPages.length === 0) {
      rejected.push({ fullName: cand.fullName, title: cand.title, reason: 'evidence_unresolvable' });
      continue;
    }
    if (cand.confidence < minConfidence) {
      rejected.push({ fullName: cand.fullName, title: cand.title, reason: 'low_confidence' });
      continue;
    }
    const citedPage = resolvedPages[0];
    // Every page in `pages` was fetched same-origin from the lead's verified official domain, so the
    // cited page's role is sufficient provenance for the ambiguous Director tier.
    const provenance = citedPage ? { role: citedPage.role, officialDomain: true } : null;
    const priority = classifyTitlePriority(cand.title, cand.evidenceSnippet, practiceName, provenance);
    if (priority === null) {
      rejected.push({ fullName: cand.fullName, title: cand.title, reason: 'unmapped_title' });
      continue;
    }
    const normName = cand.fullName.trim().toLowerCase();
    if (seenNames.has(normName)) {
      rejected.push({ fullName: cand.fullName, title: cand.title, reason: 'duplicate' });
      continue;
    }
    seenNames.add(normName);
    const firstPage = resolvedPages[0];
    if (!firstPage) continue; // unreachable (resolvedPages.length > 0 checked above); satisfies strict-null-checks
    scored.push({
      fullName: cand.fullName.trim(),
      title: cand.title.trim(),
      priority,
      confidence: cand.confidence,
      sourceUrl: firstPage.url,
      evidenceSnippet: cand.evidenceSnippet,
    });
  }

  scored.sort((a, b) => a.priority - b.priority || b.confidence - a.confidence);
  return { accepted: scored.slice(0, 3), rejected };
}

/** Conservative worst-case input-token estimate for the pre-call budget proof: bounded by the hard cap
 * `gatherWebsiteEvidence` applies to each page's assembled evidence text (system text + up to
 * `maxPages` evidence pages, each at most MAX_EVIDENCE_CHARS_PER_PAGE), using a standard
 * ~4-chars-per-token approximation, rounded up. */
function worstCaseInputTokensFor(maxPages: number): number {
  const SYSTEM_PROMPT_CHARS_ESTIMATE = 2500;
  return Math.ceil((SYSTEM_PROMPT_CHARS_ESTIMATE + maxPages * MAX_EVIDENCE_CHARS_PER_PAGE) / 4);
}

/**
 * Extract, validate, and deterministically filter decision-maker candidates from ALREADY-GATHERED
 * website evidence for ONE lead. Exactly one LLM call, no repair/retry loop (deliberately simpler than
 * the audit's generator/reviewer repair pattern — a `schema_invalid` result just fails this lead
 * closed so the caller can move to the next one). Fails closed on any budget/config uncertainty.
 */
export async function extractDecisionMakers(
  deps: DecisionMakerLlmDeps,
  pages: EvidencePage[],
  practiceName: string | null,
  maxPagesForBudget: number,
): Promise<ExtractionOutcome> {
  if (pages.length === 0) return { status: 'no_pages' };
  if (deps.maxCallsPerLead < 1) return { status: 'budget_blocked' };

  const isRealProvider = deps.provider.name !== 'mock';
  if (isRealProvider) {
    const projected = worstCaseCostUsd(deps.model, worstCaseInputTokensFor(maxPagesForBudget), deps.maxOutputTokens);
    if (projected === null || projected > deps.maxCostUsdPerLead) return { status: 'budget_blocked' };
  }

  const { system, user } = buildExtractorMessages(pages);
  let res;
  try {
    res = await deps.provider.generate({
      task: 'decision_maker_extraction',
      system,
      user,
      images: [],
      outputSchema: DECISION_MAKER_JSON_SCHEMA,
      schemaName: `decision_maker_extraction_${DECISION_MAKER_SCHEMA_VERSION}`,
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
      store: deps.store,
      timeoutMs: deps.timeoutMs,
      maxOutputTokens: deps.maxOutputTokens,
      maxRetries: deps.maxRetries,
    });
  } catch (err) {
    deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'decision-makers: provider call failed');
    return { status: 'provider_error', message: err instanceof Error ? err.message : String(err) };
  }

  if (res.status !== 'ok') {
    return { status: 'provider_error', message: `${res.status}${res.refusal ? `: ${res.refusal}` : ''}${res.incompleteReason ? `: ${res.incompleteReason}` : ''}` };
  }

  const parsed = decisionMakerExtractionOutputSchema.safeParse(res.rawJson);
  if (!parsed.success) {
    return { status: 'schema_invalid', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }

  const { accepted, rejected } = filterAndRankCandidates(parsed.data, pages, practiceName, deps.minConfidence);
  const costUsd = isRealProvider ? (estimateCostUsd(deps.model, res.usage) ?? 0) : 0;
  return { status: 'ok', accepted, rejected, insufficientEvidence: parsed.data.insufficientEvidence, costUsd };
}
