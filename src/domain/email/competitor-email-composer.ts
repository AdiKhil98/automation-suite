/**
 * Phase 7A3B deterministic enriched-email composer (pure; NO AI, NO I/O, NO network).
 *
 * Given a VALIDATED prospect-only model draft (competitor_evidence_used = NONE) and a planned
 * enrichment, this builds the FINAL composed artifact: it inserts the deterministic competitor +
 * consequence section, flips the mode to APPROVED_COMPETITOR_PATTERN_PACKAGE, re-validates against the
 * shipped schema and the deterministic copy gate (mode-aware), runs the final-body enrichment validator,
 * builds the claim ledger, and computes the immutable composed-message hash. The FINAL artifact — never
 * the raw model output — is what callers preview, review, approve, persist, and hash.
 */

import { createHash } from 'node:crypto';
import { type EmailWriterParsed, emailWriterSchema, EMAIL_SCHEMA_VERSION } from './email-schema.js';
import { type EmailInputs, renderEmail } from './email-render.js';
import { type EmailValidationContext, type EmailValidationResult, validateEmail } from './email-validation.js';
import { type RenderedEmail } from './email-types.js';
import {
  buildClaimLedger,
  buildCompositionSections,
  type ClaimLedgerEntry,
  type CompositionSection,
  type EnrichmentPackage,
  type EnrichmentPlan,
  type EnrichedValidationResult,
  renderEnrichedBody,
  validateEnrichedComposition,
} from './competitor-enrichment.js';

export interface ComposedEnrichedEmail {
  /** FINAL artifact: schema-3 shaped, competitor_evidence_used = APPROVED_COMPETITOR_PATTERN_PACKAGE. */
  artifact: EmailWriterParsed;
  rendered: RenderedEmail;
  sections: CompositionSection[];
  ledger: ClaimLedgerEntry[];
  plan: EnrichmentPlan;
  schemaVersion: string;
  schemaOk: boolean;
  schemaViolations: string[];
  baseValidation: EmailValidationResult;
  enrichedValidation: EnrichedValidationResult;
  composedMessageHash: string;
  /** True only when every gate passed (schema + base copy gate + enriched-body validator). */
  ok: boolean;
}

/** Split the model's prospect-only body into its paragraphs (structural decomposition of its own output). */
function prospectParagraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Stable-key canonical JSON for hashing (recursively sorts object keys; arrays kept in order). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function composeEnrichedEmail(params: {
  prospectDraft: EmailWriterParsed;
  emailInputs: EmailInputs;
  validationCtx: EmailValidationContext;
  plan: EnrichmentPlan;
  pkg: EnrichmentPackage;
}): ComposedEnrichedEmail {
  const { prospectDraft, emailInputs, validationCtx, plan, pkg } = params;

  const sections = buildCompositionSections(plan, prospectParagraphs(prospectDraft.email_body));
  const enrichedBody = renderEnrichedBody(sections);

  // FINAL artifact — the mode is flipped here (never in the raw model output) and the body is the
  // enriched, section-rendered body. Everything else is inherited from the validated prospect draft.
  const artifact: EmailWriterParsed = {
    ...prospectDraft,
    competitor_evidence_used: 'APPROVED_COMPETITOR_PATTERN_PACKAGE',
    email_body: enrichedBody,
  };

  const schemaParse = emailWriterSchema.safeParse(artifact);
  const schemaOk = schemaParse.success;
  const schemaViolations = schemaParse.success
    ? []
    : schemaParse.error.issues.slice(0, 12).map((i) => `schema_invalid:${i.path.join('.') || '(root)'}`);

  const rendered = renderEmail(artifact, emailInputs);
  const baseValidation = validateEmail(artifact, validationCtx);

  const ledger = buildClaimLedger(plan, sections, pkg);
  ledger.push({
    claimType: 'CTA',
    text: `cta:${artifact.primary_cta}`,
    prospectEvidenceIds: [],
    patternId: null,
    contrastId: null,
    competitorEvidenceIds: [],
    externallySafe: true,
  });

  const enrichedValidation = validateEnrichedComposition(rendered.body, plan, pkg, ledger);

  const composedMessageHash = createHash('sha256')
    .update(
      canonical({
        schemaVersion: EMAIL_SCHEMA_VERSION,
        mode: artifact.competitor_evidence_used,
        subject: rendered.subject,
        body: rendered.body,
        packageId: pkg.packageId,
        packageVersion: pkg.version,
        packageHash: pkg.packageHash,
        selectedPatternId: plan.selection.pattern.patternId,
        selectedContrastId: plan.selection.contrast?.contrastId ?? null,
        rulesVersion: plan.rulesVersion,
        ledger: ledger.map((e) => ({
          claimType: e.claimType,
          text: e.text,
          prospectEvidenceIds: e.prospectEvidenceIds,
          patternId: e.patternId,
          contrastId: e.contrastId,
          competitorEvidenceIds: e.competitorEvidenceIds,
        })),
      }),
    )
    .digest('hex');

  return {
    artifact,
    rendered,
    sections,
    ledger,
    plan,
    schemaVersion: EMAIL_SCHEMA_VERSION,
    schemaOk,
    schemaViolations,
    baseValidation,
    enrichedValidation,
    composedMessageHash,
    ok: schemaOk && baseValidation.ok && enrichedValidation.ok,
  };
}
