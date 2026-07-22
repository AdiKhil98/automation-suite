import { describe, expect, it } from 'vitest';
import { selectQualifiableLeads } from '../../src/cli/commands/qualify-leads.js';

describe('qualification CLI targeting', () => {
  const leads = [
    { id: 'older-review', status: 'NEEDS_MANUAL_REVIEW' as const },
    { id: 'selected', status: 'READY_FOR_QUALIFICATION' as const },
    { id: 'not-ready', status: 'READY_FOR_ENRICHMENT' as const },
  ];

  it('selects the exact requested lead regardless of list order or limit', () => {
    expect(selectQualifiableLeads(leads, { lead: 'selected', limit: '1' }))
      .toEqual([{ id: 'selected', status: 'READY_FOR_QUALIFICATION' }]);
  });

  it('fails closed when the requested lead is missing or not qualifiable', () => {
    expect(() => selectQualifiableLeads(leads, { lead: 'missing' }))
      .toThrow('qualification_lead_not_found');
    expect(() => selectQualifiableLeads(leads, { lead: 'not-ready' }))
      .toThrow('qualification_lead_not_qualifiable:READY_FOR_ENRICHMENT');
  });

  it('preserves the existing ordered batch behavior when no lead is requested', () => {
    expect(selectQualifiableLeads(leads, { limit: '1' }))
      .toEqual([{ id: 'older-review', status: 'NEEDS_MANUAL_REVIEW' }]);
  });
});
