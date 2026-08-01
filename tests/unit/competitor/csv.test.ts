import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, parseCompetitorCsv } from '../../../src/domain/competitor/csv.js';

const HEADER = CSV_COLUMNS.join(',');

describe('parseCompetitorCsv', () => {
  it('parses one prospect row and competitor rows', () => {
    const csv = [
      HEADER,
      'prospect,,Smile Clinic,https://smileclinic.example,dentist,teeth whitening;implants,51.5,-0.12,1 High St,London,london,en,independent,,',
      'competitor,pid-1,Acme Dental,https://acme.example,dentist,implants,51.51,-0.13,2 High St,London,london,en,independent,,',
    ].join('\n');
    const parsed = parseCompetitorCsv(csv, 'lead-1');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.prospect?.leadId).toBe('lead-1');
    expect(parsed.prospect?.primaryCategory).toBe('dentist');
    expect(parsed.prospect?.secondaryCategories).toEqual(['teeth whitening', 'implants']);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.providerCandidateId).toBe('pid-1');
    expect(parsed.candidates[0]?.latitude).toBe(51.51);
    expect(parsed.candidates[0]?.malformedReasons).toBeUndefined();
  });

  it('flags malformed competitor rows with row-level reasons (never silently dropped)', () => {
    const csv = [
      HEADER,
      'prospect,,Smile Clinic,https://smileclinic.example,dentist,implants,51.5,-0.12,,London,london,en,independent,,',
      'competitor,,,,,,,,,,,,,,',
      'competitor,,No Coords,https://x.example,dentist,,notanumber,-0.1,,London,london,en,independent,,',
    ].join('\n');
    const parsed = parseCompetitorCsv(csv, 'lead-1');
    expect(parsed.candidates).toHaveLength(2);
    const first = parsed.candidates[0];
    expect(first?.malformedReasons).toContain('missing business_name');
    expect(first?.malformedReasons).toContain('missing website');
    expect(first?.malformedReasons).toContain('missing primary_category');
    const second = parsed.candidates[1];
    expect(second?.malformedReasons).toContain('invalid latitude');
  });

  it('errors when required columns are missing', () => {
    const parsed = parseCompetitorCsv('role,website\ncompetitor,https://x.example', 'lead-1');
    expect(parsed.errors[0]).toContain('missing required columns');
    expect(parsed.candidates).toHaveLength(0);
  });

  it('errors when no prospect row is present', () => {
    const csv = [HEADER, 'competitor,,Acme,https://acme.example,dentist,,51.5,-0.1,,London,london,en,independent,,'].join('\n');
    const parsed = parseCompetitorCsv(csv, 'lead-1');
    expect(parsed.prospect).toBeNull();
    expect(parsed.errors).toContain('no prospect row found (exactly one role=prospect required)');
  });
});
