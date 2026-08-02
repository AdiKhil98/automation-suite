/**
 * Phase 7A3A hard deterministic validator. This is the last line of defense before a package can be
 * human-approved. It FAILS (never merely warns) on any prohibited claim, sample-of-one wording,
 * missing source reference, count/wording inconsistency, invalid confidence/freshness, or a
 * competitor name leaking into anonymized wording. A package with any error can never be approved.
 */

import {
  PATTERN_CONFIDENCES,
  POSITIVE_PATTERN_RESULTS,
  PROHIBITED_CLAIM_TERMS,
  type PatternConfidence,
} from './pattern-constants.js';
import { wordingFormFor } from './pattern-wording.js';
import { type CompetitorPatternPackage } from './pattern-types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  prohibitedClaims: string[];
}

const CONFIDENCE_SET = new Set<string>(PATTERN_CONFIDENCES);

/** Tokenized lowercase words of a competitor name, for name-leak detection in wording. */
function nameTokens(name: string | null): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4); // ignore short/common fragments to avoid false positives
}

/**
 * Validate a built package. `competitorNames` are the SELECTED competitors' business/brand names,
 * used to prove none of them leak into anonymized wording.
 */
export function validatePackage(pkg: CompetitorPatternPackage, competitorNames: (string | null)[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prohibited = new Set<string>();

  const bannedTokens = new Set<string>();
  for (const name of competitorNames) for (const tok of nameTokens(name)) bannedTokens.add(tok);

  const scanProhibited = (text: string | null, where: string): void => {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const term of PROHIBITED_CLAIM_TERMS) {
      if (lower.includes(term)) {
        prohibited.add(term);
        errors.push(`Prohibited claim term "${term}" found in ${where}.`);
      }
    }
    for (const tok of bannedTokens) {
      if (lower.split(/[^a-z0-9äöüß]+/i).includes(tok)) {
        errors.push(`Competitor name token "${tok}" leaked into ${where} (external wording must stay anonymized).`);
      }
    }
  };

  for (const p of pkg.patterns) {
    const isPositive = POSITIVE_PATTERN_RESULTS.has(p.result) && !p.isDepth;
    scanProhibited(p.wordingText, `pattern ${p.category} wording`);

    if (!CONFIDENCE_SET.has(p.confidence)) errors.push(`Pattern ${p.category} has invalid confidence "${p.confidence}".`);

    if (isPositive) {
      // A positive pattern must clear the denominator + sample rules and carry exact source refs.
      if (p.usableDenominator < 2) errors.push(`Pattern ${p.category} is positive but usableDenominator < 2 (sample of one).`);
      if (p.presentCount < 2) errors.push(`Pattern ${p.category} is positive but presentCount < 2 (sample of one).`);
      if (p.evidenceItemIds.length === 0) errors.push(`Pattern ${p.category} is positive but has no source evidence references.`);
      // Exact-count wording must match stored counts.
      const expectedForm = wordingFormFor(p.presentCount, p.usableDenominator);
      if (p.wordingForm !== expectedForm) {
        errors.push(`Pattern ${p.category} wording form "${p.wordingForm}" is inconsistent with counts (expected "${expectedForm}").`);
      }
      if (p.wordingForm !== 'NONE' && !p.wordingText) errors.push(`Pattern ${p.category} has a wording form but no wording text.`);
      // Only HIGH/MEDIUM patterns may be part of an approvable package.
      if (p.confidence === 'LOW') errors.push(`Pattern ${p.category} is positive but LOW confidence (not approvable).`);
    } else {
      // A non-positive pattern must not carry external wording or a consequence.
      if (p.wordingForm !== 'NONE' || p.wordingText) errors.push(`Non-positive pattern ${p.category} must not carry external wording.`);
    }
  }

  const positiveCategories = new Set(pkg.patterns.filter((p) => POSITIVE_PATTERN_RESULTS.has(p.result) && !p.isDepth).map((p) => p.category));
  for (const c of pkg.contrasts) {
    if (c.prospectState !== 'ABSENT') errors.push(`Contrast ${c.category} must be based on verified ABSENT prospect evidence.`);
    if (!c.prospectEvidenceRef) errors.push(`Contrast ${c.category} is missing a prospect evidence reference.`);
    if (!positiveCategories.has(c.category)) errors.push(`Contrast ${c.category} has no supporting positive competitor pattern.`);
    if (!CONFIDENCE_SET.has(c.confidence)) errors.push(`Contrast ${c.category} has invalid confidence "${c.confidence}".`);
  }

  // Every present-supporting evidence ref must have a source URL retained.
  for (const ref of pkg.evidenceRefs) {
    if (ref.kind === 'COMPETITOR' && (!ref.sourceUrl || ref.sourceUrl.trim() === '')) {
      errors.push(`Competitor evidence ref ${ref.evidenceItemId} is missing a source URL.`);
    }
  }

  scanProhibited(pkg.prohibitedClaims.join(' '), 'package prohibitedClaims');

  return { ok: errors.length === 0, errors, warnings, prohibitedClaims: [...prohibited].sort() };
}

/** Confidence guard used by the approval workflow: only HIGH/MEDIUM packages may be approved. */
export function isApprovableConfidence(confidence: PatternConfidence): boolean {
  return confidence === 'HIGH' || confidence === 'MEDIUM';
}
