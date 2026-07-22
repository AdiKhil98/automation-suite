import { describe, expect, it } from 'vitest';
import type { LookupAddress, LookupOptions } from 'node:dns';
import {
  assertUrlSafe,
  createValidatedLookup,
  PolicyBlockedError,
  type Resolver,
} from '../../src/utils/safe-fetch.js';

const publicResolver: Resolver = async () => ['93.184.216.34'];
const privateResolver: Resolver = async () => ['10.0.0.5'];
const mixedResolver: Resolver = async () => ['93.184.216.34', '169.254.169.254']; // one blocked
const neverCalled: Resolver = async () => {
  throw new Error('resolver should not be called for IP-literal host');
};

describe('assertUrlSafe', () => {
  it('accepts a public host', async () => {
    const url = await assertUrlSafe('http://example.com/path', publicResolver);
    expect(url.hostname).toBe('example.com');
  });
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlSafe('ftp://example.com', publicResolver)).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(assertUrlSafe('file:///etc/passwd', publicResolver)).rejects.toBeInstanceOf(PolicyBlockedError);
  });
  it('rejects embedded credentials', async () => {
    await expect(assertUrlSafe('http://user:pass@example.com', publicResolver)).rejects.toBeInstanceOf(PolicyBlockedError);
  });
  it('rejects hosts resolving to a private address', async () => {
    await expect(assertUrlSafe('http://intranet.local', privateResolver)).rejects.toBeInstanceOf(PolicyBlockedError);
  });
  it('rejects when ANY resolved address is blocked', async () => {
    await expect(assertUrlSafe('http://rebind.example', mixedResolver)).rejects.toBeInstanceOf(PolicyBlockedError);
  });
  it('validates IP-literal hosts directly (no DNS) incl. numeric forms', async () => {
    await expect(assertUrlSafe('http://127.0.0.1', neverCalled)).rejects.toBeInstanceOf(PolicyBlockedError);
    // 2130706433 === 127.0.0.1; WHATWG URL normalizes it.
    await expect(assertUrlSafe('http://2130706433', neverCalled)).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(assertUrlSafe('http://[::1]', neverCalled)).rejects.toBeInstanceOf(PolicyBlockedError);
  });
});

function runLookup(resolve: Resolver, all: boolean): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolveResult, reject) => {
    createValidatedLookup(resolve)(
      'example.com',
      { all } as LookupOptions,
      (error, address, family) => {
        if (error) reject(error);
        else resolveResult({ address, family });
      },
    );
  });
}

describe('createValidatedLookup', () => {
  it('returns every validated address when Node requests all families', async () => {
    await expect(runLookup(async () => ['2001:4860:4860::8888', '8.8.8.8'], true)).resolves.toEqual({
      address: [
        { address: '2001:4860:4860::8888', family: 6 },
        { address: '8.8.8.8', family: 4 },
      ],
      family: undefined,
    });
  });

  it('supports IPv4-only and IPv6-only results', async () => {
    await expect(runLookup(async () => ['8.8.8.8'], true)).resolves.toEqual({
      address: [{ address: '8.8.8.8', family: 4 }],
      family: undefined,
    });
    await expect(runLookup(async () => ['2001:4860:4860::8888'], true)).resolves.toEqual({
      address: [{ address: '2001:4860:4860::8888', family: 6 }],
      family: undefined,
    });
  });

  it('retains the single-address callback contract when requested', async () => {
    await expect(runLookup(async () => ['8.8.8.8', '2001:4860:4860::8888'], false)).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', 'fe80::1'])(
    'rejects unsafe connect-time address %s',
    async (address) => {
      await expect(runLookup(async () => [address], true)).rejects.toBeInstanceOf(PolicyBlockedError);
    },
  );
});
