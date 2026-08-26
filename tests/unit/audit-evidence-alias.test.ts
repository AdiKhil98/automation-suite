import { describe, expect, it } from 'vitest';
import { type AuditGeneratorOutputParsed } from '../../src/domain/audit/audit-schema.js';
import {
  aliasForEvidenceId,
  allowedEvidenceAliases,
  evidenceAliasFor,
  resolveEvidenceAlias,
  translateGeneratorAliases,
} from '../../src/domain/audit/evidence-alias.js';
import { validateGeneratorOutput } from '../../src/domain/audit/validation.js';
import { buildGeneratorMessages } from '../../src/prompts/website-audit/index.js';
import { PRIMARY_URL, evidenceRef, testPackage } from './helpers/audit-fixtures.js';

// A package whose evidence carries opaque UUID-shaped ids (the real-world failure case).
const pkg = testPackage([
  evidenceRef({ id: 'c56754a6-157d-4d1e-837b-af8dab72521b', evidenceType: 'cta' }),
  evidenceRef({ id: '9bfd46cd-071a-46f1-ac02-78a7651b46d7', evidenceType: 'tel' }),
  evidenceRef({ id: '42864b95-07eb-47f6-a084-6d41bdbff5c3', evidenceType: 'nav_label' }),
]);

function output(evidenceIds: string[]): AuditGeneratorOutputParsed {
  return {
    summary: 'A short factual summary.',
    findings: [{
      findingRef: 'F1', category: 'CTA_CLARITY', observation: 'The main action may be hard to notice.',
      evidenceIds, affectedUrls: [PRIMARY_URL], affectedProfiles: ['DESKTOP'], severity: 'MEDIUM', confidence: 0.8,
      businessImpact: 'May create friction for interested visitors.', recommendation: 'Make it more prominent.',
      safeForOutreach: true, outreachAngle: null, uncertainty: null,
    }],
    insufficientEvidenceAreas: [], conflictingEvidence: [], captureLimitations: [],
  } as AuditGeneratorOutputParsed;
}

describe('evidence alias resolution', () => {
  it('resolves positional tags to the real evidence id', () => {
    expect(resolveEvidenceAlias('E1', pkg)).toBe('c56754a6-157d-4d1e-837b-af8dab72521b');
    expect(resolveEvidenceAlias('E3', pkg)).toBe('42864b95-07eb-47f6-a084-6d41bdbff5c3');
    expect(resolveEvidenceAlias(' E2 ', pkg)).toBe('9bfd46cd-071a-46f1-ac02-78a7651b46d7');
  });

  it('returns undefined for out-of-range, non-tag, or image tags (never invents an id)', () => {
    expect(resolveEvidenceAlias('E4', pkg)).toBeUndefined();
    expect(resolveEvidenceAlias('E0', pkg)).toBeUndefined();
    expect(resolveEvidenceAlias('IMG1', pkg)).toBeUndefined();
    expect(resolveEvidenceAlias('c56754a6-157d-4d1e-837b-af8dab72521b', pkg)).toBeUndefined();
  });

  it('maps real ids back to their tag and lists the allowed tags', () => {
    expect(aliasForEvidenceId('9bfd46cd-071a-46f1-ac02-78a7651b46d7', pkg)).toBe('E2');
    expect(aliasForEvidenceId('not-in-package', pkg)).toBeUndefined();
    expect(allowedEvidenceAliases(pkg)).toEqual(['E1', 'E2', 'E3']);
  });

  it('translates known tags to real ids and passes unknown tokens through unchanged', () => {
    const t = translateGeneratorAliases(output(['E1', 'E3', 'E99', 'made-up-uuid']), pkg);
    expect(t.findings[0]?.evidenceIds).toEqual([
      'c56754a6-157d-4d1e-837b-af8dab72521b',
      '42864b95-07eb-47f6-a084-6d41bdbff5c3',
      'E99',
      'made-up-uuid',
    ]);
  });
});

describe('translate + validate regression (anti-hallucination preserved)', () => {
  it('valid supplied tags pass after translation', () => {
    const t = translateGeneratorAliases(output(['E1', 'E2']), pkg);
    expect(validateGeneratorOutput(t, pkg).ok).toBe(true);
  });

  it('out-of-package tag still fails closed', () => {
    const t = translateGeneratorAliases(output(['E99']), pkg);
    const r = validateGeneratorOutput(t, pkg);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.startsWith('evidence_outside_package'))).toBe(true);
  });

  it('a hallucinated UUID (never shown to the model) still fails closed', () => {
    const t = translateGeneratorAliases(output(['e49005a1-edd5-42a7-8722-312cb59fc027']), pkg);
    expect(validateGeneratorOutput(t, pkg).ok).toBe(false);
  });

  it('a citation mixing one valid tag and one bad tag fails closed on the bad one only', () => {
    const t = translateGeneratorAliases(output(['E1', 'E99']), pkg);
    const r = validateGeneratorOutput(t, pkg);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('evidence_outside_package:F1:E99');
    expect(r.violations.some((v) => v.includes('c56754a6'))).toBe(false); // valid tag resolved, not flagged
  });
});

describe('prompt/package stay synchronized', () => {
  it('shows short tags (not UUIDs), and every shown tag resolves back to its evidence id', () => {
    const { user } = buildGeneratorMessages(pkg, null);
    // Tags are shown; opaque UUIDs are not.
    expect(user).toContain('[E1]');
    expect(user).toContain('[E3]');
    expect(user).not.toContain('c56754a6-157d-4d1e-837b-af8dab72521b');
    // Each tag shown for evidence[i] resolves back to evidence[i].id — prompt and validator agree.
    pkg.evidence.forEach((e, i) => {
      const tag = evidenceAliasFor(i);
      expect(user).toContain(`[${tag}]`);
      expect(resolveEvidenceAlias(tag, pkg)).toBe(e.id);
    });
  });
});
