import { type AuditGeneratorOutputParsed } from './audit-schema.js';
import { type EvidencePackage } from './evidence-package.js';

/**
 * Short, positional, model-facing aliases for evidence and screenshots.
 *
 * The audit generator cannot reliably reproduce opaque 36-char capture-evidence UUIDs verbatim, so
 * it confabulates new ones and every finding fails `evidence_outside_package`. We show the model
 * short stable tags (`E1`, `E2`, … / `IMG1`, …) it CAN echo, then resolve those tags back to the
 * real evidence IDs deterministically before validation. The alias is purely positional over the
 * package's own `evidence` array, so prompt and validator stay in lockstep with zero extra state.
 *
 * Safety: resolution NEVER invents an ID and NEVER maps an unknown/out-of-range tag onto a real one.
 * An unknown tag is passed through unchanged, so `validateGeneratorOutput` still fails it closed
 * (`evidence_outside_package`). The anti-hallucination guarantee is unchanged.
 */

const EVIDENCE_ALIAS_RE = /^E(\d+)$/;

export function evidenceAliasFor(index: number): string {
  return `E${String(index + 1)}`;
}

export function imageAliasFor(index: number): string {
  return `IMG${String(index + 1)}`;
}

/** Resolve a model-supplied tag (e.g. "E3") to the real evidence ID, or undefined if not a valid tag. */
export function resolveEvidenceAlias(tag: string, pkg: EvidencePackage): string | undefined {
  const m = EVIDENCE_ALIAS_RE.exec(tag.trim());
  if (!m) return undefined;
  const idx = Number(m[1]) - 1;
  return idx >= 0 && idx < pkg.evidence.length ? pkg.evidence[idx]?.id : undefined;
}

/** The alias for a real evidence ID within this package, or undefined if the ID is not in it. */
export function aliasForEvidenceId(id: string, pkg: EvidencePackage): string | undefined {
  const idx = pkg.evidence.findIndex((e) => e.id === id);
  return idx >= 0 ? evidenceAliasFor(idx) : undefined;
}

/** The exact, ordered set of evidence tags the model is allowed to cite for this package. */
export function allowedEvidenceAliases(pkg: EvidencePackage): string[] {
  return pkg.evidence.map((_e, i) => evidenceAliasFor(i));
}

/**
 * Translate a generator output's citations from model-facing aliases to real evidence IDs. Known
 * aliases are resolved; anything else (a hallucinated tag or a raw UUID the model was never shown)
 * is passed through UNCHANGED so downstream validation rejects it. Pure; never mutates the input.
 */
export function translateGeneratorAliases(
  output: AuditGeneratorOutputParsed,
  pkg: EvidencePackage,
): AuditGeneratorOutputParsed {
  return {
    ...output,
    findings: output.findings.map((f) => ({
      ...f,
      evidenceIds: f.evidenceIds.map((tag) => resolveEvidenceAlias(tag, pkg) ?? tag),
    })),
  };
}
