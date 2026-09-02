import { describe, expect, it } from 'vitest';
import { buildCandidatePerson } from '../../src/domain/contact-enrichment/candidate-parsing.js';

describe('buildCandidatePerson', () => {
  it('splits first/last name and strips honorifics', () => {
    expect(buildCandidatePerson('Dr. Shyam Shastri', 'Principal Dentist', 1)).toEqual({
      fullName: 'Dr. Shyam Shastri', firstName: 'Shyam', lastName: 'Shastri', title: 'Principal Dentist', priority: 1,
    });
  });

  it('throws BAD_CANDIDATE on an empty name or title', () => {
    expect(() => buildCandidatePerson('', 'Title', 1)).toThrow(/BAD_CANDIDATE|non-empty/);
    expect(() => buildCandidatePerson('Name', '', 1)).toThrow(/BAD_CANDIDATE|non-empty/);
  });

  it('throws BAD_CANDIDATE when no last name can be derived', () => {
    expect(() => buildCandidatePerson('Cher', 'Owner', 1)).toThrow(/Cannot derive a last name/);
    expect(() => buildCandidatePerson('Dr.', 'Owner', 1)).toThrow(/Cannot derive a last name/);
  });

  it('preserves the given priority', () => {
    expect(buildCandidatePerson('Shaimil Patel', 'Clinical Director', 7).priority).toBe(7);
  });
});
