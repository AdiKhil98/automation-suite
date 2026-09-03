import { describe, expect, it } from 'vitest';
import { classifyTitlePriority } from '../../src/domain/decision-makers/title-priority.js';

const SNIPPET = 'Dr. Shyam Shastri is our Principal Dentist at Diamond Smile.';

describe('classifyTitlePriority', () => {
  it('tier 1: Owner / Founder / Principal Dentist', () => {
    expect(classifyTitlePriority('Principal Dentist', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Owner', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Founder', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Co-Founder', SNIPPET, null)).toBe(1);
  });

  it('tier 2: Clinical Director / Dental Director', () => {
    expect(classifyTitlePriority('Clinical Director', SNIPPET, null)).toBe(2);
    expect(classifyTitlePriority('Dental Director', SNIPPET, null)).toBe(2);
  });

  it('tier 3: Practice Manager', () => {
    expect(classifyTitlePriority('Practice Manager', SNIPPET, null)).toBe(3);
  });

  it('tier 4: Managing Director / Director, ONLY when the practice name co-occurs in the evidence', () => {
    const snippet = 'John Doe is Managing Director of Diamond Smile Dental.';
    expect(classifyTitlePriority('Managing Director', snippet, 'Diamond Smile')).toBe(4);
    expect(classifyTitlePriority('Director', snippet, 'Diamond Smile')).toBe(4);
  });

  it('tier 4 is rejected when the practice name is absent or not co-mentioned', () => {
    expect(classifyTitlePriority('Managing Director', 'John Doe is Managing Director.', null)).toBeNull();
    expect(classifyTitlePriority('Managing Director', 'John Doe is Managing Director of a completely different company.', 'Diamond Smile')).toBeNull();
  });

  it('ordinary staff and unrelated roles are excluded entirely', () => {
    for (const title of ['Associate Dentist', 'Dentist', 'Hygienist', 'Receptionist', 'Marketing Manager', 'Dental Nurse', 'Office Administrator']) {
      expect(classifyTitlePriority(title, SNIPPET, 'Diamond Smile')).toBeNull();
    }
  });

  it('rejects an empty title', () => {
    expect(classifyTitlePriority('', SNIPPET, null)).toBeNull();
    expect(classifyTitlePriority('   ', SNIPPET, null)).toBeNull();
  });

  it('tier ordering: a higher tier is chosen over a lower one when both patterns could match', () => {
    // "Clinical Director" contains neither "principal" nor a bare "director" collision issue, but
    // confirm the precedence check order itself: tier 1 short-circuits before tier 2-4 are ever tested.
    expect(classifyTitlePriority('Principal Dentist and Clinical Director', SNIPPET, null)).toBe(1);
  });
});
