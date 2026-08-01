import { type CompetitorInputCandidate, type ProspectProfileInput } from './types.js';

/**
 * Deterministic parser for the operator-supplied competitor CSV (see docs). No network, no fs
 * here — the caller reads the file and passes the text in. Exactly one `role=prospect` row is
 * required (it supplies the prospect's comparability attributes and must match the lead's domain);
 * every other row is a competitor candidate. Malformed rows are never silently dropped: they are
 * returned as candidates carrying `malformedReasons` so they persist with a row-level reason.
 */

export const CSV_COLUMNS = [
  'role',
  'provider_candidate_id',
  'business_name',
  'website',
  'primary_category',
  'secondary_categories',
  'latitude',
  'longitude',
  'address',
  'city',
  'market',
  'language',
  'business_type',
  'parent_brand',
  'branch_id',
] as const;

export interface ParsedCsv {
  prospect: ProspectProfileInput | null;
  candidates: CompetitorInputCandidate[];
  errors: string[];
}

function splitLine(line: string): string[] {
  // Minimal, deterministic CSV: comma-separated, optional double-quoted fields (no embedded newlines).
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseNumber(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function parseServices(value: string): string[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCompetitorCsv(text: string, leadId: string): ParsedCsv {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { prospect: null, candidates: [], errors: ['empty csv'] };

  const header = splitLine(lines[0] ?? '').map((h) => h.toLowerCase());
  const missingCols = CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missingCols.length > 0) {
    return { prospect: null, candidates: [], errors: [`missing required columns: ${missingCols.join(', ')}`] };
  }
  const col = (cells: string[], name: (typeof CSV_COLUMNS)[number]): string => cells[header.indexOf(name)]?.trim() ?? '';

  const candidates: CompetitorInputCandidate[] = [];
  let prospect: ProspectProfileInput | null = null;
  let rowIndex = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i] ?? '');
    const role = col(cells, 'role').toLowerCase();
    const lat = parseNumber(col(cells, 'latitude'));
    const lng = parseNumber(col(cells, 'longitude'));
    const website = col(cells, 'website') || null;
    const primaryCategory = col(cells, 'primary_category') || null;

    if (role === 'prospect') {
      if (prospect) { errors.push(`row ${String(i)}: multiple prospect rows (only one allowed)`); continue; }
      prospect = {
        leadId,
        website,
        primaryCategory,
        secondaryCategories: parseServices(col(cells, 'secondary_categories')),
        latitude: lat === null || Number.isNaN(lat) ? null : lat,
        longitude: lng === null || Number.isNaN(lng) ? null : lng,
        city: col(cells, 'city') || null,
        market: col(cells, 'market') || null,
        language: col(cells, 'language') || null,
        businessType: col(cells, 'business_type') || null,
        parentBrand: col(cells, 'parent_brand') || null,
      };
      if (!primaryCategory) errors.push(`row ${String(i)}: prospect row missing primary_category`);
      continue;
    }

    rowIndex += 1;
    const malformed: string[] = [];
    if (role !== 'competitor') malformed.push(`invalid role "${role}" (expected competitor|prospect)`);
    if (!col(cells, 'business_name')) malformed.push('missing business_name');
    if (!website) malformed.push('missing website');
    if (!primaryCategory) malformed.push('missing primary_category');
    if (Number.isNaN(lat)) malformed.push('invalid latitude');
    if (Number.isNaN(lng)) malformed.push('invalid longitude');

    candidates.push({
      rowIndex,
      providerCandidateId: col(cells, 'provider_candidate_id') || null,
      businessName: col(cells, 'business_name') || null,
      website,
      primaryCategory,
      secondaryCategories: parseServices(col(cells, 'secondary_categories')),
      latitude: lat === null || Number.isNaN(lat) ? null : lat,
      longitude: lng === null || Number.isNaN(lng) ? null : lng,
      address: col(cells, 'address') || null,
      city: col(cells, 'city') || null,
      market: col(cells, 'market') || null,
      language: col(cells, 'language') || null,
      businessType: col(cells, 'business_type') || null,
      parentBrand: col(cells, 'parent_brand') || null,
      branchId: col(cells, 'branch_id') || null,
      ...(malformed.length > 0 ? { malformedReasons: malformed } : {}),
    });
  }

  if (!prospect) errors.push('no prospect row found (exactly one role=prospect required)');
  return { prospect, candidates, errors };
}
