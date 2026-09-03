import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Diamond Smile regression, structural form: discover-decision-makers must remain incapable of
 * triggering a Hunter/Instantly/Apollo call. This is enforced by construction (no import of those
 * modules anywhere in the feature) — this test is a cheap static tripwire so an accidental future
 * import doesn't silently reintroduce provider-cascade coupling into a read-only discovery stage.
 */

const FORBIDDEN = ['hunter-provider', 'instantly-provider', 'apollo-provider', 'ContactEnrichmentService'];

const FILES = [
  join('src', 'cli', 'commands', 'discover-decision-makers.ts'),
  join('src', 'cli', 'commands', 'discover-decision-makers-build.ts'),
  ...readdirSync(join(process.cwd(), 'src', 'domain', 'decision-makers')).map((f) => join('src', 'domain', 'decision-makers', f)),
  join('src', 'prompts', 'decision-makers', 'index.ts'),
];

describe('discover-decision-makers has zero dependency on Hunter/Instantly/Apollo/ContactEnrichmentService', () => {
  for (const relPath of FILES) {
    it(`${relPath} does not import a contact-enrichment provider module`, () => {
      const text = readFileSync(join(process.cwd(), relPath), 'utf8');
      for (const token of FORBIDDEN) expect(text).not.toContain(token);
    });
  }
});
