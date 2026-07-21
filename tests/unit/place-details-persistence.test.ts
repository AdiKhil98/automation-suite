import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { GoogleContextProvider, type GoogleReadBudget } from '../../src/integrations/enrichment/context-providers.js';
import { HttpWebsiteVerifier } from '../../src/integrations/enrichment/http-website-verifier.js';
import { MockPageFetcher } from '../../src/integrations/enrichment/mock-page-fetcher.js';
import { type WebsiteVerificationAttempt } from '../../src/integrations/enrichment/provider.js';
import { buildGooglePlaceFacts } from '../../src/persistence/google-place-details-store.js';

const logger = pino({ level: 'silent' });

describe('Place Details persistence boundary', () => {
  it('maps approved Place Details fields with field-level provenance and omits unapproved phone', () => {
    const retrievedAt = new Date('2026-07-21T10:00:00.000Z');
    const facts = buildGooglePlaceFacts(
      'lead-example',
      'place-example',
      {
        displayName: 'Example Dental',
        websiteUri: 'https://clinic.example/',
        formattedAddress: '1 Example Street',
        locality: 'Example City',
        country: 'Example Country',
        primaryType: 'dentist',
        businessStatus: 'OPERATIONAL',
        nationalPhoneNumber: '+1 555 0100',
      },
      retrievedAt,
      false,
    );
    expect(facts.map((fact) => fact.factType)).toEqual([
      'google_place_id',
      'business_name',
      'candidate_website_url',
      'formatted_address',
      'city',
      'country',
      'category',
      'business_status',
    ]);
    expect(facts.every((fact) => fact.sourceType === 'google_places')).toBe(true);
    expect(facts.every((fact) => fact.capturedAt === retrievedAt)).toBe(true);
    expect(facts.some((fact) => fact.factType === 'phone')).toBe(false);
  });

  it('persists successful Place Details before a later website verification failure', async () => {
    const persisted: unknown[] = [];
    const budget: GoogleReadBudget = { requests: 0, estimatedCostUsd: 0, maxRequests: 1, maxCostUsd: 1 };
    const provider = new GoogleContextProvider({
      client: {
        details: async () => ({
          displayName: 'Example Dental',
          formattedAddress: '1 Example Street',
          locality: 'Example City',
          country: 'Example Country',
          primaryType: 'dentist',
          businessStatus: 'OPERATIONAL',
          websiteUri: 'https://clinic.example/',
        }),
      },
      allowPaidReads: true,
      budget,
      logger,
      detailsStore: { persist: async (input) => { persisted.push(input); return 7; } },
    });

    const context = await provider.contextFor({ leadId: 'lead-example', placeId: 'place-example', currentFacts: [] });
    const verifier = new HttpWebsiteVerifier(
      new MockPageFetcher(new Map([['https://clinic.example/', { kind: 'transient' as const, reason: 'sanitized failure' }]])),
      { minConfidence: 0.6, ambiguousMargin: 0.1, maxPages: 1 },
    );
    const report = await verifier.verify(
      [{ url: context?.candidateUrls?.[0] ?? '', discoverySource: 'website_hint' }],
      context ?? {},
    );

    expect(report.fetchKinds).toEqual(['transient']);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(expect.objectContaining({ leadId: 'lead-example', placeId: 'place-example' }));
  });

  it('removes credentials, query secrets and fragments from stored attempt URLs', async () => {
    const secretUrl = 'https://operator:password@clinic.example/path?token=secret#private';
    const verifier = new HttpWebsiteVerifier(
      new MockPageFetcher(new Map([[secretUrl, { kind: 'policy_blocked' as const, reason: 'credentials blocked' }]])),
      { minConfidence: 0.6, ambiguousMargin: 0.1, maxPages: 1 },
    );
    const report = await verifier.verify([{ url: secretUrl, discoverySource: 'manual' }], {});
    const attempt: WebsiteVerificationAttempt | undefined = report.fetchAttempts[0];
    const serialized = JSON.stringify(attempt);
    expect(serialized).toContain('clinic.example/path');
    expect(serialized).not.toContain('operator');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private');
  });
});
