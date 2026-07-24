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

export type FictionalImageStyle = 'interior' | 'exterior' | 'architecture' | 'portrait' | 'treatment' | 'location';

export interface FictionalImageSpec {
  /** Stable seed: identical seed + size always yields identical bytes. */
  seed: string;
  width: number;
  height: number;
  /** Base hue in degrees; each fictional asset gets a distinct hue so images are distinguishable. */
  hue: number;
  /** Composition style — gives each fictional asset believable structure, not a flat blur. */
  style?: FictionalImageStyle;
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
 * Render believable, structured fictional imagery — architectural planes, window/light rhythm,
 * perspective floor, and a soft focal subject — so crops and focal points read as intentional
 * photography rather than a flat blur. Fully deterministic; no real place, person, or brand.
 */
export function fictionalPng(spec: FictionalImageSpec): Buffer {
  const { width, height, hue } = spec;
  const style = spec.style ?? 'interior';
  const seedNum = [...createHash('sha256').update(spec.seed).digest().subarray(0, 4)]
    .reduce((sum, byte) => sum * 256 + byte, 0);
  const rand = (n: number) => ((seedNum >> (n % 24)) & 0xff) / 255;
  // Structural parameters vary by style so an "interior" differs from a "portrait" or "exterior".
  const columns = style === 'exterior' || style === 'architecture' ? 7 + Math.round(rand(1) * 4)
    : style === 'portrait' ? 0 : 4 + Math.round(rand(2) * 3);
  const horizonY = style === 'portrait' ? 0.62 : style === 'location' ? 0.66 : 0.58;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const h = x / Math.max(1, width - 1);
      // Focal subject sits slightly above centre (keeps faces/subjects off the crop edges).
      const fx = h - 0.5;
      const fy = v - 0.42;
      const focal = Math.max(0, 1 - Math.sqrt(fx * fx + fy * fy) * (style === 'portrait' ? 1.4 : 1.9));
      // Diagonal daylight falloff.
      const light = 0.12 * (1 - Math.abs(h - (0.3 + rand(3) * 0.2)) - Math.abs(v - 0.25));
      // Vertical rhythm: window mullions / columns for architectural styles.
      const colPhase = columns > 0 ? Math.pow(Math.abs(Math.sin((h * columns + rand(4)) * Math.PI)), 6) : 0;
      const mullion = v < horizonY ? -colPhase * 0.14 : 0;
      // Floor/ceiling separation.
      const floor = v > horizonY ? -0.06 - (v - horizonY) * 0.18 : 0;
      const ceiling = v < 0.14 ? 0.06 : 0;
      const grain = (rand((x * 3 + y * 7) % 24) - 0.5) * 0.02;
      let lightness = 0.42 + (horizonY - v) * 0.2 + focal * 0.22 + light + mullion + floor + ceiling + grain;
      if (style === 'portrait') {
        // Soft studio backdrop with a centred vignette suggesting a person.
        const subject = Math.max(0, 1 - Math.sqrt(fx * fx * 2.2 + (v - 0.5) * (v - 0.5) * 1.4) * 2.4);
        lightness = 0.5 + light + grain - subject * 0.26 + (0.5 - v) * 0.12;
      }
      const hueShift = (hue + h * 12 + (v > horizonY ? 6 : 0)) % 360;
      const saturation = 0.14 + (1 - v) * 0.16 + (style === 'treatment' ? 0.06 : 0);
      // Expand contrast around a mid-tone anchor so images carry real visual weight on a light
      // canvas instead of washing out to near-white.
      const anchor = style === 'portrait' ? 0.46 : 0.5;
      const contrasted = anchor + (lightness - anchor) * 1.45;
      const [r, g, b] = hslToRgb(hueShift, saturation, Math.min(0.9, Math.max(0.14, contrasted)));
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
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function imageSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
