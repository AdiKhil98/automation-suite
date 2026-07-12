import { describe, expect, it } from 'vitest';
import { type DedupCandidate, type DedupInput, decideMatch } from '../../src/domain/leads/dedup.js';

const NEAR = { nearMeters: 40 };

function input(over: Partial<DedupInput>): DedupInput {
  return {
    normalizedName: null,
    normalizedDomain: null,
    normalizedPhone: null,
    normalizedAddress: null,
    latitude: null,
    longitude: null,
    city: null,
    ...over,
  };
}

function candidate(leadId: string, over: Partial<DedupInput>): DedupCandidate {
  return { leadId, ...input(over) };
}

describe('decideMatch', () => {
  it('same domain + same address => DUPLICATE(DOMAIN_ADDRESS)', () => {
    const d = decideMatch(
      input({ normalizedDomain: 'acme.example', normalizedAddress: '1 main st' }),
      [candidate('L1', { normalizedDomain: 'acme.example', normalizedAddress: '1 main st' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'DUPLICATE', tier: 'DOMAIN_ADDRESS', leadId: 'L1' });
  });

  it('same domain + DIFFERENT address => BRANCH (not merged)', () => {
    const d = decideMatch(
      input({ normalizedDomain: 'acme.example', normalizedAddress: '2 other rd' }),
      [candidate('L1', { normalizedDomain: 'acme.example', normalizedAddress: '1 main st' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'BRANCH', relatedLeadId: 'L1' });
  });

  it('same phone + near coordinates => DUPLICATE(PHONE_ADDRESS)', () => {
    const d = decideMatch(
      input({ normalizedPhone: '1614960000', latitude: 53.4739, longitude: -2.2352 }),
      [candidate('L2', { normalizedPhone: '1614960000', latitude: 53.47391, longitude: -2.23521 })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'DUPLICATE', tier: 'PHONE_ADDRESS', leadId: 'L2' });
  });

  it('same phone + far coordinates => BRANCH', () => {
    const d = decideMatch(
      input({ normalizedPhone: '1614960000', latitude: 53.5, longitude: -2.3 }),
      [candidate('L2', { normalizedPhone: '1614960000', latitude: 53.4739, longitude: -2.2352 })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'BRANCH', relatedLeadId: 'L2' });
  });

  it('same name + near address => DUPLICATE(NAME_ADDRESS)', () => {
    const d = decideMatch(
      input({ normalizedName: 'acme dental', normalizedAddress: '1 main st' }),
      [candidate('L3', { normalizedName: 'acme dental', normalizedAddress: '1 main st' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'DUPLICATE', tier: 'NAME_ADDRESS', leadId: 'L3' });
  });

  it('similar but not identical names => not merged (UNIQUE)', () => {
    const d = decideMatch(
      input({ normalizedName: 'acme dental care', city: 'Manchester' }),
      [candidate('L3', { normalizedName: 'acme dental', city: 'Manchester' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'UNIQUE' });
  });

  it('same name + same city, no stronger evidence => AMBIGUOUS', () => {
    const d = decideMatch(
      input({ normalizedName: 'acme dental', city: 'Manchester' }),
      [candidate('L3', { normalizedName: 'acme dental', city: 'manchester' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'AMBIGUOUS', candidateLeadId: 'L3' });
  });

  it('separate branches: same name, different address => SEPARATE (UNIQUE)', () => {
    const d = decideMatch(
      input({ normalizedName: 'acme dental', normalizedAddress: '9 far away', city: 'Leeds' }),
      [candidate('L3', { normalizedName: 'acme dental', normalizedAddress: '1 main st', city: 'Manchester' })],
      NEAR,
    );
    expect(d).toEqual({ kind: 'UNIQUE' });
  });

  it('no candidates => UNIQUE', () => {
    expect(decideMatch(input({ normalizedName: 'x' }), [], NEAR)).toEqual({ kind: 'UNIQUE' });
  });

  it('near-address threshold boundary', () => {
    // ~111 m apart: within a 200 m threshold => duplicate; outside 40 m => not.
    const a = input({ normalizedDomain: 'acme.example', latitude: 53.4739, longitude: -2.2352 });
    const c = [candidate('L1', { normalizedDomain: 'acme.example', latitude: 53.4749, longitude: -2.2352 })];
    expect(decideMatch(a, c, { nearMeters: 200 })).toEqual({
      kind: 'DUPLICATE',
      tier: 'DOMAIN_ADDRESS',
      leadId: 'L1',
    });
    expect(decideMatch(a, c, { nearMeters: 40 })).toEqual({ kind: 'BRANCH', relatedLeadId: 'L1' });
  });
});
