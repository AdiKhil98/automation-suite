import { describe, expect, it } from 'vitest';
import { normalizeContactEmail } from '../../src/domain/lead-facts/contact-email.js';

describe('normalizeContactEmail', () => {
  it('strips a mailto: scheme and ?query, lowercases, returns the bare address', () => {
    const r = normalizeContactEmail('mailto:Info@Mayfield-Dental.co.uk?subject=New%20Enquiry:');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('info@mayfield-dental.co.uk');
  });

  it('accepts an already-bare address', () => {
    expect(normalizeContactEmail('info@mayfield-dental.co.uk').value).toBe('info@mayfield-dental.co.uk');
  });

  it('strips a #fragment and surrounding whitespace', () => {
    expect(normalizeContactEmail('  info@mayfield-dental.co.uk#x  ').value).toBe('info@mayfield-dental.co.uk');
  });

  it('rejects a non-email string', () => {
    const r = normalizeContactEmail('not-an-email');
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
  });

  it('rejects an empty value after normalization', () => {
    expect(normalizeContactEmail('mailto:?subject=x').ok).toBe(false);
  });
});
