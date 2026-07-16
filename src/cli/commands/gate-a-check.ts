import { buildEvidencePackage, type EvidenceImage, type PackageFacts } from '../../domain/audit/evidence-package.js';
import { TOKEN_BUDGET, worstCaseInputTokensForCall } from '../../domain/audit/token-budget.js';
import { estimateImageTokens } from '../../integrations/llm/image-tokens.js';
import { resizeForUpload } from '../../integrations/capture/resize-screenshot.js';
import { LocalFsCaptureStorage } from '../../integrations/capture/local-fs-storage.js';
import { PRICE_VERIFIED_AT, priceKnown, SHORT_CONTEXT_THRESHOLD_IS_OFFICIAL, worstCaseCostUsd } from '../../integrations/llm/pricing.js';
import { AuditInputRepository } from '../../persistence/repositories/audit-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { type CliContext } from '../context.js';

export interface GateACheckOptions {
  limit?: string;
}

const yn = (b: boolean): string => (b ? 'yes' : 'NO');

/**
 * Gate A readiness report. Prints — WITHOUT revealing secrets — the projected token
 * and cost bounds for every READY_FOR_AUDIT lead, plus the configured caps and safety
 * gates, so the operator can confirm the run is affordable and correctly configured
 * before approving Gate A. Makes NO OpenAI call.
 */
export async function gateACheckCommand(ctx: CliContext, opts: GateACheckOptions): Promise<void> {
  const c = ctx.config;
  const model = c.LLM_MODEL_AUDIT ?? '(unset)';
  const reviewModel = c.LLM_MODEL_REVIEW ?? c.LLM_MODEL_AUDIT ?? '(unset)';

  console.log('\n=== Gate A readiness ===');
  console.log('Configuration & safety gates:');
  console.log(`  provider:                 ${c.LLM_PROVIDER}`);
  console.log(`  audit model:              ${model}`);
  console.log(`  review model:             ${reviewModel}`);
  console.log(`  image detail:             ${c.LLM_IMAGE_DETAIL}${c.LLM_IMAGE_DETAIL === 'high' ? '' : '   ⚠ Gate A requires high'}`);
  console.log(`  prompt cache:             ${c.LLM_PROMPT_CACHE_ENABLED ? 'ON ⚠ (Gate A expects off)' : 'off'}`);
  console.log(`  request timeout:          ${c.LLM_TIMEOUT_MS} ms`);
  console.log(`  SDK maxRetries:           0 (per-request; no SDK auto-retries)`);
  console.log(`  API key configured:       ${yn(Boolean(c.OPENAI_API_KEY))}`);
  console.log(`  paid calls enabled:       ${yn(c.ALLOW_PAID_LLM_CALLS)}`);
  console.log(`  pricing verified:         ${PRICE_VERIFIED_AT ?? 'NO'}  (model priced: ${yn(priceKnown(model))})`);
  console.log(`  short/long threshold:     ${SHORT_CONTEXT_THRESHOLD_IS_OFFICIAL ? 'official' : 'internal conservative classification (not official)'}`);
  console.log('Call caps:');
  console.log(`  MAX_LLM_CALLS_PER_RUN:    ${c.MAX_LLM_CALLS_PER_RUN}`);
  console.log(`  MAX_LLM_CALLS_PER_LEAD:   ${c.MAX_LLM_CALLS_PER_LEAD}`);
  console.log(`  generator/reviewer attempts: ${c.LLM_MAX_GENERATOR_ATTEMPTS} / ${c.LLM_MAX_REVIEWER_ATTEMPTS}${c.LLM_MAX_GENERATOR_ATTEMPTS === 1 && c.LLM_MAX_REVIEWER_ATTEMPTS === 1 ? ' (no retries — Gate A)' : ''}`);
  console.log('Cost caps:');
  console.log(`  MAX_LLM_COST_USD_PER_RUN: $${c.MAX_LLM_COST_USD_PER_RUN.toFixed(2)}`);
  console.log(`  MAX_LLM_COST_USD_PER_LEAD:$${c.MAX_LLM_COST_USD_PER_LEAD.toFixed(2)}`);

  const inputRepo = new AuditInputRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);
  const storage = new LocalFsCaptureStorage(c.CAPTURE_ARTIFACT_DIR);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'READY_FOR_AUDIT');
  if (opts.limit) leads = leads.slice(0, Number.parseInt(opts.limit, 10));

  if (leads.length === 0) {
    console.log('\nNo READY_FOR_AUDIT leads found. Capture a website first.');
    return;
  }

  for (const lead of leads) {
    const source = await inputRepo.latestAuditCapture(lead.id);
    const factRows = await factsRepo.listCurrentFacts(lead.id);
    const factVal = (t: string): string | null => factRows.find((f) => f.factType === t && f.isCurrent)?.value ?? null;
    const name = factVal('business_name') ?? '(unknown)';

    console.log(`\n--- lead ${lead.id} ---`);
    console.log(`  business:            ${name}`);
    if (!source) {
      console.log('  website:             (no usable AUDIT_CAPTURE run) — cannot audit');
      continue;
    }
    console.log(`  website:             ${source.primaryUrl ?? '(unknown)'}`);
    console.log(`  capture-run ID:      ${source.captureRunId}`);

    const facts: PackageFacts = { businessName: name, category: factVal('category'), city: factVal('city'), officialDomain: factVal('official_domain') };
    const images: EvidenceImage[] = [];
    let imageTokens: number | null = 0;
    const dims: Record<string, string> = { desktop: 'missing', mobile: 'missing' };
    for (const art of source.primaryViewportArtifacts.slice(0, c.MAX_LLM_INPUT_IMAGES_PER_CALL)) {
      const blob = await storage.read(art.sha256);
      if (!blob) { imageTokens = null; continue; }
      let resized;
      try { resized = await resizeForUpload(blob); } catch { imageTokens = null; continue; }
      const est = estimateImageTokens(resized.width, resized.height, c.LLM_IMAGE_DETAIL);
      dims[art.profile] = `${resized.width}x${resized.height}px${est ? ` → ~${String(est.tokens)} tok` : ' → undeterminable'}`;
      if (est === null) imageTokens = null;
      else if (imageTokens !== null) imageTokens += est.tokens;
      images.push({ id: art.id, sha256: art.sha256, profile: art.profile, mediaType: resized.mediaType, dataBase64: '', role: 'primary', widthPx: resized.width, heightPx: resized.height });
    }

    const pkg = buildEvidencePackage({
      leadId: lead.id, captureRunId: source.captureRunId, facts, primaryUrl: source.primaryUrl,
      evidence: source.evidence, images,
      versions: { extractor: source.extractorVersion ?? 'unknown', emulation: source.emulationProfileVersion ?? 'unknown', pageSelection: source.pageSelectionPolicyVersion ?? 'unknown' },
      limits: { maxEvidence: c.MAX_LLM_EVIDENCE_ITEMS, maxSecondaryPages: c.MAX_LLM_SECONDARY_PAGES, maxEvidenceChars: c.MAX_LLM_EVIDENCE_CHARS, maxImages: c.MAX_LLM_INPUT_IMAGES_PER_CALL },
    });

    const evItems = pkg.evidence.length;
    const sys = TOKEN_BUDGET.systemAndSchemaTokens;
    const evTok = evItems * TOKEN_BUDGET.perEvidenceItemTokens;
    const findingsTok = TOKEN_BUDGET.maxProposedFindings * TOKEN_BUDGET.perProposedFindingTokens;
    const genInput = imageTokens === null ? null : sys + evTok + imageTokens;
    const revInput = imageTokens === null ? null : sys + evTok + findingsTok + imageTokens;
    // The guard applies the reviewer-inclusive bound to BOTH calls (conservative).
    const bound = worstCaseInputTokensForCall({ evidenceItems: evItems, imageTokens });
    const outMax = c.LLM_MAX_OUTPUT_TOKENS;
    const perCall = bound === null ? null : worstCaseCostUsd(model, bound, outMax);
    const perCallRev = bound === null ? null : worstCaseCostUsd(reviewModel, bound, outMax);
    const totalMax = perCall === null || perCallRev === null ? null : perCall + perCallRev;

    console.log(`  screenshots:         desktop ${dims.desktop} | mobile ${dims.mobile}`);
    console.log(`  evidence items:      ${evItems}`);
    console.log(`  generator projected: input ≤ ${genInput ?? 'UNDETERMINABLE'} tok, output ≤ ${outMax} tok`);
    console.log(`  reviewer projected:  input ≤ ${revInput ?? 'UNDETERMINABLE'} tok, output ≤ ${outMax} tok`);
    console.log(`  guard input bound:   ${bound ?? 'UNDETERMINABLE (paid calls will be BLOCKED)'} tok/call`);
    console.log(`  projected max cost:  ${totalMax === null ? 'UNDETERMINABLE → calls blocked' : `$${totalMax.toFixed(4)} (gen $${(perCall ?? 0).toFixed(4)} + rev $${(perCallRev ?? 0).toFixed(4)})`}`);

    const withinCap = totalMax !== null && totalMax <= c.MAX_LLM_COST_USD_PER_LEAD;
    const ready = c.LLM_PROVIDER === 'openai' && Boolean(c.OPENAI_API_KEY) && c.ALLOW_PAID_LLM_CALLS &&
      Boolean(PRICE_VERIFIED_AT) && priceKnown(model) && c.LLM_IMAGE_DETAIL === 'high' && totalMax !== null && withinCap;
    console.log(`  within per-lead cap: ${totalMax === null ? 'n/a' : yn(withinCap)}`);
    console.log(`  GATE A READY:        ${ready ? 'YES' : 'NO'}`);
  }
}
