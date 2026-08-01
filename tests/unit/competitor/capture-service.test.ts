import { describe, expect, it } from 'vitest';
import {
  CompetitorCaptureService,
  type CaptureRunInput,
  type CompetitorCaptureConfig,
  type CompetitorCaptureStore,
  type CompetitorCaptureUnitOfWork,
  type NewCompetitorCaptureRun,
  type NewCompetitorCapturedPage,
} from '../../../src/domain/competitor/capture-service.js';
import { type CompetitorEvidenceItem } from '../../../src/domain/competitor/evidence-types.js';
import { MockCaptureProvider, type MockPageSpec } from '../../../src/integrations/capture/mock-capture.js';
import { type BrowserCaptureProvider } from '../../../src/integrations/capture/provider.js';

const HOME = `<html lang="de"><body>
  <nav><a href="https://competitor-a.de/kontakt">Kontakt</a><a href="https://competitor-a.de/contact">Contact us</a></nav>
  <h1>Praxis</h1>
  <a class="btn" href="https://competitor-a.de/termin">Termin buchen</a>
  <a href="tel:+49301234567">Anrufen</a>
  <address>Hauptstr 1, Berlin</address>
</body></html>`;

const CONTACT = `<html lang="de"><body><h1>Kontakt</h1><a href="tel:+49301234567">Call</a></body></html>`;

const CONFIG: CompetitorCaptureConfig = {
  maxPages: 2,
  maxDepth: 1,
  navigationTimeoutMs: 15_000,
  totalTimeoutMs: 60_000,
  maxScreenshotBytes: 5_000_000,
  fullPageMaxHeightPx: 20_000,
  blockTrackers: true,
  blockMedia: true,
  maxAgeDays: 30,
};

const NOW = new Date('2026-02-01T00:00:00.000Z');

class MemStore implements CompetitorCaptureStore {
  runs: NewCompetitorCaptureRun[] = [];
  pages: NewCompetitorCapturedPage[] = [];
  evidence: CompetitorEvidenceItem[] = [];
  async findRunByContent(researchRunId: string, inputHash: string, configHash: string, contentHash: string) {
    const r = this.runs.find((x) => x.researchRunId === researchRunId && x.inputHash === inputHash && x.configHash === configHash && x.contentHash === contentHash && x.status === 'DRAFT');
    return r ? { id: r.id, version: r.version } : null;
  }
  async maxVersionForResearchRun(researchRunId: string) {
    return this.runs.filter((x) => x.researchRunId === researchRunId).reduce((m, x) => Math.max(m, x.version), 0);
  }
  async supersedePriorDraftRuns(researchRunId: string, newRunId: string) {
    for (const r of this.runs) if (r.researchRunId === researchRunId && r.id !== newRunId && r.status === 'DRAFT') r.status = 'SUPERSEDED';
  }
  async insertRun(run: NewCompetitorCaptureRun) { this.runs.push(run); }
  async insertPages(rows: NewCompetitorCapturedPage[]) { this.pages.push(...rows); }
  async insertEvidence(rows: CompetitorEvidenceItem[]) { this.evidence.push(...rows); }
}

function uowFor(store: MemStore): CompetitorCaptureUnitOfWork {
  return { async transaction(fn) { return fn({ capture: store }); } };
}

function fixtureProvider(pages: Record<string, MockPageSpec>): BrowserCaptureProvider {
  return new MockCaptureProvider(new Map(Object.entries(pages)));
}

function baseInput(over: Partial<CaptureRunInput> = {}): CaptureRunInput {
  return {
    leadId: 'lead-1',
    researchRunId: 'run-1',
    prospectNormalizedDomain: 'prospect.de',
    competitors: [{ competitorCandidateId: 'cand-1', disposition: 'ACCEPTED', normalizedDomain: 'competitor-a.de' }],
    method: 'FIXTURE',
    provider: 'fixture',
    liveEnabled: false,
    liveConfirmed: false,
    apply: false,
    ...over,
  };
}

function service(provider: BrowserCaptureProvider, store: MemStore = new MemStore()): CompetitorCaptureService {
  return new CompetitorCaptureService({ provider, uow: uowFor(store), config: CONFIG, now: () => NOW });
}

describe('CompetitorCaptureService — live guards (fail closed, no fallback)', () => {
  const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME } });

  it('refuses a LIVE capture when COMPETITOR_CAPTURE_ENABLED is false', async () => {
    await expect(service(provider).run(baseInput({ method: 'LIVE_BROWSER', liveEnabled: false, liveConfirmed: true })))
      .rejects.toThrow(/GUARD_FAILED/);
  });

  it('refuses a LIVE capture without explicit confirmation', async () => {
    await expect(service(provider).run(baseInput({ method: 'LIVE_BROWSER', liveEnabled: true, liveConfirmed: false })))
      .rejects.toThrow(/GUARD_FAILED/);
  });

  it('never uses the fixture/mock provider for live intent (no silent fallback)', async () => {
    await expect(service(provider).run(baseInput({ method: 'LIVE_BROWSER', liveEnabled: true, liveConfirmed: true })))
      .rejects.toThrow(/no silent fallback/);
  });
});

describe('CompetitorCaptureService — fixture capture (offline)', () => {
  it('captures evidence from a selected competitor using only the offline mock provider (zero network)', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME }, 'https://competitor-a.de/contact': { html: CONTACT } });
    expect(provider.name).toBe('mock');
    const res = await service(provider).run(baseInput());
    expect(res.outcome).toBe('CAPTURED');
    expect(res.evidence.some((e) => e.evidenceCategory === 'PHONE_VISIBLE' && e.safeForOutreach)).toBe(true);
    expect(res.evidence.some((e) => e.evidenceCategory === 'BOOKING_CTA_VISIBLE')).toBe(true);
  });

  it('enforces the maximum page count', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME }, 'https://competitor-a.de/contact': { html: CONTACT } });
    const res = await service(provider).run(baseInput());
    const distinctUrls = new Set(res.pages.map((p) => p.requestedUrl));
    expect(distinctUrls.size).toBeLessThanOrEqual(CONFIG.maxPages);
  });

  it('drops a page whose final URL escapes the verified origin (same-origin enforced) → ALL_INACCESSIBLE', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME, finalUrl: 'https://evil.example/landing' } });
    const res = await service(provider).run(baseInput());
    expect(res.pages.length).toBe(0);
    expect(res.outcome).toBe('ALL_INACCESSIBLE');
  });

  it('withholds an inaccessible (auth-gated) competitor and reports it, not active evidence', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME, primaryError: 'auth_required' } });
    const res = await service(provider).run(baseInput());
    expect(res.evidence.filter((e) => e.active).length).toBe(0);
    expect(res.outcome).toBe('ALL_INACCESSIBLE');
  });

  it('reports NO_ELIGIBLE_COMPETITORS when the only candidate is the prospect itself', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME } });
    const res = await service(provider).run(baseInput({ prospectNormalizedDomain: 'competitor-a.de' }));
    expect(res.outcome).toBe('NO_ELIGIBLE_COMPETITORS');
    expect(res.eligibility[0]?.reason).toBe('PROSPECT_DOMAIN');
  });

  it('produces no comparative/pattern/email fields on evidence items (7A2 boundary)', async () => {
    const provider = fixtureProvider({ 'https://competitor-a.de': { html: HOME } });
    const res = await service(provider).run(baseInput());
    for (const e of res.evidence) {
      expect(Object.keys(e)).not.toContain('pattern');
      expect(Object.keys(e)).not.toContain('comparison');
      expect(Object.keys(e)).not.toContain('emailWording');
    }
  });
});

describe('CompetitorCaptureService — persistence + idempotency', () => {
  it('persists a DRAFT run on --apply and reuses it on an identical rerun (idempotent, no duplicate)', async () => {
    const store = new MemStore();
    const p1 = fixtureProvider({ 'https://competitor-a.de': { html: HOME } });
    const first = await service(p1, store).run(baseInput({ apply: true }));
    expect(first.persisted).toBe(true);
    expect(first.version).toBe(1);

    const p2 = fixtureProvider({ 'https://competitor-a.de': { html: HOME } });
    const second = await service(p2, store).run(baseInput({ apply: true }));
    expect(second.reusedExisting).toBe(true);
    expect(store.runs.length).toBe(1);
  });

  it('creates a new immutable version when content materially changes (recapture never overwrites)', async () => {
    const store = new MemStore();
    await service(fixtureProvider({ 'https://competitor-a.de': { html: HOME } }), store).run(baseInput({ apply: true }));
    const CHANGED = HOME.replace('<a href="tel:+49301234567">Anrufen</a>', '');
    const res = await service(fixtureProvider({ 'https://competitor-a.de': { html: CHANGED } }), store).run(baseInput({ apply: true }));
    expect(res.persisted).toBe(true);
    expect(res.version).toBe(2);
    expect(store.runs.filter((r) => r.status === 'SUPERSEDED').length).toBe(1);
    expect(store.runs.length).toBe(2);
  });

  it('produces a stable content hash for identical HTML across independent runs', async () => {
    const a = await service(fixtureProvider({ 'https://competitor-a.de': { html: HOME } })).run(baseInput());
    const b = await service(fixtureProvider({ 'https://competitor-a.de': { html: HOME } })).run(baseInput());
    expect(a.contentHash).toBe(b.contentHash);
  });
});
