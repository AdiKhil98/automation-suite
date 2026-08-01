import { randomUUID } from 'node:crypto';
import { type BrowserCaptureProvider } from '../../integrations/capture/provider.js';
import { DESKTOP_PROFILE, MOBILE_PROFILE, type RenderedPage } from '../capture/capture-types.js';
import { rawDomHash } from '../capture/capture-evidence.js';
import {
  CANDIDATE_PATH_MATCHERS,
  COMPETITOR_EVIDENCE_RULES_VERSION,
  type CaptureMethod,
  type CapturePageRole,
  type CaptureProvider,
} from './capture-constants.js';
import { evaluateEligibility, type SelectedCompetitorInput } from './capture-eligibility.js';
import { finalizeObservation } from './evidence-confidence.js';
import { evaluateFreshness } from './evidence-freshness.js';
import { captureConfigHash, captureContentHash, captureInputHash, evidenceItemHash } from './evidence-hash.js';
import { deriveCompetitorObservations } from './evidence-rules.js';
import {
  type CapturedPageInput,
  type CaptureRunOutcome,
  type CaptureRunStatus,
  type CompetitorEvidenceItem,
  type EvidenceObservation,
} from './evidence-types.js';

export interface CompetitorCaptureConfig {
  maxPages: number;
  maxDepth: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
  maxScreenshotBytes: number;
  fullPageMaxHeightPx: number;
  blockTrackers: boolean;
  blockMedia: boolean;
  maxAgeDays: number;
}

/** Persisted capture-run header (immutable/versioned; superseded, never deleted). */
export interface NewCompetitorCaptureRun {
  id: string;
  leadId: string;
  researchRunId: string;
  provider: CaptureProvider;
  method: CaptureMethod;
  status: CaptureRunStatus;
  outcome: CaptureRunOutcome;
  rulesVersion: string;
  version: number;
  inputHash: string;
  configHash: string;
  contentHash: string;
  competitorCount: number;
  pageCount: number;
  evidenceCount: number;
  activeEvidenceCount: number;
  withheldEvidenceCount: number;
  maxPages: number;
  maxDepth: number;
  startedAt: Date;
  completedAt: Date;
}

export interface NewCompetitorCapturedPage {
  id: string;
  captureRunId: string;
  competitorCandidateId: string;
  requestedUrl: string;
  finalUrl: string;
  normalizedOrigin: string;
  role: CapturePageRole;
  profile: 'desktop' | 'mobile';
  ok: boolean;
  httpStatus: number | null;
  errorKinds: string[];
  rawDomHash: string | null;
}

export interface CompetitorCaptureStore {
  findRunByContent(researchRunId: string, inputHash: string, configHash: string, contentHash: string): Promise<{ id: string; version: number } | null>;
  maxVersionForResearchRun(researchRunId: string): Promise<number>;
  supersedePriorDraftRuns(researchRunId: string, newRunId: string): Promise<void>;
  insertRun(run: NewCompetitorCaptureRun): Promise<void>;
  insertPages(rows: NewCompetitorCapturedPage[]): Promise<void>;
  insertEvidence(rows: CompetitorEvidenceItem[]): Promise<void>;
}

export interface CompetitorCaptureUnitOfWork {
  transaction<T>(fn: (repos: { capture: CompetitorCaptureStore }) => Promise<T>): Promise<T>;
}

export interface CompetitorCaptureDeps {
  provider: BrowserCaptureProvider;
  uow: CompetitorCaptureUnitOfWork;
  config: CompetitorCaptureConfig;
  /** now() injected for deterministic freshness in tests. */
  now?: () => Date;
}

export interface CaptureRunInput {
  leadId: string;
  researchRunId: string;
  prospectNormalizedDomain: string | null;
  competitors: SelectedCompetitorInput[];
  method: CaptureMethod;
  provider: CaptureProvider;
  /** Live guards. A LIVE_BROWSER capture requires BOTH; otherwise the run fails closed (no fixture fallback). */
  liveEnabled: boolean;
  liveConfirmed: boolean;
  apply: boolean;
}

export interface CaptureRunResult {
  outcome: CaptureRunOutcome;
  version: number | null;
  runRecordId: string | null;
  persisted: boolean;
  reusedExisting: boolean;
  inputHash: string;
  configHash: string;
  contentHash: string;
  pages: NewCompetitorCapturedPage[];
  evidence: CompetitorEvidenceItem[];
  eligibility: ReturnType<typeof evaluateEligibility>[];
}

/** Classify a captured page's role from its URL relative to the competitor origin. */
function roleForUrl(url: string, originUrl: string): CapturePageRole {
  const normalize = (u: string): string => u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (normalize(url) === normalize(originUrl)) return 'homepage';
  for (const { role, test } of CANDIDATE_PATH_MATCHERS) {
    if (test.test(url)) return role;
  }
  return 'contact';
}

function toPageInput(page: RenderedPage, originUrl: string): CapturedPageInput {
  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    role: roleForUrl(page.requestedUrl, originUrl),
    profile: page.profile,
    ok: page.ok,
    html: page.html,
    errorKinds: page.errors.map((e) => e.kind),
  };
}

/**
 * Phase 7A2 competitor evidence capture. For competitors SELECTED by a Phase 7A1 run, capture narrow,
 * reproducible presence/absence evidence from a bounded set of public pages and persist an immutable,
 * versioned evidence set. Fixture mode is the default and performs zero network I/O. Live mode is
 * disabled unless BOTH guards are set and fails closed — it never falls back to fixtures. No AI, no
 * email, no Gmail, no Sheets, no sending, no comparative patterns.
 */
export class CompetitorCaptureService {
  private readonly now: () => Date;
  constructor(private readonly deps: CompetitorCaptureDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async run(input: CaptureRunInput): Promise<CaptureRunResult> {
    const startedAt = this.now();

    // Fail-closed live guards. A requested live capture that lacks either guard is a hard error and
    // NEVER silently degrades to the fixture provider.
    if (input.method === 'LIVE_BROWSER') {
      if (!input.liveEnabled) throw new Error('GUARD_FAILED: competitor live capture requires COMPETITOR_CAPTURE_ENABLED=true');
      if (!input.liveConfirmed) throw new Error('GUARD_FAILED: competitor live capture requires an explicit confirmation flag');
      if (this.deps.provider.name === 'mock' || this.deps.provider.name === 'fixture') {
        throw new Error('GUARD_FAILED: live intent must not use the fixture/mock provider (no silent fallback)');
      }
    } else if (this.deps.provider.name === 'playwright') {
      throw new Error('GUARD_FAILED: fixture method must not use a live browser provider');
    }

    const eligibility = input.competitors.map((c) => evaluateEligibility(c, input.prospectNormalizedDomain));
    const eligible = eligibility.filter((e) => e.eligible);

    const inputHash = captureInputHash(
      eligible.map((e) => ({ competitorCandidateId: e.competitorCandidateId, normalizedOrigin: e.normalizedOrigin ?? '' })),
    );
    const configHash = captureConfigHash({ ...this.deps.config, method: input.method, provider: input.provider }, COMPETITOR_EVIDENCE_RULES_VERSION);

    const pages: NewCompetitorCapturedPage[] = [];
    const observations: EvidenceObservation[] = [];
    let inaccessibleCompetitors = 0;

    for (const e of eligible) {
      if (!e.originUrl || !e.originPolicy || !e.normalizedOrigin) continue;
      const rendered = await this.deps.provider.capture({
        primary: { url: e.originUrl, role: 'primary' },
        originPolicy: e.originPolicy,
        profiles: [DESKTOP_PROFILE, MOBILE_PROFILE],
        maxPages: this.deps.config.maxPages,
        navigationTimeoutMs: this.deps.config.navigationTimeoutMs,
        totalTimeoutMs: this.deps.config.totalTimeoutMs,
        maxScreenshotBytes: this.deps.config.maxScreenshotBytes,
        fullPageMaxHeightPx: this.deps.config.fullPageMaxHeightPx,
        blockTrackers: this.deps.config.blockTrackers,
        blockMedia: this.deps.config.blockMedia,
      });

      const pageInputs: CapturedPageInput[] = [];
      for (const p of rendered.pages) {
        // Enforce same-origin defense-in-depth: drop any page whose final URL escapes the policy.
        if (!e.originPolicy.isAllowedMainFrame(p.finalUrl).allowed) continue;
        const pi = toPageInput(p, e.originUrl);
        pageInputs.push(pi);
        pages.push({
          id: randomUUID(),
          captureRunId: '', // filled after run id is known
          competitorCandidateId: e.competitorCandidateId,
          requestedUrl: p.requestedUrl,
          finalUrl: p.finalUrl,
          normalizedOrigin: e.normalizedOrigin,
          role: pi.role,
          profile: p.profile,
          ok: p.ok,
          httpStatus: p.httpStatus || null,
          errorKinds: p.errors.map((err) => err.kind),
          rawDomHash: p.ok ? rawDomHash(p.html) : null,
        });
      }

      const okPages = pageInputs.filter((p) => p.ok && p.html.trim() !== '');
      if (okPages.length === 0) {
        inaccessibleCompetitors += 1;
        continue;
      }
      observations.push(...deriveCompetitorObservations(e.competitorCandidateId, e.normalizedOrigin, pageInputs));
    }

    const completedAt = this.now();
    const contentHash = captureContentHash(observations, COMPETITOR_EVIDENCE_RULES_VERSION);

    // Shape evidence items (freshness + safe-for-outreach finalized deterministically).
    const runRecordId = randomUUID();
    for (const p of pages) p.captureRunId = runRecordId;

    const evidence: CompetitorEvidenceItem[] = observations.map((obs) => {
      const freshness = evaluateFreshness(completedAt, this.now(), this.deps.config.maxAgeDays);
      const fin = finalizeObservation(obs, freshness);
      return {
        ...obs,
        withholdingReason: fin.withholdingReason,
        id: randomUUID(),
        captureRunId: runRecordId,
        capturedAt: completedAt,
        captureMethod: input.method,
        provider: input.provider,
        rulesVersion: COMPETITOR_EVIDENCE_RULES_VERSION,
        freshnessStatus: freshness,
        safeForOutreach: fin.safeForOutreach,
        active: fin.active,
        evidenceHash: evidenceItemHash(obs, COMPETITOR_EVIDENCE_RULES_VERSION),
      };
    });

    const activeCount = evidence.filter((e) => e.active).length;
    const withheldCount = evidence.length - activeCount;
    const outcome = computeOutcome(eligible.length, inaccessibleCompetitors, evidence.length);

    const result: CaptureRunResult = {
      outcome,
      version: null,
      runRecordId: null,
      persisted: false,
      reusedExisting: false,
      inputHash,
      configHash,
      contentHash,
      pages,
      evidence,
      eligibility,
    };

    if (!input.apply) return result;

    return this.deps.uow.transaction(async ({ capture }) => {
      const existing = await capture.findRunByContent(input.researchRunId, inputHash, configHash, contentHash);
      if (existing) {
        return { ...result, persisted: false, reusedExisting: true, runRecordId: existing.id, version: existing.version };
      }
      const version = (await capture.maxVersionForResearchRun(input.researchRunId)) + 1;
      await capture.supersedePriorDraftRuns(input.researchRunId, runRecordId);
      await capture.insertRun({
        id: runRecordId,
        leadId: input.leadId,
        researchRunId: input.researchRunId,
        provider: input.provider,
        method: input.method,
        status: 'DRAFT',
        outcome,
        rulesVersion: COMPETITOR_EVIDENCE_RULES_VERSION,
        version,
        inputHash,
        configHash,
        contentHash,
        competitorCount: eligible.length,
        pageCount: pages.length,
        evidenceCount: evidence.length,
        activeEvidenceCount: activeCount,
        withheldEvidenceCount: withheldCount,
        maxPages: this.deps.config.maxPages,
        maxDepth: this.deps.config.maxDepth,
        startedAt,
        completedAt,
      });
      await capture.insertPages(pages);
      await capture.insertEvidence(evidence);
      return { ...result, persisted: true, reusedExisting: false, runRecordId, version };
    });
  }
}

function computeOutcome(eligibleCount: number, inaccessibleCount: number, evidenceCount: number): CaptureRunOutcome {
  if (eligibleCount === 0) return 'NO_ELIGIBLE_COMPETITORS';
  if (inaccessibleCount === eligibleCount) return 'ALL_INACCESSIBLE';
  if (inaccessibleCount > 0 || evidenceCount === 0) return 'PARTIAL';
  return 'CAPTURED';
}
