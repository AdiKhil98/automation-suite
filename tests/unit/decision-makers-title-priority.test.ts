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

  it('tier 4 is accepted from a team/about page on the lead\'s own domain without repeating the practice name', () => {
    // Real roster shape: "Mena Williams — Managing Director" is rendered as a title card, with the
    // practice name in the page header rather than in the card, so requiring the name in the same
    // snippet rejected a correctly identified decision-maker on a page we fetched from the lead's site.
    const snippet = 'Mena Williams Managing Director VIEW PROFILE';
    expect(classifyTitlePriority('Managing Director', snippet, 'Dulwich Orthodontics', { role: 'team', officialDomain: true })).toBe(4);
    expect(classifyTitlePriority('Director', snippet, 'Dulwich Orthodontics', { role: 'about', officialDomain: true })).toBe(4);
  });

  it('tier 4 provenance relief does NOT extend to weaker pages or unverified domains', () => {
    const snippet = 'Mena Williams Managing Director VIEW PROFILE';
    expect(classifyTitlePriority('Managing Director', snippet, 'Dulwich Orthodontics', { role: 'home', officialDomain: true })).toBeNull();
    expect(classifyTitlePriority('Managing Director', snippet, 'Dulwich Orthodontics', { role: 'contact', officialDomain: true })).toBeNull();
    expect(classifyTitlePriority('Managing Director', snippet, 'Dulwich Orthodontics', { role: 'team', officialDomain: false })).toBeNull();
  });

  it('corporate-group wording re-imposes the practice-name requirement on the ambiguous Director tier', () => {
    const corporate = 'Jane Roe, Regional Director, Colosseum Dental Group holdings.';
    expect(classifyTitlePriority('Director', corporate, 'Norwood Dental Clinic', { role: 'team', officialDomain: true })).toBeNull();
    // ...unless the practice itself is named in the same evidence.
    const named = 'Jane Roe is Managing Director of Norwood Dental Clinic, part of a larger group.';
    expect(classifyTitlePriority('Managing Director', named, 'Norwood Dental Clinic', { role: 'team', officialDomain: true })).toBe(4);
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
