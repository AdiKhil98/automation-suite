import { isIP } from 'node:net';

/**
 * SSRF address guard. Returns true if an IP literal is in a private, loopback,
 * link-local, multicast, metadata, or otherwise reserved range that must never be
 * fetched. Handles IPv4, IPv6, and IPv4-mapped IPv6.
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inRange(value: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const baseInt = ipv4ToInt(base ?? '');
  if (baseInt === null) return false;
  const bits = Number(bitsStr);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local (incl. 169.254.169.254 cloud metadata)
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
];

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → block defensively
  return BLOCKED_V4_CIDRS.some((cidr) => inRange(value, cidr));
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? ip.toLowerCase(); // strip zone id
  // IPv4-mapped / -compatible: validate the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr) ?? /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);
  // Hex-form IPv4-mapped (::ffff:7f00:1) — expand last 32 bits.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (addr === '::' || addr === '::1') return true; // unspecified / loopback
  if (addr.startsWith('fe80') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (/^f[cd][0-9a-f]{2}:/.test(addr) || addr.startsWith('fc') || addr.startsWith('fd')) return true; // ULA fc00::/7
  if (addr.startsWith('ff')) return true; // multicast ff00::/8
  if (addr.startsWith('2001:db8')) return true; // documentation
  return false;
}

/** True if the given IP literal must be blocked. Non-IP input is blocked defensively. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}
