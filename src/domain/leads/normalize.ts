/**
 * Deterministic normalization used to build a lead's normalized_* dedup keys.
 * Pure functions only — identical input always yields identical output.
 *
 * NOTE: these run on non-Google data (mock/manual, or later independent
 * website enrichment). Google Places discovery is ID-only, so its display
 * content is never normalized or persisted (see docs/integrations/google-places.md).
 */

export function normalizeName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeDomain(domain: string | null): string | null {
  if (!domain) return null;
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

/** Country calling codes we can strip to reach a national significant number. */
const COUNTRY_CODES = ['44', '972', '353', '1'];

/**
 * Normalize a phone to its national significant number so formatting and
 * national/international trunk differences compare equal, e.g.
 * "+44 161 496 0000", "0161 496 0000" and "(0161) 496-0000" all → "1614960000".
 * Conservative: only strips a known country code (when the input was in
 * international form) or a single national leading zero.
 */
export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '').replace(/^0+(?=\d)/, (m) => (hadPlus ? '' : m));
  if (digits.length === 0) return null;

  if (hadPlus) {
    const withoutIntlPrefix = digits.replace(/^00/, '');
    for (const cc of COUNTRY_CODES) {
      if (withoutIntlPrefix.startsWith(cc) && withoutIntlPrefix.length > cc.length) {
        return withoutIntlPrefix.slice(cc.length);
      }
    }
    return withoutIntlPrefix;
  }
  // National form: drop a single leading trunk zero.
  return digits.replace(/^0/, '');
}

export function normalizeAddress(address: string | null): string | null {
  if (!address) return null;
  const cleaned = address
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeCity(city: string | null): string | null {
  return normalizeName(city);
}
