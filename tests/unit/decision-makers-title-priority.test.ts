import { describe, expect, it } from 'vitest';
import { classifyTitlePriority, classifyValidatedTitlePriority } from '../../src/domain/decision-makers/title-priority.js';

const SNIPPET = 'Dr. Shyam Shastri is our Principal Dentist at Diamond Smile.';

describe('classifyTitlePriority', () => {
  it('tier 1: ownership titles', () => {
    for (const title of ['Owner', 'Co-Owner', 'Co Owner', 'Joint Owner', 'Practice Owner', 'Proprietor', 'Founder', 'Co-Founder', 'Cofounder']) {
      expect(classifyTitlePriority(title, SNIPPET, null), title).toBe(1);
    }
  });

  it('tier 1: the whole partner family', () => {
    for (const title of ['Partner', 'Managing Partner', 'Equity Partner', 'Dental Partner', 'Practice Partner', 'Partner Dentist', 'Partner & Dentist', 'Partner / Principal Dentist']) {
      expect(classifyTitlePriority(title, SNIPPET, null), title).toBe(1);
    }
  });

  it('tier 1: principal, with or without "Dentist"', () => {
    expect(classifyTitlePriority('Principal', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Principal Dentist', SNIPPET, null)).toBe(1);
  });

  it('tier 2: clinical leadership needs no employer gate', () => {
    expect(classifyTitlePriority('Clinical Director', SNIPPET, null)).toBe(2);
    expect(classifyTitlePriority('Dental Director', SNIPPET, null)).toBe(2);
  });

  it('tier 2: Managing Director / Director once the employer is established', () => {
    const named = 'John Doe is Managing Director of Diamond Smile Dental.';
    expect(classifyTitlePriority('Managing Director', named, 'Diamond Smile')).toBe(2);
    expect(classifyTitlePriority('Director', named, 'Diamond Smile')).toBe(2);

    // Real roster shape: a title card carries no practice name, so team/about provenance stands in.
    const card = 'Mena Williams Managing Director VIEW PROFILE';
    expect(classifyTitlePriority('Managing Director', card, 'Dulwich Orthodontics', { role: 'team', officialDomain: true })).toBe(2);
    expect(classifyTitlePriority('Director', card, 'Dulwich Orthodontics', { role: 'about', officialDomain: true })).toBe(2);
  });

  it('tier 3: operational management', () => {
    expect(classifyTitlePriority('Practice Manager', SNIPPET, null)).toBe(3);
    expect(classifyTitlePriority('Business Manager', SNIPPET, null)).toBe(3);
    expect(classifyTitlePriority('Operations Manager', SNIPPET, null)).toBe(3);
  });

  it('a validated Managing Director outranks a Practice Manager (the Dulwich inversion)', () => {
    const card = 'Mena Williams Managing Director VIEW PROFILE';
    const md = classifyTitlePriority('Managing Director', card, 'Dulwich Orthodontics', { role: 'team', officialDomain: true });
    const pm = classifyTitlePriority('Practice Manager', 'Michelle Ketchen Practice Manager', 'Dulwich Orthodontics', { role: 'team', officialDomain: true });
    expect(md).toBe(2);
    expect(pm).toBe(3);
    expect(md).toBeLessThan(pm as number); // lower tier number sorts first in service.ts
  });

  // --- employer gate, preserved exactly ---------------------------------------------------------

  it('the ambiguous Director family is still rejected without employer evidence', () => {
    expect(classifyTitlePriority('Managing Director', 'John Doe is Managing Director.', null)).toBeNull();
    expect(classifyTitlePriority('Managing Director', 'John Doe is Managing Director of a completely different company.', 'Diamond Smile')).toBeNull();
  });

  it('provenance relief does NOT extend to weaker pages or unverified domains', () => {
    const card = 'Mena Williams Managing Director VIEW PROFILE';
    expect(classifyTitlePriority('Managing Director', card, 'Dulwich Orthodontics', { role: 'home', officialDomain: true })).toBeNull();
    expect(classifyTitlePriority('Managing Director', card, 'Dulwich Orthodontics', { role: 'contact', officialDomain: true })).toBeNull();
    expect(classifyTitlePriority('Managing Director', card, 'Dulwich Orthodontics', { role: 'team', officialDomain: false })).toBeNull();
  });

  it('corporate-group wording re-imposes the practice-name requirement on the Director family', () => {
    const corporate = 'Jane Roe, Regional Director, Colosseum Dental Group holdings.';
    expect(classifyTitlePriority('Director', corporate, 'Norwood Dental Clinic', { role: 'team', officialDomain: true })).toBeNull();
    const named = 'Jane Roe is Managing Director of Norwood Dental Clinic, part of a larger group.';
    expect(classifyTitlePriority('Managing Director', named, 'Norwood Dental Clinic', { role: 'team', officialDomain: true })).toBe(2);
  });

  it('a failed Director gate falls through to a lower qualifying role instead of discarding the person', () => {
    // "Managing Director & Practice Manager" on an unverifiable page is still a Practice Manager.
    expect(classifyTitlePriority('Managing Director & Practice Manager', 'Someone at another company.', null)).toBe(3);
  });

  // --- exclusions --------------------------------------------------------------------------------

  it('ordinary staff and unrelated roles are excluded entirely', () => {
    for (const title of ['Associate Dentist', 'Dentist', 'Hygienist', 'Dental Hygienist', 'Receptionist', 'Marketing Manager', 'Area Manager', 'Dental Nurse', 'Office Administrator', 'Treatment Coordinator']) {
      expect(classifyTitlePriority(title, SNIPPET, 'Diamond Smile'), title).toBeNull();
    }
  });

  it('avoids substring false positives', () => {
    // "Partnerships Manager" must not match the partner family; "Marketing Manager" must not match tier 3.
    expect(classifyTitlePriority('Partnerships Manager', SNIPPET, null)).toBeNull();
    expect(classifyTitlePriority('Marketing Manager', SNIPPET, null)).toBeNull();
  });

  it('rejects an empty title', () => {
    expect(classifyTitlePriority('', SNIPPET, null)).toBeNull();
    expect(classifyTitlePriority('   ', SNIPPET, null)).toBeNull();
  });

  it('first-match determinism: the strongest role in a combined title wins', () => {
    expect(classifyTitlePriority('Principal Dentist and Clinical Director', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Owner & Practice Manager', SNIPPET, null)).toBe(1);
    expect(classifyTitlePriority('Clinical Director & Practice Manager', SNIPPET, null)).toBe(2);
  });
});

describe('classifyValidatedTitlePriority (offline re-tiering of stored candidates)', () => {
  it('re-tiers on the title alone, with the employer gate already satisfied by the original acceptance', () => {
    expect(classifyValidatedTitlePriority('Managing Director')).toBe(2);
    expect(classifyValidatedTitlePriority('Practice Manager')).toBe(3);
    expect(classifyValidatedTitlePriority('Owner')).toBe(1);
    expect(classifyValidatedTitlePriority('Partner')).toBe(1);
  });

  it('still excludes titles that qualify for nothing', () => {
    expect(classifyValidatedTitlePriority('Dentist')).toBeNull();
    expect(classifyValidatedTitlePriority('')).toBeNull();
  });
});
