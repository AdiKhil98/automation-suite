import { describe, expect, it } from 'vitest';
import { supportingEvidenceFailure } from '../../../src/domain/competitor/pattern-eligibility.js';

const NOW = new Date('2026-02-01T00:00:00.000Z');
const FRESH_AT = new Date('2026-01-20T00:00:00.000Z'); // 12 days old → FRESH
const STALE_AT = new Date('2025-12-01T00:00:00.000Z'); // > 30 days old → STALE
const MAX_AGE = 30;

const base = { evidenceItemId: 'e1', active: true, safeForOutreach: true, capturedAt: FRESH_AT, captureActive: true };

describe('approval-time supporting-evidence re-evaluation', () => {
  it('passes when the item is still active, safe, on an active capture, and FRESH', () => {
    expect(supportingEvidenceFailure(base, NOW, MAX_AGE)).toBeNull();
  });

  it('BLOCKS when evidence was FRESH at generation but is STALE at approval', () => {
    expect(supportingEvidenceFailure({ ...base, capturedAt: STALE_AT }, NOW, MAX_AGE)).toMatch(/stale/);
  });

  it('BLOCKS when evidence was invalidated (inactive) after generation', () => {
    expect(supportingEvidenceFailure({ ...base, active: false }, NOW, MAX_AGE)).toMatch(/invalidated/);
  });

  it('BLOCKS when the owning capture run was superseded after generation', () => {
    expect(supportingEvidenceFailure({ ...base, captureActive: false }, NOW, MAX_AGE)).toMatch(/superseded/);
  });

  it('BLOCKS when the evidence became unsafe-for-outreach after generation', () => {
    expect(supportingEvidenceFailure({ ...base, safeForOutreach: false }, NOW, MAX_AGE)).toMatch(/safe-for-outreach/);
  });
});
