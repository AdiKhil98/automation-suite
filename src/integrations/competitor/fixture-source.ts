import { type CompetitorInputCandidate, type ProspectProfileInput } from '../../domain/competitor/types.js';
import { type CompetitorCandidateSource, type CompetitorSourceResult } from './provider.js';

export interface CompetitorFixture {
  prospect: ProspectProfileInput;
  candidates: CompetitorInputCandidate[];
}

/** In-memory fixture source (tests + bundled sample). Deterministic; no fs, no network. */
export class FixtureCompetitorSource implements CompetitorCandidateSource {
  readonly name = 'fixture' as const;
  constructor(private readonly fixture: CompetitorFixture) {}

  load(leadId: string): CompetitorSourceResult {
    const errors: string[] = [];
    if (this.fixture.prospect.leadId !== leadId) {
      errors.push(`fixture prospect leadId ${this.fixture.prospect.leadId} does not match requested lead ${leadId}`);
    }
    return { prospect: { ...this.fixture.prospect, leadId }, candidates: this.fixture.candidates, errors };
  }
}

/** Operator-CSV source: the CLI reads the file and parses it via the domain parser first. */
export class ParsedCsvCompetitorSource implements CompetitorCandidateSource {
  readonly name = 'operator_csv' as const;
  constructor(private readonly result: CompetitorSourceResult) {}
  load(): CompetitorSourceResult {
    return this.result;
  }
}
