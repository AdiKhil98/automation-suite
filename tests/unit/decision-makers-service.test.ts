import { describe, expect, it } from 'vitest';
import { type Logger } from 'pino';
import { extractDecisionMakers, filterAndRankCandidates, type DecisionMakerLlmDeps } from '../../src/domain/decision-makers/service.js';
import { MockLlmProvider, type MockResponder } from '../../src/integrations/llm/mock-llm.js';
import { type EvidencePage } from '../../src/domain/decision-makers/website-evidence.js';
import {
  DECISION_MAKER_JSON_SCHEMA,
  DECISION_MAKER_SCHEMA_VERSION,
  decisionMakerExtractionOutputSchema,
  MAX_EVIDENCE_SNIPPET_CHARS,
} from '../../src/domain/decision-makers/schema.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function baseDeps(responder: MockResponder): DecisionMakerLlmDeps {
  return {
    provider: new MockLlmProvider(responder),
    model: 'mock-decision-makers-1',
    reasoningEffort: 'medium',
    store: false,
    timeoutMs: 30_000,
    maxOutputTokens: 2000,
    maxRetries: 0,
    maxCallsPerLead: 1,
    maxCostUsdPerLead: 0.5,
    minConfidence: 0.6,
    logger,
  };
}

const HOME_PAGE: EvidencePage = { role: 'home', url: 'https://diamond-smile.com/', text: 'Diamond Smile — a modern dental practice.' };
const TEAM_PAGE: EvidencePage = {
  role: 'team',
  url: 'https://diamond-smile.com/meet-the-team',
  text: 'Meet the team. Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile. Shaimil Patel is our Clinical Director. Kymya Doyley is our Practice Manager. Priya Nair is a Dental Hygienist.',
};

describe('extractDecisionMakers', () => {
  it('official team page -> correct principal/owner candidate', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]).toMatchObject({ fullName: 'Shyam Shastri', title: 'Principal Dentist', priority: 1, sourceUrl: TEAM_PAGE.url });
    }
  });

  it('a Managing Director cited from an official team page is accepted without the practice name in the snippet', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Mena Williams', title: 'Managing Director', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Mena Williams Managing Director VIEW PROFILE' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Dulwich Orthodontics', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted[0]).toMatchObject({ fullName: 'Mena Williams', priority: 4 });
    }
  });

  it('an organisation proposed as a person is rejected outright', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Jacobs Holding AG', title: 'Owner', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Our majority owner is Jacobs Holding AG.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]).toMatchObject({ fullName: 'Jacobs Holding AG', reason: 'not_a_person' });
    }
  });

  it('multiple strong roles -> correct priority ordering (owner before clinical director before practice manager)', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Kymya Doyley', title: 'Practice Manager', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Kymya Doyley is our Practice Manager.' },
          { fullName: 'Shaimil Patel', title: 'Clinical Director', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Shaimil Patel is our Clinical Director.' },
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted.map((a) => a.fullName)).toEqual(['Shyam Shastri', 'Shaimil Patel', 'Kymya Doyley']);
    }
  });

  it('ordinary staff proposed by the model are excluded by the deterministic filter', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Priya Nair', title: 'Dental Hygienist', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Priya Nair is a Dental Hygienist.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toEqual([{ fullName: 'Priya Nair', title: 'Dental Hygienist', reason: 'unmapped_title' }]);
    }
  });

  it('rejects a low-confidence / ambiguous candidate', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.3, evidenceSnippet: 'possibly Shyam?' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toBe('low_confidence');
    }
  });

  it('rejects a candidate citing a hallucinated/out-of-range evidence tag (fail closed, never guesses)', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E99'], confidence: 0.95, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toBe('evidence_unresolvable');
    }
  });

  it('caps accepted candidates at 3 even when more than 3 valid candidates are proposed', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Person One', title: 'Owner', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Person One, Owner.' },
          { fullName: 'Person Two', title: 'Founder', evidenceIds: ['E2'], confidence: 0.94, evidenceSnippet: 'Person Two, Founder.' },
          { fullName: 'Person Three', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.93, evidenceSnippet: 'Person Three, Principal Dentist.' },
          { fullName: 'Person Four', title: 'Clinical Director', evidenceIds: ['E2'], confidence: 0.92, evidenceSnippet: 'Person Four, Clinical Director.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.accepted).toHaveLength(3);
  });

  it('schema_invalid model output fails this lead closed without crashing', async () => {
    const responder: MockResponder = () => ({ rawJson: { totally: 'wrong shape' } });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('schema_invalid');
  });

  it('a paid schema-invalid call preserves usage/cost metadata instead of becoming financially invisible', async () => {
    const responder: MockResponder = () => ({
      rawJson: { totally: 'wrong shape' },
      resolvedModel: 'gpt-5.6-sol',
      requestId: 'req_abc123',
      usage: { inputTokens: 4210, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 318, reasoningTokens: 96, estimatedCostUsd: 0.0271 },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('schema_invalid');
    if (result.status === 'schema_invalid') {
      expect(result.call).toMatchObject({
        llmCalls: 1,
        resolvedModel: 'gpt-5.6-sol',
        requestId: 'req_abc123',
        inputTokens: 4210,
        outputTokens: 318,
        totalTokens: 4528,
        estimatedCostUsd: 0.0271,
        failureCategory: 'schema_invalid',
      });
      // Safe metadata only — never the raw model output.
      expect(JSON.stringify(result.call)).not.toContain('wrong shape');
    }
  });

  it('a completed-but-unusable provider status also preserves usage/cost metadata', async () => {
    const responder: MockResponder = () => ({
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
      usage: { inputTokens: 4210, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2000, reasoningTokens: 1900, estimatedCostUsd: 0.05 },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('provider_error');
    if (result.status === 'provider_error') {
      expect(result.call).toMatchObject({ llmCalls: 1, totalTokens: 6210, estimatedCostUsd: 0.05, failureCategory: 'provider_error' });
    }
  });

  it('a successful call reports metadata with no failure category', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.call).toMatchObject({ llmCalls: 1, failureCategory: 'none', totalTokens: 320 });
  });

  it('sends the versioned decision-maker JSON Schema as the structured-output contract', async () => {
    const provider = new MockLlmProvider(() => ({ rawJson: { candidates: [], insufficientEvidence: true } }));
    await extractDecisionMakers({ ...baseDeps(() => ({})), provider }, [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    // The provider turns `outputSchema` into text.format json_schema with strict:true — asserted in
    // tests/unit/openai-responses.test.ts. This proves the decision-maker path feeds it the right one.
    expect(provider.calls[0]?.outputSchema).toBe(DECISION_MAKER_JSON_SCHEMA);
    expect(provider.calls[0]?.schemaName).toBe(`decision_maker_extraction_${DECISION_MAKER_SCHEMA_VERSION}`);
  });

  it('no pages gathered -> no_pages, no LLM call attempted', async () => {
    let called = 0;
    const responder: MockResponder = () => { called += 1; return { rawJson: { candidates: [], insufficientEvidence: true } }; };
    const result = await extractDecisionMakers(baseDeps(responder), [], 'Diamond Smile', 3);
    expect(result.status).toBe('no_pages');
    expect(called).toBe(0);
  });

  it('Diamond Smile regression: the exact three known decision-makers, in priority order', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Kymya Doyley', title: 'Practice Manager', evidenceIds: ['E2'], confidence: 0.88, evidenceSnippet: 'Kymya Doyley is our Practice Manager.' },
          { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.97, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist, founded Diamond Smile.' },
          { fullName: 'Shaimil Patel', title: 'Clinical Director', evidenceIds: ['E2'], confidence: 0.92, evidenceSnippet: 'Shaimil Patel is our Clinical Director.' },
          { fullName: 'Priya Nair', title: 'Dental Hygienist', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: 'Priya Nair is a Dental Hygienist.' },
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted.map((a) => `${a.fullName}|${a.title}`)).toEqual([
        'Shyam Shastri|Principal Dentist',
        'Shaimil Patel|Clinical Director',
        'Kymya Doyley|Practice Manager',
      ]);
      expect(result.rejected.map((r) => r.fullName)).toEqual(['Priya Nair']);
    }
  });
});

describe('trust failures vs harmless size normalization', () => {
  const VALID = { fullName: 'Shyam Shastri', title: 'Principal Dentist', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Dr. Shyam Shastri, Principal Dentist.' };

  it('an over-long evidence snippet is truncated, not rejected, and does not destroy sibling candidates', async () => {
    const longSnippet = `Shaimil Patel is our Clinical Director. ${'x'.repeat(2000)}`;
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'Shaimil Patel', title: 'Clinical Director', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: longSnippet },
          VALID,
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // BOTH candidates survive — the old contract would have failed the entire paid response.
      expect(result.accepted.map((a) => a.fullName)).toEqual(['Shyam Shastri', 'Shaimil Patel']);
      const truncated = result.accepted.find((a) => a.fullName === 'Shaimil Patel');
      expect(truncated?.evidenceSnippet.length).toBeLessThanOrEqual(MAX_EVIDENCE_SNIPPET_CHARS);
      expect(truncated?.evidenceSnippet.startsWith('Shaimil Patel is our Clinical Director.')).toBe(true);
      expect(truncated?.evidenceSnippet.endsWith('…')).toBe(true);
    }
  });

  it('an absurd name rejects only that candidate; a name is never truncated into a false identity', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: 'A'.repeat(500), title: 'Owner', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Long paste.' },
          VALID,
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted.map((a) => a.fullName)).toEqual(['Shyam Shastri']);
      expect(result.rejected[0]?.reason).toBe('unusable_field');
      // The rejection record stays readable rather than echoing 500 characters.
      expect(result.rejected[0]?.fullName.length).toBeLessThanOrEqual(81);
    }
  });

  it('a blank name or blank snippet rejects only that candidate', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [
          { fullName: '   ', title: 'Owner', evidenceIds: ['E2'], confidence: 0.95, evidenceSnippet: 'Someone owns it.' },
          { fullName: 'Kymya Doyley', title: 'Practice Manager', evidenceIds: ['E2'], confidence: 0.9, evidenceSnippet: '   ' },
          VALID,
        ],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted.map((a) => a.fullName)).toEqual(['Shyam Shastri']);
      expect(result.rejected.map((r) => r.reason)).toEqual(['unusable_field', 'unusable_field']);
    }
  });

  it('TRUST: a broken evidence-citation contract still fails the whole response closed', async () => {
    const responder: MockResponder = () => ({
      rawJson: { candidates: [{ ...VALID, evidenceIds: [] }], insufficientEvidence: false },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('schema_invalid');
  });

  it('TRUST: an out-of-range confidence still fails the whole response closed', async () => {
    const responder: MockResponder = () => ({
      rawJson: { candidates: [{ ...VALID, confidence: 1.4 }], insufficientEvidence: false },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('schema_invalid');
  });

  it('TRUST: an invalid evidence alias still fails that candidate closed, never guessed', async () => {
    const responder: MockResponder = () => ({
      rawJson: {
        candidates: [{ ...VALID, evidenceIds: ['https://example.com/team'] }],
        insufficientEvidence: false,
      },
    });
    const result = await extractDecisionMakers(baseDeps(responder), [HOME_PAGE, TEAM_PAGE], 'Diamond Smile', 3);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toBe('evidence_unresolvable');
    }
  });
});

describe('filterAndRankCandidates (pure)', () => {
  it('is a pure function producing the same shape extractDecisionMakers relies on', () => {
    const parsed = decisionMakerExtractionOutputSchema.parse({
      candidates: [{ fullName: 'Shyam Shastri', title: 'Owner', evidenceIds: ['E1'], confidence: 0.9, evidenceSnippet: 'Shyam Shastri, Owner.' }],
      insufficientEvidence: false,
    });
    const { accepted, rejected } = filterAndRankCandidates(parsed, [HOME_PAGE], 'Diamond Smile', 0.6);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });
});
