import { describe, expect, it } from 'vitest';
import { isBlockedIp } from '../../src/utils/ip-guard.js';

describe('isBlockedIp (SSRF matrix)', () => {
  it('blocks private / loopback / reserved IPv4', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '0.0.0.0', '100.64.0.1', '198.18.0.1', '240.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it('blocks link-local and cloud metadata IPv4', () => {
    expect(isBlockedIp('169.254.1.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true); // metadata
  });
  it('blocks multicast IPv4', () => {
    expect(isBlockedIp('224.0.0.1')).toBe(true);
    expect(isBlockedIp('239.255.255.250')).toBe(true);
  });
  it('allows public IPv4', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
  });
  it('blocks IPv6 loopback / unspecified / ULA / link-local / multicast', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it('blocks IPv4-mapped IPv6 pointing at private/loopback', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true);
  });
  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
  it('blocks unparseable input defensively', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});
