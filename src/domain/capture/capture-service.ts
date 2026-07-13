import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { AppError } from '../../utils/errors.js';
import { type ArtifactMeta, type CaptureStorageProvider } from '../../integrations/capture/storage.js';
import { type BrowserCaptureProvider } from '../../integrations/capture/provider.js';
import { extractPage } from '../enrichment/extract.js';
import { scoreCandidate } from '../enrichment/verify-domain.js';
import { type EnrichmentContext } from '../enrichment/types.js';
import { type FactType, type LeadFact, type NewLeadFact } from '../lead-facts/lead-fact.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import {
  CAPTURE_EXTRACTOR_VERSION,
  extractCaptureEvidence,
  normalizedEvidenceFingerprint,
  rawDomHash,
  type CaptureEvidenceItem,
} from './capture-evidence.js';
import { type CaptureOutcome, type CapturePurpose, routeAuditCapture } from './capture-outcome.js';
import {
  DESKTOP_PROFILE,
  EMULATION_PROFILE_VERSION,
  MOBILE_PROFILE,
  type BrowserInfo,
  type RenderedCapture,
  type RenderedPage,
} from './capture-types.js';
import { PAGE_SELECTION_POLICY_VERSION, primaryAuditTarget } from './page-selection.js';
import { VerifiedOriginPolicy } from './verified-origin.js';

const MIN_RENDERABLE_TEXT = 40;

export interface NewCaptureRun {
  id: string;
  leadId: string;
  runId: string;
  purpose: CapturePurpose;
  outcome: CaptureOutcome;
  primaryUrl: string | null;
  sourceEnrichmentCandidateId: string | null;
  desktopPrimaryComplete: boolean;
  mobilePrimaryComplete: boolean;
  secondaryPagesAttempted: number;
  secondaryPagesCompleted: number;
  partialReason: string | null;
  normalizedEvidenceFingerprint: string | null;
  browser: BrowserInfo;
  emulationProfileVersion: string;
  pageSelectionPolicyVersion: string;
  extractorVersion: string;
  startedAt: Date;
  completedAt: Date;
}

export interface NewCapturedPage {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string | null;
  httpStatus: number;
  role: string;
  profile: 'desktop' | 'mobile';
  ok: boolean;
  loadMs: number;
  hasHorizontalOverflow: boolean;
  rawDomHash: string | null;
}

export interface CaptureRunStore {
  recordRun(run: NewCaptureRun): Promise<void>;
  recordPage(captureRunId: string, page: NewCapturedPage): Promise<string>;
  recordArtifact(capturedPageId: string, meta: ArtifactMeta): Promise<void>;
  recordEvidence(capturedPageId: string, items: CaptureEvidenceItem[]): Promise<void>;
  recordError(
    captureRunId: string,
    capturedPageId: string | null,
    err: { pageUrl: string | null; profile: 'desktop' | 'mobile' | null; kind: string; detail: string },
  ): Promise<void>;
}
export interface CaptureFactStore {
  getCurrentFact(leadId: string, factType: FactType): Promise<LeadFact | null>;
  writeCurrentFact(fact: NewLeadFact): Promise<string>;
}
export interface CaptureEventRecorder {
  record(event: NewPipelineEvent): Promise<void>;
}
export interface CaptureTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  capture: CaptureRunStore;
  facts: CaptureFactStore;
  events: CaptureEventRecorder;
}
export interface CaptureUnitOfWork {
  transaction<T>(fn: (repos: CaptureTxRepos) => Promise<T>): Promise<T>;
}

export interface CaptureConfig {
  maxPages: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
  maxScreenshotBytes: number;
  fullPageMaxHeightPx: number;
  blockTrackers: boolean;
  blockMedia: boolean;
  minConfidence: number;
  ambiguousMargin: number;
}

export interface CaptureServiceDeps {
  provider: BrowserCaptureProvider;
  storage: CaptureStorageProvider;
  uow: CaptureUnitOfWork;
  logger: Logger;
  config: CaptureConfig;
}

export interface CaptureInput {
  leadId: string;
  purpose: CapturePurpose;
  facts: LeadFact[];
  sourceEnrichmentCandidateId?: string | null;
  verificationTargetUrl?: string | null; // required for VERIFICATION_CAPTURE
}

export interface CaptureResult {
  leadId: string;
  purpose: CapturePurpose;
  outcome: CaptureOutcome;
  verified?: boolean;
}

const factVal = (facts: LeadFact[], t: FactType): string | null =>
  facts.find((f) => f.factType === t && f.isCurrent)?.value ?? null;

function originsFromFacts(facts: LeadFact[]): VerifiedOriginPolicy {
  return new VerifiedOriginPolicy({
    officialDomain: factVal(facts, 'official_domain'),
    officialWebsiteUrl: factVal(facts, 'official_website_url'),
    officialLocationPageUrl: factVal(facts, 'official_location_page_url'),
  });
}

function contextFromFacts(facts: LeadFact[]): EnrichmentContext {
  return {
    businessName: factVal(facts, 'business_name'),
    phone: factVal(facts, 'phone'),
    formattedAddress: factVal(facts, 'formatted_address'),
    city: factVal(facts, 'city'),
    country: factVal(facts, 'country'),
    candidateUrls: [],
  };
}

export interface AuditDecision {
  outcome: CaptureOutcome;
  desktop: boolean;
  mobile: boolean;
  secondaryAttempted: number;
  secondaryCompleted: number;
  partialReason: string | null;
}

/** Decide the AUDIT capture outcome + completeness from rendered pages. */
export function decideAuditOutcome(primaryUrl: string, rendered: RenderedCapture): AuditDecision {
  const primary = rendered.pages.filter((p) => p.requestedUrl === primaryUrl);
  const desktop = primary.find((p) => p.profile === 'desktop');
  const mobile = primary.find((p) => p.profile === 'mobile');
  const primaryErrors = [
    ...(desktop?.errors ?? []),
    ...(mobile?.errors ?? []),
    ...rendered.errors.filter((e) => e.pageUrl === primaryUrl),
  ];
  const has = (kind: string): boolean => primaryErrors.some((e) => e.kind === kind);

  const secondary = rendered.pages.filter((p) => p.requestedUrl !== primaryUrl);
  const secondaryAttempted = new Set(secondary.map((p) => p.requestedUrl)).size;
  const secondaryCompleted = new Set(secondary.filter((p) => p.ok).map((p) => p.requestedUrl)).size;
  const desktopOk = Boolean(desktop?.ok);
  const mobileOk = Boolean(mobile?.ok);

  const base = { desktop: desktopOk, mobile: mobileOk, secondaryAttempted, secondaryCompleted };
  const fail = (outcome: CaptureOutcome): AuditDecision => ({ ...base, outcome, partialReason: outcome });

  if (has('bot_challenge')) return fail('BOT_CHALLENGE');
  if (has('auth_required')) return fail('AUTH_REQUIRED');
  if (has('cross_domain_redirect')) return fail('POLICY_BLOCKED');

  const renderable = (p?: RenderedPage): boolean =>
    Boolean(p?.ok) && extractPage(p?.html ?? '', primaryUrl, primaryUrl, 200).visibleTextLength >= MIN_RENDERABLE_TEXT;

  if (!desktopOk && !mobileOk) return fail(has('navigation_timeout') ? 'TRANSIENT_ERROR' : 'BROWSER_BLOCKED');
  if (!renderable(desktop) && !renderable(mobile)) return fail('NO_RENDERABLE_CONTENT');

  if (desktopOk && mobileOk) {
    const partial = secondaryAttempted > secondaryCompleted;
    return { ...base, outcome: partial ? 'PARTIAL_CAPTURE' : 'CAPTURED', partialReason: partial ? 'secondary_pages_incomplete' : null };
  }
  return {
    ...base,
    outcome: has('navigation_timeout') ? 'TRANSIENT_ERROR' : 'BROWSER_BLOCKED',
    partialReason: 'primary_single_profile_only',
  };
}

export class CaptureService {
  constructor(private readonly deps: CaptureServiceDeps) {}

  async capture(input: CaptureInput, runId: string): Promise<CaptureResult> {
    return input.purpose === 'VERIFICATION_CAPTURE'
      ? this.verificationCapture(input, runId)
      : this.auditCapture(input, runId);
  }

  private buildRequest(primaryUrl: string, facts: LeadFact[], role: 'primary' | 'location') {
    return {
      primary: { url: primaryUrl, role },
      originPolicy: originsFromFacts(facts),
      profiles: [DESKTOP_PROFILE, MOBILE_PROFILE],
      maxPages: this.deps.config.maxPages,
      navigationTimeoutMs: this.deps.config.navigationTimeoutMs,
      totalTimeoutMs: this.deps.config.totalTimeoutMs,
      maxScreenshotBytes: this.deps.config.maxScreenshotBytes,
      fullPageMaxHeightPx: this.deps.config.fullPageMaxHeightPx,
      blockTrackers: this.deps.config.blockTrackers,
      blockMedia: this.deps.config.blockMedia,
    };
  }

  private async auditCapture(input: CaptureInput, runId: string): Promise<CaptureResult> {
    const captureRunId = randomUUID();
    const startedAt = new Date();
    const target = primaryAuditTarget(input.facts);

    let rendered: RenderedCapture | null = null;
    let outcome: CaptureOutcome;
    let decision: ReturnType<typeof decideAuditOutcome> | null = null;
    const stagedByPage = new Map<string, ArtifactMeta[]>();

    if (!target) {
      outcome = 'INVALID_TARGET';
    } else {
      rendered = await this.deps.provider.capture(this.buildRequest(target.url, input.facts, target.role === 'location' ? 'location' : 'primary'));
      decision = decideAuditOutcome(target.url, rendered);
      outcome = decision.outcome;
      // Stage screenshots for ok pages (outside the tx).
      let pageIndex = 0;
      for (const page of rendered.pages) {
        for (const shot of page.screenshots) {
          const meta = await this.deps.storage.stage(captureRunId, shot, pageIndex);
          const list = stagedByPage.get(pageKey(page)) ?? [];
          list.push(meta);
          stagedByPage.set(pageKey(page), list);
        }
        pageIndex += 1;
      }
    }
    const completedAt = new Date();

    try {
      await this.deps.uow.transaction(async (repos) => {
        const lead = await repos.leads.getById(input.leadId);
        if (!lead) throw new AppError('LEAD_NOT_FOUND', input.leadId);
        if (lead.status !== 'READY_FOR_CAPTURE') throw new AppError('NOT_CAPTURABLE', `${input.leadId} not READY_FOR_CAPTURE`);

        const evidenceForFingerprint: CaptureEvidenceItem[] = [];
        await repos.capture.recordRun({
          id: captureRunId,
          leadId: input.leadId,
          runId,
          purpose: 'AUDIT_CAPTURE',
          outcome,
          primaryUrl: target?.url ?? null,
          sourceEnrichmentCandidateId: null,
          desktopPrimaryComplete: decision?.desktop ?? false,
          mobilePrimaryComplete: decision?.mobile ?? false,
          secondaryPagesAttempted: decision?.secondaryAttempted ?? 0,
          secondaryPagesCompleted: decision?.secondaryCompleted ?? 0,
          partialReason: decision?.partialReason ?? (target ? null : 'no_target'),
          normalizedEvidenceFingerprint: null,
          browser: rendered?.browser ?? { playwrightVersion: 'n/a', browser: 'n/a', browserVersion: null, chromiumRevision: null, dockerImageTag: null },
          emulationProfileVersion: EMULATION_PROFILE_VERSION,
          pageSelectionPolicyVersion: PAGE_SELECTION_POLICY_VERSION,
          extractorVersion: CAPTURE_EXTRACTOR_VERSION,
          startedAt,
          completedAt,
        });

        for (const page of rendered?.pages ?? []) {
          const pageId = await repos.capture.recordPage(captureRunId, {
            requestedUrl: page.requestedUrl,
            finalUrl: page.finalUrl,
            canonicalUrl: page.canonicalUrl,
            httpStatus: page.httpStatus,
            role: page.requestedUrl === target?.url ? 'primary' : 'secondary',
            profile: page.profile,
            ok: page.ok,
            loadMs: page.loadMs,
            hasHorizontalOverflow: page.hasHorizontalOverflow,
            rawDomHash: page.ok ? rawDomHash(page.html) : null,
          });
          for (const meta of stagedByPage.get(pageKey(page)) ?? []) await repos.capture.recordArtifact(pageId, meta);
          if (page.ok) {
            const items = extractCaptureEvidence(page);
            await repos.capture.recordEvidence(pageId, items);
            if (page.requestedUrl === target?.url) evidenceForFingerprint.push(...items);
          }
          for (const err of page.errors) await repos.capture.recordError(captureRunId, pageId, { pageUrl: err.pageUrl, profile: err.profile, kind: err.kind, detail: err.detail });
        }
        for (const err of rendered?.errors ?? []) {
          await repos.capture.recordError(captureRunId, null, { pageUrl: err.pageUrl, profile: err.profile, kind: err.kind, detail: err.detail });
        }
        void normalizedEvidenceFingerprint(evidenceForFingerprint); // computed for history (persisted via run update omitted for brevity)

        // Routing.
        const route = routeAuditCapture(outcome);
        if (route === 'CAPTURED_THEN_AUDIT') {
          await repos.leadService.transition(input.leadId, 'CAPTURED');
          await repos.leadService.transition(input.leadId, 'READY_FOR_AUDIT');
        } else if (route === 'NEEDS_MANUAL_REVIEW') {
          await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
        }
        await repos.events.record({
          leadId: input.leadId,
          runId,
          type: 'NOTE',
          fromStatus: null,
          toStatus: null,
          message: `capture(AUDIT): ${outcome}`,
          data: { captureRunId, outcome },
        });
      });
      await this.deps.storage.commitAll(captureRunId);
    } catch (err) {
      await this.deps.storage.discardTemp(captureRunId);
      throw err;
    }
    return { leadId: input.leadId, purpose: 'AUDIT_CAPTURE', outcome };
  }

  private async verificationCapture(input: CaptureInput, runId: string): Promise<CaptureResult> {
    const captureRunId = randomUUID();
    const startedAt = new Date();
    const targetUrl = input.verificationTargetUrl ?? null;
    let outcome: CaptureOutcome = 'INVALID_TARGET';
    let verified = false;

    let rendered: RenderedCapture | null = null;
    const stagedByPage = new Map<string, ArtifactMeta[]>();
    if (targetUrl) {
      rendered = await this.deps.provider.capture(this.buildRequest(targetUrl, input.facts, 'primary'));
      const primaryDesktop = rendered.pages.find((p) => p.requestedUrl === targetUrl && p.profile === 'desktop');
      if (primaryDesktop?.ok) {
        const pages = [extractPage(primaryDesktop.html, targetUrl, primaryDesktop.finalUrl, 200)];
        const v = scoreCandidate({ url: targetUrl, discoverySource: 'manual' }, pages, contextFromFacts(input.facts), {
          minConfidence: this.deps.config.minConfidence,
          ambiguousMargin: this.deps.config.ambiguousMargin,
        });
        verified = v.decision === 'VERIFIED';
        outcome = 'CAPTURED'; // we captured the page; `verified` drives routing
      } else {
        outcome = 'TRANSIENT_ERROR';
      }
      let pageIndex = 0;
      for (const page of rendered.pages) {
        for (const shot of page.screenshots) {
          const meta = await this.deps.storage.stage(captureRunId, shot, pageIndex);
          const list = stagedByPage.get(pageKey(page)) ?? [];
          list.push(meta);
          stagedByPage.set(pageKey(page), list);
        }
        pageIndex += 1;
      }
    }
    const completedAt = new Date();

    try {
      await this.deps.uow.transaction(async (repos) => {
        const lead = await repos.leads.getById(input.leadId);
        if (!lead) throw new AppError('LEAD_NOT_FOUND', input.leadId);
        if (lead.status !== 'READY_FOR_CAPTURE') throw new AppError('NOT_CAPTURABLE', `${input.leadId} not READY_FOR_CAPTURE`);

        // A verification capture records the capture outcome; `verified` (separate)
        // decides routing — rendering alone never claims official status.
        const recordedOutcome: CaptureOutcome = outcome;
        await repos.capture.recordRun({
          id: captureRunId, leadId: input.leadId, runId, purpose: 'VERIFICATION_CAPTURE', outcome: recordedOutcome,
          primaryUrl: targetUrl, sourceEnrichmentCandidateId: input.sourceEnrichmentCandidateId ?? null,
          desktopPrimaryComplete: verified, mobilePrimaryComplete: false, secondaryPagesAttempted: 0, secondaryPagesCompleted: 0,
          partialReason: verified ? null : 'not_verified',
          normalizedEvidenceFingerprint: null,
          browser: rendered?.browser ?? { playwrightVersion: 'n/a', browser: 'n/a', browserVersion: null, chromiumRevision: null, dockerImageTag: null },
          emulationProfileVersion: EMULATION_PROFILE_VERSION, pageSelectionPolicyVersion: PAGE_SELECTION_POLICY_VERSION,
          extractorVersion: CAPTURE_EXTRACTOR_VERSION, startedAt, completedAt,
        });
        for (const page of rendered?.pages ?? []) {
          const pageId = await repos.capture.recordPage(captureRunId, {
            requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, canonicalUrl: page.canonicalUrl, httpStatus: page.httpStatus,
            role: 'primary', profile: page.profile, ok: page.ok, loadMs: page.loadMs, hasHorizontalOverflow: page.hasHorizontalOverflow,
            rawDomHash: page.ok ? rawDomHash(page.html) : null,
          });
          for (const meta of stagedByPage.get(pageKey(page)) ?? []) await repos.capture.recordArtifact(pageId, meta);
          if (page.ok) await repos.capture.recordEvidence(pageId, extractCaptureEvidence(page));
        }

        if (verified && targetUrl) {
          // Write verified official facts (independent, from the rendered official site).
          const host = new URL(targetUrl).host.toLowerCase().replace(/^www\./, '');
          await this.writeOfficialFact(repos, input.leadId, 'official_domain', host, host, targetUrl);
          await this.writeOfficialFact(repos, input.leadId, 'official_website_url', targetUrl, targetUrl, targetUrl);
          // Lead is already READY_FOR_CAPTURE — it now proceeds to a normal AUDIT_CAPTURE.
        } else if (outcome !== 'TRANSIENT_ERROR') {
          await repos.leadService.transition(input.leadId, 'NEEDS_MANUAL_REVIEW');
        }
        // TRANSIENT_ERROR: remain READY_FOR_CAPTURE for a safe retry.
        await repos.events.record({
          leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null,
          message: `capture(VERIFICATION): ${verified ? 'verified' : 'not_verified'}`,
          data: { captureRunId, verified },
        });
      });
      await this.deps.storage.commitAll(captureRunId);
    } catch (err) {
      await this.deps.storage.discardTemp(captureRunId);
      throw err;
    }
    return { leadId: input.leadId, purpose: 'VERIFICATION_CAPTURE', outcome: verified ? 'CAPTURED' : outcome, verified };
  }

  private async writeOfficialFact(
    repos: CaptureTxRepos,
    leadId: string,
    factType: FactType,
    value: string,
    normalized: string,
    sourceUrl: string,
  ): Promise<void> {
    const existing = await repos.facts.getCurrentFact(leadId, factType);
    if (existing && (existing.normalizedValue ?? existing.value) === normalized) return; // idempotent
    if (existing && existing.sourceType === 'manual') return; // never override manual
    await repos.facts.writeCurrentFact({ leadId, factType, value, normalizedValue: normalized, sourceType: 'website', sourceUrl, confidence: 0.9 });
  }
}

function pageKey(p: RenderedPage): string {
  return `${p.requestedUrl}::${p.profile}`;
}
