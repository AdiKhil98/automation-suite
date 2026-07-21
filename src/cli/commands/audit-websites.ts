import { getCampaign } from '../../config/campaigns.js';
import { buildEvidencePackage, type EvidenceImage, type PackageFacts } from '../../domain/audit/evidence-package.js';
import { recoverEnvelopes } from '../../domain/audit/envelope-recovery.js';
import { worstCaseInputTokensForCall } from '../../domain/audit/token-budget.js';
import { estimateImageTokens } from '../../integrations/llm/image-tokens.js';
import { resizeForUpload } from '../../integrations/capture/resize-screenshot.js';
import { LocalFsCaptureStorage } from '../../integrations/capture/local-fs-storage.js';
import { auditWebsites, type AuditItem } from '../../pipeline/audit-websites.js';
import { AuditInputRepository } from '../../persistence/repositories/audit-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { PipelineRunsRepository } from '../../persistence/repositories/runs.repo.js';
import { buildAuditService } from './audit-build.js';
import { type CliContext } from '../context.js';

export interface AuditCliOptions {
  campaign: string;
  limit?: string;
  lead?: string;
}

export async function auditWebsitesCommand(ctx: CliContext, cliOpts: AuditCliOptions): Promise<void> {
  const campaign = getCampaign(cliOpts.campaign);
  const c = ctx.config;
  const { service, envelopes, uow, providerName } = buildAuditService(ctx);

  // Startup recovery scan: replay any paid results whose DB write previously failed
  // BEFORE spending anything new (amendment 9).
  const recovery = await recoverEnvelopes(uow, envelopes, ctx.logger);
  if (recovery.scanned > 0) {
    console.log(`Envelope recovery: ${recovery.replayed} replayed, ${recovery.alreadyPersisted} already persisted, ${recovery.failed} failed.`);
    if (recovery.failed > 0) {
      console.error('Unrecovered envelopes remain — fix the DB issue and re-run before new audits.');
      process.exitCode = 1;
      return;
    }
  }

  const inputRepo = new AuditInputRepository(ctx.db);
  const factsRepo = new LeadFactsRepository(ctx.db);
  const storage = new LocalFsCaptureStorage(c.CAPTURE_ARTIFACT_DIR);

  const all = await ctx.leads.list(1000);
  let leads = all.filter((l) => l.status === 'READY_FOR_AUDIT' && (!cliOpts.lead || l.id === cliOpts.lead));
  if (cliOpts.limit) leads = leads.slice(0, Number.parseInt(cliOpts.limit, 10));
  leads = leads.slice(0, c.MAX_WEBSITE_AUDITS_PER_RUN);

  const items: AuditItem[] = [];
  let skippedNoCapture = 0;
  for (const lead of leads) {
    const source = await inputRepo.latestAuditCapture(lead.id);
    if (!source) {
      skippedNoCapture += 1;
      ctx.logger.warn({ leadId: lead.id }, 'READY_FOR_AUDIT lead has no usable AUDIT_CAPTURE run — skipped');
      continue;
    }

    const factRows = await factsRepo.listCurrentFacts(lead.id);
    const factVal = (t: string): string | null => factRows.find((f) => f.factType === t && f.isCurrent)?.value ?? null;
    const facts: PackageFacts = {
      businessName: factVal('business_name'),
      category: factVal('category'),
      city: factVal('city'),
      officialDomain: factVal('official_domain'),
    };

    // Primary viewport screenshots only, loaded from content-addressed blob storage,
    // resized to a bounded box so their max vision-token cost is deterministic, then
    // token-estimated (detail forced to the configured LLM_IMAGE_DETAIL). If any image
    // cannot be decoded/estimated, imageTokens becomes null → the paid call is blocked.
    const images: EvidenceImage[] = [];
    let imageTokens: number | null = 0;
    for (const art of source.primaryViewportArtifacts.slice(0, c.MAX_LLM_INPUT_IMAGES_PER_CALL)) {
      const blob = await storage.read(art.sha256);
      if (!blob) {
        ctx.logger.warn({ leadId: lead.id, sha256: art.sha256 }, 'screenshot blob missing — image dropped; projection will block');
        imageTokens = null;
        continue;
      }
      let resized;
      try {
        resized = await resizeForUpload(blob);
      } catch (err) {
        ctx.logger.warn({ leadId: lead.id, sha256: art.sha256, err: err instanceof Error ? err.message : String(err) }, 'screenshot resize failed — projection will block');
        imageTokens = null;
        continue;
      }
      const est = estimateImageTokens(resized.width, resized.height, c.LLM_IMAGE_DETAIL);
      if (est === null) imageTokens = null;
      else if (imageTokens !== null) imageTokens += est.tokens;
      images.push({
        id: art.id,
        sha256: art.sha256,
        profile: art.profile,
        mediaType: resized.mediaType,
        dataBase64: resized.buffer.toString('base64'),
        role: 'primary',
        widthPx: resized.width,
        heightPx: resized.height,
      });
    }

    const pkg = buildEvidencePackage({
      leadId: lead.id,
      captureRunId: source.captureRunId,
      facts,
      primaryUrl: source.primaryUrl,
      evidence: source.evidence,
      images,
      versions: {
        extractor: source.extractorVersion ?? 'unknown',
        emulation: source.emulationProfileVersion ?? 'unknown',
        pageSelection: source.pageSelectionPolicyVersion ?? 'unknown',
      },
      limits: {
        maxEvidence: c.MAX_LLM_EVIDENCE_ITEMS,
        maxSecondaryPages: c.MAX_LLM_SECONDARY_PAGES,
        maxEvidenceChars: c.MAX_LLM_EVIDENCE_CHARS,
        maxImages: c.MAX_LLM_INPUT_IMAGES_PER_CALL,
      },
    });

    const severeCaptureLimitations =
      source.outcome === 'PARTIAL_CAPTURE' || !source.desktopPrimaryComplete || !source.mobilePrimaryComplete;
    // Per-lead worst-case input tokens (actual bounded image dims + capped evidence).
    // null when any image was undeterminable → the service blocks all paid calls.
    const worstCaseInputTokensPerCall = worstCaseInputTokensForCall({ evidenceItems: pkg.evidence.length, imageTokens });
    items.push({
      input: { leadId: lead.id, captureRunId: source.captureRunId, package: pkg, severeCaptureLimitations, worstCaseInputTokensPerCall },
    });
  }

  const runs = new PipelineRunsRepository(ctx.db);
  const runId = await runs.start(`audit:${campaign.name}`, c.DRY_RUN);
  const summary = await auditWebsites({ service, logger: ctx.logger }, items, {
    runId,
    maxCallsPerRun: c.MAX_LLM_CALLS_PER_RUN,
    maxCostUsdPerRun: c.MAX_LLM_COST_USD_PER_RUN,
  });
  await runs.finish(runId, 'COMPLETED', JSON.stringify(summary));

  console.log(`\nAudit run ${runId} (${campaign.name}, provider=${providerName}):`);
  console.log(`  leads:                      ${items.length}${skippedNoCapture > 0 ? ` (+${skippedNoCapture} skipped: no capture)` : ''}`);
  console.log(`  AUDITED:                    ${summary.AUDITED}`);
  console.log(`  AUDITED_NO_ACTIONABLE:      ${summary.AUDITED_NO_ACTIONABLE_FINDINGS}`);
  console.log(`  INSUFFICIENT_EVIDENCE:      ${summary.INSUFFICIENT_EVIDENCE}`);
  console.log(`  CAPTURE_CONFLICT:           ${summary.CAPTURE_CONFLICT}`);
  console.log(`  MODEL_REFUSAL:              ${summary.MODEL_REFUSAL}`);
  console.log(`  SCHEMA_INVALID:             ${summary.SCHEMA_INVALID}`);
  console.log(`  VALIDATION_FAILED:          ${summary.VALIDATION_FAILED}`);
  console.log(`  INPUT_TOO_LARGE:            ${summary.INPUT_TOO_LARGE}`);
  console.log(`  TRANSIENT_PROVIDER_ERROR:   ${summary.TRANSIENT_PROVIDER_ERROR}`);
  console.log(`  RATE_LIMITED:               ${summary.RATE_LIMITED}`);
  console.log(`  BUDGET_BLOCKED:             ${summary.BUDGET_BLOCKED}`);
  console.log(`  MANUAL_REVIEW_REQUIRED:     ${summary.MANUAL_REVIEW_REQUIRED}`);
  console.log(`  model calls made:           ${summary.totalCalls}`);
  if (summary.skippedBudget > 0) console.log(`  skipped (run call budget):  ${summary.skippedBudget}`);
  if (summary.failed > 0) console.log(`  failed (internal):          ${summary.failed}`);
}
