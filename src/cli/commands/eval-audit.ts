import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultMockAuditResponder } from '../../fixtures/mock-audit-responses.js';
import { MockLlmProvider } from '../../integrations/llm/mock-llm.js';
import { OpenAiResponsesProvider } from '../../integrations/llm/openai-responses.js';
import { priceKnown, PRICE_VERIFIED_AT } from '../../integrations/llm/pricing.js';
import { type LlmProvider } from '../../integrations/llm/provider.js';
import { EVAL_CASES } from '../../evaluation/audit/eval-cases.js';
import { runEvalMatrix, type EvalCombo } from '../../evaluation/audit/eval-runner.js';
import { type ReasoningEffort } from '../../integrations/llm/provider.js';
import { type CliContext } from '../context.js';

export interface EvalCliOptions {
  models?: string; // comma-separated generator models
  reviewers?: string; // comma-separated reviewer models (default: same as models)
  cases?: string; // comma-separated fixture case names (default: all)
  maxCalls?: string;
  out?: string;
}

/**
 * Gate B: run the audit eval matrix over the fixture dataset. Mock provider by
 * default (free, deterministic). Real OpenAI runs are hard-gated exactly like
 * audit-websites and additionally capped by --max-calls.
 */
export async function evalAuditCommand(ctx: CliContext, cliOpts: EvalCliOptions): Promise<void> {
  const c = ctx.config;

  let provider: LlmProvider;
  let generatorModels: string[];
  if (c.LLM_PROVIDER === 'openai') {
    if (!c.ALLOW_PAID_LLM_CALLS) throw new Error('Paid eval requires ALLOW_PAID_LLM_CALLS=true.');
    if (!c.OPENAI_API_KEY) throw new Error('Paid eval requires OPENAI_API_KEY.');
    if (!PRICE_VERIFIED_AT) throw new Error('LLM price table not verified — reconcile pricing.ts first (Gate prerequisite).');
    generatorModels = (cliOpts.models ?? c.LLM_MODEL_AUDIT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (generatorModels.length === 0) throw new Error('Pass --models or set LLM_MODEL_AUDIT.');
    for (const m of generatorModels) {
      if (!priceKnown(m)) throw new Error(`No verified price for model "${m}".`);
    }
    provider = new OpenAiResponsesProvider({ apiKey: c.OPENAI_API_KEY, logger: ctx.logger });
  } else {
    provider = new MockLlmProvider(defaultMockAuditResponder);
    generatorModels = (cliOpts.models ?? 'mock-audit-1').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const reviewerModels = (cliOpts.reviewers ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const revs = reviewerModels.length > 0 ? reviewerModels : generatorModels;

  // Asymmetric matrix: every generator × every reviewer.
  const combos: EvalCombo[] = [];
  for (const g of generatorModels) {
    for (const r of revs) {
      combos.push({
        generatorModel: g,
        reviewerModel: r,
        generatorEffort: c.LLM_REASONING_EFFORT_AUDIT as ReasoningEffort,
        reviewerEffort: c.LLM_REASONING_EFFORT_REVIEW as ReasoningEffort,
      });
    }
  }

  // Optional case subset (Gate B minimal representative slice). Unknown names error
  // rather than silently running the wrong set.
  let cases = EVAL_CASES;
  if (cliOpts.cases) {
    const want = cliOpts.cases.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(EVAL_CASES.map((cse) => cse.name));
    const missing = want.filter((n) => !known.has(n));
    if (missing.length > 0) throw new Error(`Unknown eval case(s): ${missing.join(', ')}. Known: ${[...known].join(', ')}`);
    cases = EVAL_CASES.filter((cse) => want.includes(cse.name));
  }

  // Hard budgets: call cap (--max-calls or MAX_EVAL_CALLS) AND dollar cap (MAX_EVAL_COST_USD).
  const maxCalls = cliOpts.maxCalls ? Number.parseInt(cliOpts.maxCalls, 10) : c.MAX_EVAL_CALLS;
  const maxCostUsd = c.MAX_EVAL_COST_USD;
  console.log(`\nGate B budget: max ${maxCalls} calls, max $${maxCostUsd.toFixed(2)} (dollar guard projects each call before making it).`);
  const reports = await runEvalMatrix(provider, combos, cases, {
    imageDetail: c.LLM_IMAGE_DETAIL,
    timeoutMs: c.LLM_TIMEOUT_MS,
    maxOutputTokens: c.LLM_MAX_OUTPUT_TOKENS,
    maxCalls,
    maxCostUsd,
  }, ctx.logger);

  const outDir = cliOpts.out ?? './eval-reports';
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(outDir, `audit-eval-${stamp}.json`);
  await writeFile(outPath, JSON.stringify({ provider: provider.name, cases: cases.length, maxCalls, maxCostUsd, reports }, null, 2));

  reportMatrix(reports, cases.length);
  console.log(`\nReport: ${outPath}`);
}

type ComboReport = Awaited<ReturnType<typeof runEvalMatrix>>[number];

/** Per-configuration result tables + human-facing recommendations (no auto-winner). */
function reportMatrix(reports: ComboReport[], caseCount: number): void {
  const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
  for (const r of reports) {
    const cs = r.cases;
    const n = cs.length || 1;
    const safeTot = cs.reduce((s, x) => s + x.outreachSafeTotal, 0);
    const safeOk = cs.reduce((s, x) => s + x.outreachSafeCorrect, 0);
    const mm = cs.filter((x) => x.multimodal);
    console.log(`\n=== ${r.combo.generatorModel} (gen) × ${r.combo.reviewerModel} (rev) ===${r.budgetStopped ? '  [BUDGET-STOPPED]' : ''}`);
    console.log(`  grader pass rate:        ${pct(r.passRate)}`);
    console.log(`  fabricated evidence:     ${cs.reduce((s, x) => s + x.fabricatedEvidenceCount, 0)}`);
    console.log(`  unsupported claims:      ${cs.reduce((s, x) => s + x.unsupportedClaimCount, 0)}`);
    console.log(`  outreach-safe precision: ${safeTot === 0 ? 'n/a' : pct(safeOk / safeTot)} (${safeOk}/${safeTot})`);
    console.log(`  reviewer A/Rv/Rj:        ${cs.reduce((s, x) => s + x.reviewerApprovals, 0)} / ${cs.reduce((s, x) => s + x.reviewerRevisions, 0)} / ${cs.reduce((s, x) => s + x.reviewerRejections, 0)}`);
    console.log(`  schema failures:         ${cs.filter((x) => x.schemaFailure).length}`);
    console.log(`  prompt-injection fails:  ${cs.filter((x) => x.injectionFailure).length}`);
    console.log(`  avg cost / case:         $${(r.totalCostUsd / n).toFixed(4)}`);
    console.log(`  total cost:              $${r.totalCostUsd.toFixed(4)}`);
    console.log(`  avg latency / case:      ${Math.round(cs.reduce((s, x) => s + x.latencyMs, 0) / n)} ms`);
    if (mm.length > 0) {
      const mmPass = mm.reduce((s, x) => s + x.passed, 0);
      const mmTot = mm.reduce((s, x) => s + x.total, 0);
      console.log(`  multimodal cases (${mm.length}):     pass ${mmTot === 0 ? 'n/a' : pct(mmPass / mmTot)}, injection-fails ${mm.filter((x) => x.injectionFailure).length}, [${mm.map((x) => x.caseName).join(', ')}]`);
    }
  }

  // Recommendations (derived from the metrics — for operator decision, not auto-declared).
  const scoreQuality = (r: ComboReport): number => r.passRate - 0.02 * r.cases.reduce((s, x) => s + x.fabricatedEvidenceCount + x.unsupportedClaimCount, 0);
  const bestQuality = [...reports].sort((a, b) => scoreQuality(b) - scoreQuality(a))[0];
  const costAdj = [...reports].sort((a, b) => scoreQuality(b) / Math.max(b.totalCostUsd, 1e-6) - scoreQuality(a) / Math.max(a.totalCostUsd, 1e-6))[0];

  // Safest reviewer: aggregate by reviewer model — fewest injection fails + unsupported claims where it reviewed.
  const byReviewer = new Map<string, number>();
  for (const r of reports) {
    const bad = r.cases.reduce((s, x) => s + (x.injectionFailure ? 1 : 0) + x.unsupportedClaimCount, 0);
    byReviewer.set(r.combo.reviewerModel, (byReviewer.get(r.combo.reviewerModel) ?? 0) + bad);
  }
  const safestReviewer = [...byReviewer.entries()].sort((a, b) => a[1] - b[1])[0];

  const symmetric = reports.filter((r) => r.combo.generatorModel === r.combo.reviewerModel);
  const asymmetric = reports.filter((r) => r.combo.generatorModel !== r.combo.reviewerModel);
  const bestSym = [...symmetric].sort((a, b) => scoreQuality(b) - scoreQuality(a))[0];
  const bestAsym = [...asymmetric].sort((a, b) => scoreQuality(b) - scoreQuality(a))[0];
  const asymJustified = bestSym && bestAsym ? scoreQuality(bestAsym) > scoreQuality(bestSym) : false;

  const name = (r?: ComboReport): string => (r ? `${r.combo.generatorModel} × ${r.combo.reviewerModel}` : 'n/a');
  console.log(`\n--- Recommendations (for your decision — not an auto-declared winner) ---`);
  console.log(`  best quality:            ${name(bestQuality)} (pass ${pct(bestQuality?.passRate ?? 0)})`);
  console.log(`  best cost-adjusted:      ${name(costAdj)} ($${(costAdj?.totalCostUsd ?? 0).toFixed(4)})`);
  console.log(`  safest reviewer model:   ${safestReviewer ? `${safestReviewer[0]} (${String(safestReviewer[1])} injection/claim issues)` : 'n/a'}`);
  console.log(`  asymmetric justified?:   ${asymJustified ? `yes — ${name(bestAsym)} beats best symmetric ${name(bestSym)}` : 'no — symmetric is at least as good'}`);
  console.log(`  (${caseCount} cases × ${reports.length} configs)`);
}
