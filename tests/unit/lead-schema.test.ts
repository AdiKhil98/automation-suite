import { describe, expect, it } from 'vitest';
import { leadSchema, newLeadSchema } from '../../src/domain/leads/lead.js';
import { evidenceSchema } from '../../src/domain/evidence/evidence.js';

describe('lead schemas', () => {
  it('newLeadSchema fills nullable defaults from a minimal input', () => {
    const parsed = newLeadSchema.parse({ businessName: 'Acme Dental' });
    expect(parsed.businessName).toBe('Acme Dental');
    expect(parsed.domain).toBeNull();
    expect(parsed.priority).toBeNull();
  });

  it('newLeadSchema rejects an empty business name', () => {
    expect(() => newLeadSchema.parse({ businessName: '' })).toThrow();
  });

  it('leadSchema accepts a fully-formed lead', () => {
    const now = new Date();
    const lead = leadSchema.parse({
      id: 'abc',
      businessName: 'Acme Dental',
      normalizedName: 'acme dental',
      domain: null,
      normalizedDomain: null,
      phone: null,
      normalizedPhone: null,
      formattedAddress: null,
      normalizedAddress: null,
      latitude: null,
      longitude: null,
      placeId: null,
      city: 'Manchester',
      country: 'GB',
      status: 'NEW',
      priority: null,
      source: 'fixture',
      factsSource: 'mock',
      factsSourceUrl: null,
      factsCapturedAt: now,
      dedupStatus: 'UNIQUE',
      duplicateOf: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(lead.status).toBe('NEW');
    expect(lead.dedupStatus).toBe('UNIQUE');
  });

  it('leadSchema rejects an unknown status', () => {
    const now = new Date();
    expect(() =>
      leadSchema.parse({
        id: 'abc',
        businessName: 'Acme',
        normalizedName: 'acme',
        domain: null,
        normalizedDomain: null,
        placeId: null,
        city: null,
        country: null,
        status: 'NOT_A_STATUS',
        priority: null,
        source: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });
});

describe('evidence schema', () => {
  it('accepts valid evidence and rejects out-of-range confidence', () => {
    const valid = {
      id: 'e1',
      leadId: 'l1',
      sourceType: 'website_html' as const,
      sourceUrl: 'https://example.test',
      capturedAt: new Date().toISOString(),
      claim: 'Homepage has no phone number',
      rawEvidence: '<html>...</html>',
      confidence: 0.8,
    };
    expect(evidenceSchema.parse(valid).confidence).toBe(0.8);
    expect(() => evidenceSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
  });
});
