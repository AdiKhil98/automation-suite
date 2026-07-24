import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Deterministic PNG generator for FICTIONAL demo assets.
 *
 * The renderer must never hotlink or download imagery, and committed tests must not carry binary
 * blobs, so fixture photography is synthesised locally from a seed. Output is byte-stable for a
 * given seed and size, which keeps asset content hashes and the render hash reproducible.
 */

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

export interface FictionalImageSpec {
  /** Stable seed: identical seed + size always yields identical bytes. */
  seed: string;
  width: number;
  height: number;
  /** Base hue in degrees; each fictional asset gets a distinct hue so images are distinguishable. */
  hue: number;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Render a calm, architectural-looking gradient with soft horizontal banding and a lighter focal
 * region slightly above centre — enough structure that crops and focal points are visibly
 * meaningful, with no real place, person, or brand depicted.
 */
export function fictionalPng(spec: FictionalImageSpec): Buffer {
  const { width, height, hue } = spec;
  const seedNum = [...createHash('sha256').update(spec.seed).digest().subarray(0, 4)]
    .reduce((sum, byte) => sum * 256 + byte, 0);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    const vertical = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const horizontal = x / Math.max(1, width - 1);
      // Soft focal glow above centre keeps faces/subjects out of the default crop edges.
      const focalX = horizontal - 0.5;
      const focalY = vertical - 0.42;
      const focal = Math.max(0, 1 - Math.sqrt(focalX * focalX + focalY * focalY) * 1.9);
      const band = Math.sin((vertical * 9 + (seedNum % 7)) * Math.PI) * 0.035;
      const lightness = 0.36 + vertical * 0.24 + focal * 0.2 + band;
      const saturation = 0.1 + (1 - vertical) * 0.14;
      const [r, g, b] = hslToRgb((hue + horizontal * 14) % 360, saturation, Math.min(0.93, Math.max(0.1, lightness)));
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function imageSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
