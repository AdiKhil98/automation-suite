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
  type ClaimSpan,
  type CompositionSection,
  deriveClaimSpans,
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
  /** Bounded start/end offsets for every substantive claim, derived from the final rendered body. */
  claimSpans: ClaimSpan[];
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

/** Stable-key canonical JSON for hashing (recursively sorts object keys; arrays kept in caller order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Normalize line endings to '\n' so CRLF / lone-CR drift never changes the semantic message hash. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** One ledger claim, reduced to the provenance fields that bind into the composed-message hash. */
export interface ComposedHashLedgerEntry {
  claimType: string;
  text: string;
  prospectEvidenceIds: string[];
  patternId: string | null;
  contrastId: string | null;
  competitorEvidenceIds: string[];
}

/** The complete, provenance-critical input to the canonical composed-message hash. */
export interface ComposedMessageHashInput {
  schemaVersion: string;
  mode: string;
  subject: string;
  body: string;
  packageId: string;
  packageVersion: number;
  packageHash: string;
  selectedPatternId: string;
  selectedContrastId: string | null;
  rulesVersion: string;
  ledger: ComposedHashLedgerEntry[];
}

/**
 * THE canonical composed-message hash contract — the single source of truth reused by the composer, the
 * hard-gate reproducibility check, and the offline replay (so the three can never drift).
 *
 * It binds every SEMANTIC + PROVENANCE-CRITICAL field of the FINAL email: schema version, subject, rendered
 * body, competitor-evidence mode, package id/version/hash, selected pattern + contrast ids, the enrichment
 * rules version, and the normalized claim ledger (each claim's text + its prospect/competitor evidence
 * references + pattern/contrast ids). It EXCLUDES purely ephemeral execution metadata — provider request/
 * response ids, token usage, cost, latency, and report-generation timestamps — none of which are inputs
 * here, so the same semantic artifact always hashes identically across runs.
 *
 * Determinism guarantees: object keys are canonically sorted, evidence-reference arrays are sorted (so
 * equivalent references in any upstream order hash the same), newlines are normalized, and JSON.stringify
 * gives UTF-8-stable encoding with explicit null handling. These normalizations are no-ops on already-
 * canonical input, so the contract is stable, not a value change for well-formed artifacts.
 */
export function computeComposedMessageHash(input: ComposedMessageHashInput): string {
  const canonical = {
    schemaVersion: input.schemaVersion,
    mode: input.mode,
    subject: normalizeNewlines(input.subject),
    body: normalizeNewlines(input.body),
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    packageHash: input.packageHash,
    selectedPatternId: input.selectedPatternId,
    selectedContrastId: input.selectedContrastId,
    rulesVersion: input.rulesVersion,
    ledger: input.ledger.map((e) => ({
      claimType: e.claimType,
      text: normalizeNewlines(e.text),
      prospectEvidenceIds: [...e.prospectEvidenceIds].sort(),
      patternId: e.patternId,
      contrastId: e.contrastId,
      competitorEvidenceIds: [...e.competitorEvidenceIds].sort(),
    })),
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
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

  const composedMessageHash = computeComposedMessageHash({
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
  });

  // Bounded, body-derived claim spans (verified traceability; deterministic, duplicate-safe).
  const claimSpans = deriveClaimSpans(rendered.body, ledger);

  return {
    artifact,
    rendered,
    sections,
    ledger,
    claimSpans,
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
