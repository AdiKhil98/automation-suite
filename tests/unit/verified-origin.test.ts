import { describe, expect, it } from 'vitest';
import { VerifiedOriginPolicy } from '../../src/domain/capture/verified-origin.js';

const policy = new VerifiedOriginPolicy({
  officialDomain: 'acme-dental.co.uk',
  officialWebsiteUrl: 'https://www.acme-dental.co.uk',
  officialLocationPageUrl: 'https://www.acme-dental.co.uk/locations/manchester',
});

describe('VerifiedOriginPolicy', () => {
  it('allows the exact verified host and apex↔www', () => {
    expect(policy.isAllowedMainFrame('https://www.acme-dental.co.uk/about').allowed).toBe(true);
    expect(policy.isAllowedMainFrame('https://acme-dental.co.uk/').allowed).toBe(true);
  });
  it('allows http→https on the same host', () => {
    expect(policy.isAllowedMainFrame('http://www.acme-dental.co.uk').allowed).toBe(true);
  });
  it('allows an exact verified branch/location URL', () => {
    expect(policy.isAllowedMainFrame('https://www.acme-dental.co.uk/locations/manchester').reason).toBe('exact_verified_url');
  });
  it('requires review for a different registrable domain (PSL-aware, not string suffix)', () => {
    expect(policy.isAllowedMainFrame('https://acme-dental.co.uk.evil.com').allowed).toBe(false);
    expect(policy.isAllowedMainFrame('https://booking-provider.com/acme').allowed).toBe(false);
  });
  it('requires review for an unverified sibling subdomain', () => {
    const d = policy.isAllowedMainFrame('https://blog.acme-dental.co.uk');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unverified_sibling_subdomain');
  });
  it('rejects non-http(s)', () => {
    expect(policy.isAllowedMainFrame('ftp://www.acme-dental.co.uk').allowed).toBe(false);
  });
});
