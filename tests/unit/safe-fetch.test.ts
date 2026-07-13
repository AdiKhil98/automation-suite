import { describe, expect, it } from 'vitest';
import { assertUrlSafe, PolicyBlockedError, type Resolver } from '../../src/utils/safe-fetch.js';

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
