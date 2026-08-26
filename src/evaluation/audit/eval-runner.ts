import { type Logger } from 'pino';
import {
  auditGeneratorOutputSchema,
  auditReviewOutputSchema,
  GENERATOR_JSON_SCHEMA,
  REVIEWER_JSON_SCHEMA,
  type AuditGeneratorOutputParsed,
  type AuditReviewOutputParsed,
} from '../../domain/audit/audit-schema.js';
import { buildReviewerPackage, type EvidenceImage, type EvidencePackage } from '../../domain/audit/evidence-package.js';
import { worstCaseInputTokensForCall } from '../../domain/audit/token-budget.js';
import { validateGeneratorOutput } from '../../domain/audit/validation.js';
import { translateGeneratorAliases } from '../../domain/audit/evidence-alias.js';
import { buildGeneratorMessages, buildReviewerMessages } from '../../prompts/website-audit/index.js';
import { estimateImageTokens } from '../../integrations/llm/image-tokens.js';
import { worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { type ImageDetail, type LlmImage, type LlmProvider, type LlmResult, type ReasoningEffort } from '../../integrations/llm/provider.js';
import { type EvalCase } from './eval-cases.js';
import { gradeCase, type GradeResult } from './graders.js';

/** One generator×reviewer model pairing to evaluate (asymmetric combos allowed). */
export interface EvalCombo {
  generatorModel: string;
  reviewerModel: string;
  generatorEffort: ReasoningEffort;
  reviewerEffort: ReasoningEffort;
}

/** Per-call cost + token accounting, recorded for auditability of the paid run. */
export interface EvalCallRecord {
  role: 'generator' | 'reviewer';
  model: string;
  projectedCostUsd: number | null;
  actualCostUsd: number | null;
  cumulativeCostUsd: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  latencyMs: number;
  status: string;
}

export interface EvalCaseReport {
  caseName: string;
  multimodal: boolean;
  grades: GradeResult[];
  passed: number;
  total: number;
  generatorStatus: string;
  reviewerStatus: string | null;
  costUsd: number;
  latencyMs: number;
  fabricatedEvidenceCount: number;
  unsupportedClaimCount: number;
  schemaFailure: boolean;
  injectionFailure: boolean;
  reviewerApprovals: number;
  reviewerRevisions: number;
  reviewerRejections: number;
  outreachSafeTotal: number;
  outreachSafeCorrect: number;
  calls: EvalCallRecord[];
}

export interface EvalComboReport {
  combo: EvalCombo;
  cases: EvalCaseReport[];
  passRate: number;
  totalCostUsd: number;
  calls: number;
  budgetStopped: boolean;
}

export interface EvalRunnerOptions {
  imageDetail: ImageDetail;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Hard cap on total model calls across the whole matrix. */
  maxCalls: number;
  /** Hard cap on total estimated USD across the whole matrix (pre-call projection). */
  maxCostUsd: number;
}

function toLlmImages(images: EvidenceImage[], detail: ImageDetail): LlmImage[] {
  return images.map((i) => ({ id: i.id, mediaType: i.mediaType, dataBase64: i.dataBase64, detail }));
}

/** Conservative image-token sum for a package; null if any dimension is undeterminable. */
function imageTokensFor(images: EvidenceImage[], detail: ImageDetail): number | null {
  let sum = 0;
  for (const img of images) {
    const est = estimateImageTokens(img.widthPx, img.heightPx, detail);
    if (est === null) return null;
    sum += est.tokens;
  }
  return sum;
}

function tokenRecord(role: EvalCallRecord['role'], model: string, res: LlmResult, projected: number | null, cumulative: number): EvalCallRecord {
  return {
    role,
    model,
    projectedCostUsd: projected,
    actualCostUsd: res.usage.estimatedCostUsd,
    cumulativeCostUsd: Math.round(cumulative * 1_000_000) / 1_000_000,
    inputTokens: res.usage.inputTokens,
    cachedInputTokens: res.usage.cachedInputTokens,
    cacheWriteTokens: res.usage.cacheWriteTokens,
    outputTokens: res.usage.outputTokens,
    reasoningTokens: res.usage.reasoningTokens,
    latencyMs: res.latencyMs,
    status: res.status,
  };
}

/**
 * Model evaluation matrix runner (Gate B). DB-free and side-effect-free: drives
 * generator + reviewer per case (no repair, no retries), sends real screenshots for
 * multimodal cases, applies the deterministic graders, and enforces BOTH a call cap
 * and a dollar cap — projecting each call's worst-case cost before making it and
 * stopping safely when either limit would be exceeded. Prompt caching is not used.
 */
export async function runEvalMatrix(
  provider: LlmProvider,
  combos: EvalCombo[],
  cases: EvalCase[],
  opts: EvalRunnerOptions,
  logger: Logger,
): Promise<EvalComboReport[]> {
  const reports: EvalComboReport[] = [];
  const isReal = provider.name !== 'mock';
  let calls = 0;
  let cumCost = 0;
  let budgetStopped = false;

  // Can we afford one more call whose worst-case projection is `projected`?
  const canAfford = (projected: number | null): boolean => {
    if (calls + 1 > opts.maxCalls) return false;
    if (!isReal) return true; // mock is free; call cap already checked
    if (projected === null) return false; // cannot project → fail closed
    return cumCost + projected <= opts.maxCostUsd;
  };

  const project = (model: string, pkg: EvidencePackage): number | null => {
    const imgTok = imageTokensFor(pkg.images, opts.imageDetail);
    const inTok = worstCaseInputTokensForCall({ evidenceItems: pkg.evidence.length, imageTokens: imgTok });
    return inTok === null ? null : worstCaseCostUsd(model, inTok, opts.maxOutputTokens);
  };

  for (const combo of combos) {
    const caseReports: EvalCaseReport[] = [];
    for (const c of cases) {
      if (budgetStopped) break;
      const multimodal = c.package.images.length > 0;
      const callRecords: EvalCallRecord[] = [];

      // --- Generator ---
      const genProjected = project(combo.generatorModel, c.package);
      if (!canAfford(genProjected)) {
        budgetStopped = true;
        logger.warn({ calls, cumCost, maxCalls: opts.maxCalls, maxCostUsd: opts.maxCostUsd }, 'eval budget reached — stopping before generator');
        break;
      }
      const genMsgs = buildGeneratorMessages(c.package, null);
      const genRes = await provider.generate({
        task: 'website_audit', system: genMsgs.system, user: genMsgs.user,
        images: toLlmImages(c.package.images, opts.imageDetail),
        outputSchema: GENERATOR_JSON_SCHEMA, schemaName: 'website_audit',
        model: combo.generatorModel, reasoningEffort: combo.generatorEffort,
        store: false, timeoutMs: opts.timeoutMs, maxOutputTokens: opts.maxOutputTokens, maxRetries: 0,
      });
      calls += 1;
      cumCost += genRes.usage.estimatedCostUsd ?? 0;
      callRecords.push(tokenRecord('generator', combo.generatorModel, genRes, genProjected, cumCost));

      let gen: AuditGeneratorOutputParsed | null = null;
      let genSchemaFailure = false;
      if (genRes.status === 'ok') {
        const parsed = auditGeneratorOutputSchema.safeParse(genRes.rawJson);
        // Mirror the audit service: resolve model-facing evidence tags (E1 …) to real IDs before
        // validation/grading, so the eval reflects the real pipeline. Unknown tags pass through.
        if (parsed.success) gen = translateGeneratorAliases(parsed.data, c.package);
        else genSchemaFailure = true;
      }

      // --- Independent reviewer (only if the generator produced parseable output and budget allows) ---
      let rev: AuditReviewOutputParsed | null = null;
      let revStatus: string | null = null;
      let revSchemaFailure = false;
      if (gen) {
        const reviewerPkg = buildReviewerPackage(c.package, new Set(gen.findings.flatMap((f) => f.evidenceIds)));
        const revProjected = project(combo.reviewerModel, reviewerPkg);
        if (canAfford(revProjected)) {
          const revMsgs = buildReviewerMessages(reviewerPkg, gen, null);
          const revRes = await provider.generate({
            task: 'audit_review', system: revMsgs.system, user: revMsgs.user,
            images: toLlmImages(reviewerPkg.images, opts.imageDetail),
            outputSchema: REVIEWER_JSON_SCHEMA, schemaName: 'audit_review',
            model: combo.reviewerModel, reasoningEffort: combo.reviewerEffort,
            store: false, timeoutMs: opts.timeoutMs, maxOutputTokens: opts.maxOutputTokens, maxRetries: 0,
          });
          calls += 1;
          cumCost += revRes.usage.estimatedCostUsd ?? 0;
          callRecords.push(tokenRecord('reviewer', combo.reviewerModel, revRes, revProjected, cumCost));
          revStatus = revRes.status;
          if (revRes.status === 'ok') {
            const parsed = auditReviewOutputSchema.safeParse(revRes.rawJson);
            if (parsed.success) rev = parsed.data;
            else revSchemaFailure = true;
          }
        } else {
          // Generator ran but the reviewer can't fit the budget — record the partial case and stop.
          budgetStopped = true;
          logger.warn({ calls, cumCost }, 'eval budget reached — stopping before reviewer');
        }
      }

      caseReports.push(buildCaseReport(c, multimodal, gen, rev, genRes.status, revStatus, genSchemaFailure, revSchemaFailure, callRecords, acceptedCountOf(gen, rev)));
    }
    reports.push(finalizeCombo(combo, caseReports, calls, budgetStopped));
    if (budgetStopped) break;
  }
  return reports;
}

function acceptedCountOf(gen: AuditGeneratorOutputParsed | null, rev: AuditReviewOutputParsed | null): number {
  if (!gen) return 0;
  if (!rev) return gen.findings.length;
  return gen.findings.filter((f) => rev.findings.find((r) => r.findingRef === f.findingRef)?.decision !== 'REJECT').length;
}

function buildCaseReport(
  c: EvalCase,
  multimodal: boolean,
  gen: AuditGeneratorOutputParsed | null,
  rev: AuditReviewOutputParsed | null,
  generatorStatus: string,
  reviewerStatus: string | null,
  genSchemaFailure: boolean,
  revSchemaFailure: boolean,
  calls: EvalCallRecord[],
  acceptedCount: number,
): EvalCaseReport {
  const grades = gradeCase(c, gen, rev, acceptedCount);
  const gradeMap = new Map(grades.map((g) => [g.name, g.pass]));

  // Fabricated evidence + unsupported claims from the deterministic validator.
  let fabricatedEvidenceCount = 0;
  let unsupportedClaimCount = 0;
  if (gen) {
    for (const v of validateGeneratorOutput(gen, c.package).violations) {
      if (v.startsWith('evidence_outside_package')) fabricatedEvidenceCount += 1;
      else if (v.startsWith('forbidden_claim') || v.startsWith('prompt_leakage') || v.startsWith('placeholder')) unsupportedClaimCount += 1;
    }
  }

  const injectionFailure = gradeMap.get('no_injection_marker') === false || gradeMap.get('no_attacker_urls') === false;

  let reviewerApprovals = 0;
  let reviewerRevisions = 0;
  let reviewerRejections = 0;
  for (const r of rev?.findings ?? []) {
    if (r.decision === 'APPROVE') reviewerApprovals += 1;
    else if (r.decision === 'REVISE') reviewerRevisions += 1;
    else if (r.decision === 'REJECT') reviewerRejections += 1;
  }

  // Outreach-safe precision: of generator findings marked safe, how many the reviewer
  // confirms safe (not rejected AND reviewer-safe). Precision, not volume.
  let outreachSafeTotal = 0;
  let outreachSafeCorrect = 0;
  for (const f of gen?.findings ?? []) {
    if (!f.safeForOutreach) continue;
    outreachSafeTotal += 1;
    const r = rev?.findings.find((x) => x.findingRef === f.findingRef);
    if (r && r.decision !== 'REJECT' && r.safeForOutreach) outreachSafeCorrect += 1;
  }

  return {
    caseName: c.name,
    multimodal,
    grades,
    passed: grades.filter((g) => g.pass).length,
    total: grades.length,
    generatorStatus,
    reviewerStatus,
    costUsd: Math.round(calls.reduce((s, r) => s + (r.actualCostUsd ?? 0), 0) * 1_000_000) / 1_000_000,
    latencyMs: calls.reduce((s, r) => s + r.latencyMs, 0),
    fabricatedEvidenceCount,
    unsupportedClaimCount,
    schemaFailure: genSchemaFailure || revSchemaFailure,
    injectionFailure,
    reviewerApprovals,
    reviewerRevisions,
    reviewerRejections,
    outreachSafeTotal,
    outreachSafeCorrect,
    calls,
  };
}

function finalizeCombo(combo: EvalCombo, caseReports: EvalCaseReport[], calls: number, budgetStopped: boolean): EvalComboReport {
  const passed = caseReports.reduce((s, r) => s + r.passed, 0);
  const total = caseReports.reduce((s, r) => s + r.total, 0);
  return {
    combo,
    cases: caseReports,
    passRate: total === 0 ? 0 : Math.round((passed / total) * 1000) / 1000,
    totalCostUsd: Math.round(caseReports.reduce((s, r) => s + r.costUsd, 0) * 1_000_000) / 1_000_000,
    calls,
    budgetStopped,
  };
}
