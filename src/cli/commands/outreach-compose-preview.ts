import { randomUUID } from 'node:crypto';
import { buildEmailWriterMessages, type EmailBrief, EMAIL_REVIEWER_PROMPT_VERSION, EMAIL_WRITER_PROMPT_VERSION } from '../../prompts/email/index.js';
import { emailWriterSchema } from '../../domain/email/email-schema.js';
import { buildEmailContext, type EmailInputs, type EmailFinding } from '../../domain/email/email-render.js';
import { EMAIL_WRITER_JSON_SCHEMA } from '../../domain/email/email-schema.js';
import { validateEmail } from '../../domain/email/email-validation.js';
import { EMAIL_WRITER_RULES_VERSION } from '../../domain/email/email-types.js';
import {
  type EnrichmentPackage,
  type EnrichmentProspectFinding,
  planEnrichment,
} from '../../domain/email/competitor-enrichment.js';
import { composeEnrichedEmail } from '../../domain/email/competitor-email-composer.js';
import { CompetitorPatternService } from '../../domain/competitor/pattern-service.js';
import { type AuditCategory } from '../../domain/audit/audit-types.js';
import { type EvidenceCategory } from '../../domain/competitor/evidence-types.js';
import { type ConsequenceLabel, type PatternConfidence } from '../../domain/competitor/pattern-constants.js';
import { CompetitorPatternRepository } from '../../persistence/repositories/competitor-pattern.repo.js';
import { CompetitorResearchRepository } from '../../persistence/repositories/competitor-research.repo.js';
import { CompetitorEnrichmentRepository } from '../../persistence/repositories/competitor-enrichment.repo.js';
import { DemoInputRepository } from '../../persistence/repositories/demo-input.repo.js';
import { DeterministicFindingRepository } from '../../persistence/repositories/deterministic-finding.repo.js';
import { resolveComposerFindings } from '../../domain/deterministic-finding/composer-projection.js';
import { EmailInputRepository } from '../../persistence/repositories/email-input.repo.js';
import { LeadFactsRepository } from '../../persistence/repositories/lead-facts.repo.js';
import { buildEmailProvider } from './email-build.js';
import { recheckSupportingEvidence, reconstructPackage, resolvePatternInput } from './competitor-pattern-build.js';
import { type CliContext } from '../context.js';

export interface ComposePreviewOptions {
  lead?: string;
  competitorPackage?: string;
  competitorPattern?: string;
  apply?: boolean;
}

const NAME_TOKEN_MIN = 4;
function identityTokens(names: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    for (const tok of name.toLowerCase().split(/[^a-z0-9äöüß]+/i)) {
      if (tok.trim().length >= NAME_TOKEN_MIN) set.add(tok.trim());
    }
  }
  return [...set];
}

/**
 * Phase 7A3B read-only enriched-email preview (`--apply` optionally persists). Prospect-only by default;
 * with `--competitor-package <id>` it performs full composition-time revalidation, deterministic pattern
 * selection, deterministic anonymized insertion, final-body validation, and prints the complete
 * traceability. It NEVER creates a Gmail draft, sends, or touches Gmail/Sheets/the network/a live model.
 */
export async function outreachComposePreviewCommand(ctx: CliContext, opts: ComposePreviewOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const leadId = opts.lead;
  const lead = await ctx.leads.getById(leadId);
  if (!lead) {
    console.error(`Lead ${leadId} not found.`);
    process.exitCode = 1;
    return;
  }

  // Findings come from the Phase-6 AI audit when it has an outreach-safe finding; otherwise fall back
  // to an operator-approved deterministic finding. AI always takes precedence — the deterministic
  // bridge never overrides a real audit — and the resolved provenance is printed for traceability.
  const auditRepo = new DemoInputRepository(ctx.db);
  const audit = await auditRepo.latestAuditForComposer(leadId);
  const deterministicFindings = await new DeterministicFindingRepository(ctx.db).listActiveComposerFindings(leadId);
  const composerFindings = resolveComposerFindings(audit, deterministicFindings);
  if (composerFindings.source === null) {
    console.error(`No audit or deterministic finding available for lead ${leadId}; cannot compose.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  finding provenance:        ${composerFindings.source}`);
  const facts = await new LeadFactsRepository(ctx.db).listCurrentFacts(leadId);
  const demo = await new EmailInputRepository(ctx.db).latestDemo(leadId);
  const safeFindings: EmailFinding[] = composerFindings.findings.filter((f) => f.safeForOutreach);
  const emailInputs: EmailInputs = { facts, findings: safeFindings, demo };
  const validationCtx = buildEmailContext(emailInputs);

  // --- prospect-only model draft (mock by default; no live call unless the paid gate is fully open) ---
  const provider = buildEmailProvider(ctx);
  const brief = buildBrief(facts, safeFindings, validationCtx.demoLinkAllowed, demo?.approvedFindingRefs ?? [], validationCtx.language);
  const wMsgs = buildEmailWriterMessages(brief, null);
  const c = ctx.config;
  const wRes = await provider.generate({
    task: 'email_write', system: wMsgs.system, user: wMsgs.user, images: [], outputSchema: EMAIL_WRITER_JSON_SCHEMA,
    schemaName: 'email_write', model: c.EMAIL_WRITER_MODEL, reasoningEffort: c.EMAIL_WRITER_EFFORT, store: c.LLM_STORE_RESPONSES,
    timeoutMs: c.EMAIL_TIMEOUT_MS, maxOutputTokens: c.EMAIL_MAX_OUTPUT_TOKENS, maxRetries: c.EMAIL_MAX_RETRIES,
  });
  const parsed = emailWriterSchema.safeParse(wRes.rawJson);
  if (!parsed.success) {
    console.error(`Prospect draft failed schema validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const prospectDraft = parsed.data;
  const prospectCheck = validateEmail(prospectDraft, validationCtx);
  if (!prospectCheck.ok) {
    console.error(`Prospect draft failed the copy gate: ${prospectCheck.violations.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // --- prospect-only path (no package requested): unchanged fallback ---
  if (!opts.competitorPackage) {
    console.log(`\n=== Prospect-only preview (lead ${leadId}) ===`);
    console.log(`  schema: ${prospectDraft ? 'email-copy-schema-3' : ''}  competitor_evidence_used: NONE`);
    console.log(`\n  Subject: ${prospectDraft.selected_subject}`);
    console.log(`\n${renderBodyForDisplay(prospectDraft.email_body)}`);
    console.log('\n  No competitor package requested. No Gmail draft, no send.');
    return;
  }

  // --- enrichment requested: the feature flag is required (fail closed if off) ---
  if (!c.COMPETITOR_EMAIL_ENRICHMENT_ENABLED) {
    console.error('Competitor enrichment requires COMPETITOR_EMAIL_ENRICHMENT_ENABLED=true (default off). Failing closed.');
    process.exitCode = 1;
    return;
  }

  const patternRepo = new CompetitorPatternRepository(ctx.db);
  const row = await patternRepo.getPackage(opts.competitorPackage);
  if (!row) {
    console.error(`Competitor pattern package ${opts.competitorPackage} not found.`);
    process.exitCode = 1;
    return;
  }
  if (row.leadId !== leadId) {
    console.error(`Package ${row.id} belongs to lead ${row.leadId}, not ${leadId}. Failing closed.`);
    process.exitCode = 1;
    return;
  }
  if (row.status !== 'APPROVED') {
    console.error(`Package ${row.id} status is ${row.status}, not APPROVED. Failing closed.`);
    process.exitCode = 1;
    return;
  }

  // --- composition-time revalidation: recompute the package + compare hash + re-derive freshness ---
  const now = new Date();
  const resolved = await resolvePatternInput(ctx, leadId, { researchRun: row.researchRunId, captureRun: (row.captureRunIds as string[])[0] });
  if ('error' in resolved) {
    console.error(`Revalidation could not reload package inputs: ${resolved.error} Failing closed.`);
    process.exitCode = 1;
    return;
  }
  const dummyUow = { transaction: async <T>(): Promise<T> => { throw new Error('revalidation build must not persist'); } };
  const recomputed = new CompetitorPatternService({ uow: dummyUow }).build({ ...resolved.input, now });
  const hashMatched = recomputed.package.packageHash === row.packageHash;
  const reconstructed = await reconstructPackage(ctx, row.id);
  const freshnessFailures = reconstructed ? await recheckSupportingEvidence(ctx, reconstructed.pkg, now) : ['package could not be reconstructed'];
  if (!hashMatched) {
    console.error(`Revalidation FAILED: recomputed package hash ${recomputed.package.packageHash.slice(0, 12)} != stored ${row.packageHash.slice(0, 12)} (evidence changed). Failing closed.`);
    process.exitCode = 1;
    return;
  }
  if (freshnessFailures.length > 0) {
    console.error(`Revalidation FAILED: ${freshnessFailures.join('; ')}. Failing closed.`);
    process.exitCode = 1;
    return;
  }

  // --- map persisted rows onto the enrichment contract ---
  const patternRows = await patternRepo.getPatterns(row.id);
  const contrastRows = await patternRepo.getContrasts(row.id);
  const research = new CompetitorResearchRepository(ctx.db);
  const candidates = await research.getCandidates(row.researchRunId);
  const selected = new Set((row.selectedCompetitorIds as string[]) ?? []);
  const names = candidates.filter((cand) => selected.has(cand.id)).flatMap((cand) => [cand.businessName, cand.parentBrand]);

  const pkg: EnrichmentPackage = {
    packageId: row.id,
    version: row.version,
    packageHash: row.packageHash,
    status: row.status as EnrichmentPackage['status'],
    leadId: row.leadId,
    patterns: patternRows.map((p) => ({
      patternId: p.id,
      category: p.category as EvidenceCategory,
      result: p.result as EnrichmentPackage['patterns'][number]['result'],
      presentCount: p.presentCount,
      usableDenominator: p.usableDenominator,
      confidence: p.confidence as PatternConfidence,
      wordingForm: p.wordingForm as EnrichmentPackage['patterns'][number]['wordingForm'],
      wordingText: p.wordingText,
      consequenceLabel: p.consequenceLabel as ConsequenceLabel | null,
      isDepth: p.isDepth,
      evidenceItemIds: (p.evidenceItemIds as string[]) ?? [],
    })),
    contrasts: contrastRows.map((cr) => ({
      contrastId: cr.id,
      category: cr.category as EvidenceCategory,
      consequenceLabel: cr.consequenceLabel as ConsequenceLabel,
      prospectEvidenceRef: cr.prospectEvidenceRef,
      confidence: cr.confidence as PatternConfidence,
    })),
    identityTokens: identityTokens(names),
  };

  const enrichmentFindings: EnrichmentProspectFinding[] = safeFindings.map((f) => ({
    evidenceId: f.id, findingRef: f.findingRef, category: f.category as AuditCategory,
  }));

  const outcome = planEnrichment({
    leadId, language: validationCtx.language, package: pkg, safeFindings: enrichmentFindings,
    requestedPatternId: opts.competitorPattern ?? null,
  });
  if (!outcome.ok) {
    console.error(`Enrichment failed closed: ${outcome.reason}. No prospect-only fallback under an explicit package request.`);
    process.exitCode = 1;
    return;
  }

  const composed = composeEnrichedEmail({ prospectDraft, emailInputs, validationCtx, plan: outcome.plan, pkg });

  // --- print the full preview (amendment #9) ---
  const sel = outcome.plan.selection;
  console.log(`\n=== Enriched preview (lead ${leadId}) ===`);
  console.log(`  schema version:            ${composed.schemaVersion}`);
  console.log(`  competitor_evidence_used:  ${composed.artifact.competitor_evidence_used}`);
  console.log(`  package:                   ${pkg.packageId} v${String(pkg.version)}  hash ${pkg.packageHash.slice(0, 12)}`);
  console.log(`  selected pattern:          ${sel.pattern.patternId} (${sel.pattern.category})`);
  console.log(`  selected contrast:         ${sel.contrast ? `${sel.contrast.contrastId} (${sel.contrast.category})` : '(none)'}`);
  console.log(`  selection reasons:         ${sel.selectionReasons.join(' > ')}`);
  console.log(`  prospect→pattern mapping:  ${sel.alignment.auditCategory} → ${sel.alignment.evidenceCategory} (primary issue ${sel.primaryIssue.findingRef})`);
  console.log(`  evidence freshness:        ${hashMatched && freshnessFailures.length === 0 ? 'FRESH + hash re-matched' : 'STALE'}`);
  console.log(`  identity-leakage check:    ${composed.enrichedValidation.violations.some((v) => v.startsWith('competitor_identity_leak')) ? 'LEAK DETECTED' : 'clean'}`);
  console.log(`  prohibited-claim check:    ${composed.enrichedValidation.violations.some((v) => v.startsWith('prohibited_claim')) ? 'BLOCKED' : 'clean'}`);
  console.log(`  schema/copy/enriched ok:   ${String(composed.ok)}`);
  if (!composed.ok) {
    console.log(`  schema violations:   ${composed.schemaViolations.join(', ') || '(none)'}`);
    console.log(`  copy-gate violations:${composed.baseValidation.violations.join(', ') || '(none)'}`);
    console.log(`  enriched violations: ${composed.enrichedValidation.violations.join(', ') || '(none)'}`);
  }
  console.log(`  composed message hash:     ${composed.composedMessageHash.slice(0, 16)}`);

  console.log(`\n  Subject: ${composed.rendered.subject}`);
  console.log(`\n${renderBodyForDisplay(composed.rendered.body)}`);

  console.log('\n  Claim ledger:');
  composed.ledger.forEach((e, i) => {
    console.log(`   [${String(i)}] ${e.claimType}: "${truncate(e.text)}"`);
    if (e.prospectEvidenceIds.length) console.log(`        prospect evidence: ${e.prospectEvidenceIds.join(', ')}`);
    if (e.patternId) console.log(`        pattern: ${e.patternId}${e.contrastId ? `  contrast: ${e.contrastId}` : ''}`);
    if (e.competitorEvidenceIds.length) console.log(`        competitor evidence: ${e.competitorEvidenceIds.join(', ')}`);
  });

  if (!composed.ok) {
    console.error('\n  Composed artifact FAILED validation — not eligible for review/approval. Failing closed.');
    process.exitCode = 1;
    return;
  }

  if (opts.apply) {
    const emailId = randomUUID();
    await ctx.db.transaction(async (tx) => {
      await new CompetitorEnrichmentRepository(tx).persistEnrichedEmail({
        emailId, leadId, demoId: demo?.id ?? null, runId: null,
        subject: composed.rendered.subject, body: composed.rendered.body, ctaKind: composed.rendered.ctaKind,
        hasDemoUrlPlaceholder: composed.rendered.hasDemoUrlPlaceholder,
        writerPromptVersion: EMAIL_WRITER_PROMPT_VERSION, reviewerPromptVersion: EMAIL_REVIEWER_PROMPT_VERSION,
        schemaVersion: composed.schemaVersion, rulesVersion: EMAIL_WRITER_RULES_VERSION, provider: provider.name,
        requestedWriterModel: c.EMAIL_WRITER_MODEL, requestedReviewerModel: c.EMAIL_REVIEWER_MODEL,
        enrichment: {
          competitorEvidenceUsed: composed.artifact.competitor_evidence_used,
          enrichmentRulesVersion: outcome.plan.rulesVersion,
          packageId: pkg.packageId, packageVersion: pkg.version, packageHash: pkg.packageHash,
          selectedPatternId: sel.pattern.patternId, selectedContrastId: sel.contrast?.contrastId ?? null,
          primaryIssueEvidenceId: sel.primaryIssue.evidenceId, primaryIssueFindingRef: sel.primaryIssue.findingRef,
          alignmentAuditCategory: sel.alignment.auditCategory, alignmentEvidenceCategory: sel.alignment.evidenceCategory,
          revalidatedAt: now, recomputedHashMatched: hashMatched, composedMessageHash: composed.composedMessageHash,
        },
        ledger: composed.ledger,
      });
    });
    console.log(`\n  Persisted enriched email ${emailId} (status DRAFTED) + provenance + claim ledger.`);
  } else {
    console.log('\n  Dry preview only. Re-run with --apply to persist (still no Gmail draft, no send). Human review remains required.');
  }
  console.log('\n  No Gmail draft, no send, no Sheets, no network, no live model call performed.');
}

function buildBrief(
  facts: EmailInputs['facts'],
  safeFindings: EmailFinding[],
  demoLinkAllowed: boolean,
  approvedDemoFindingRefs: string[],
  language: string,
): EmailBrief {
  const currentFacts = facts.filter((fact) => fact.isCurrent && fact.value.trim() !== '');
  const val = (type: string): string | null => currentFacts.find((f) => f.factType === type)?.value.trim() ?? null;
  return {
    businessName: val('business_name'),
    contactName: val('contact_name'),
    language,
    facts: currentFacts.map((fact) => ({ evidenceId: fact.id, type: fact.factType, value: fact.value.trim() })),
    findings: safeFindings.map((f) => ({ evidenceId: f.id, findingRef: f.findingRef, category: f.category, observation: f.observation, recommendation: f.recommendation })),
    demoLinkAllowed,
    approvedDemoFindingRefs,
    competitorPackage: null,
  };
}

function renderBodyForDisplay(body: string): string {
  return body.split('\n').map((line) => `  | ${line}`).join('\n');
}

function truncate(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
