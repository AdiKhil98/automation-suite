import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Logger } from 'pino';
import { hashCanonical, sha256Hex } from '../../utils/hash.js';
import { type NetlifyDeploymentProvider } from '../../integrations/netlify/provider.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type LeadStatus } from '../leads/status.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { checkEligibility, type EligibilitySnapshot } from './eligibility.js';
import { buildDeployPackage } from './package-builder.js';
import { finalizeEmailBody } from './finalize.js';
import { verifyDeployment } from './verify.js';
import { type VerifyFetchOutcome } from './verify-fetch.js';

export type DeployOutcome =
  | 'DEPLOYED_AND_VERIFIED'
  | 'DEPLOYMENT_PENDING'
  | 'DEPLOYMENT_FAILED'
  | 'VERIFICATION_FAILED'
  | 'INVALID_ARTIFACT'
  | 'INVALID_ELIGIBILITY'
  | 'DUPLICATE_REUSED'
  | 'RATE_LIMITED'
  | 'BUDGET_BLOCKED'
  | 'TRANSIENT_ERROR'
  | 'MANUAL_REVIEW_REQUIRED';

export interface DeployConfig {
  siteId: string;
  expectedHostname: string;
  maxPerDay: number;
  minIntervalMs: number;
  maxUploadBytes: number;
  maxUploadFiles: number;
  pollIntervalMs: number;
  maxPollAttempts: number;
  verifyTimeoutMs: number;
  featureEnabled: boolean;
  credentialsConfigured: boolean;
}

export interface DeployInput {
  leadId: string;
  leadStatus: string;
  demoDir: string;
  demo: { id: string; status: string; contentHash: string | null; templateId: string; templateVersion: string };
  email: { id: string; humanDecision: string | null; ctaKind: string; body: string } | null;
}

/** Row reserved BEFORE the external call, so a timeout/uncertain response is reconcilable. */
export interface DeploymentRunRecord {
  id: string;
  leadId: string;
  demoId: string;
  originalEmailDraftId: string | null;
  provider: string;
  siteId: string;
  deployId: string | null;
  artifactHash: string;
  attemptFingerprint: string;
  outcome: DeployOutcome;
  draftUrl: string | null;
  permalinkUrl: string | null;
  verifiedUrl: string | null;
  verificationResult: unknown;
  errorClass: string | null;
  callsMade: number;
  startedAt: Date;
  completedAt: Date | null;
}

export interface FinalizationRecord {
  id: string;
  originalDraftId: string;
  deploymentRunId: string;
  verifiedDeploymentUrl: string;
  originalBodyHash: string;
  resolvedBody: string;
  resolvedBodyHash: string;
}

export interface DeployStore {
  deployAttemptsToday(now: Date): Promise<number>;
  lastAttemptAt(): Promise<Date | null>;
  existingVerified(siteId: string, artifactHash: string): Promise<{ runId: string; deployId: string | null; verifiedUrl: string } | null>;
  findReservedByFingerprint(fingerprint: string): Promise<DeploymentRunRecord | null>;
  reserveRun(row: DeploymentRunRecord): Promise<void>;
  setDeployId(runId: string, deployId: string): Promise<void>;
}

export interface DeployTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  completeRun(runId: string, patch: Partial<DeploymentRunRecord>): Promise<void>;
  createFinalization(row: FinalizationRecord): Promise<void>;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface DeployUnitOfWork {
  transaction<T>(fn: (repos: DeployTxRepos) => Promise<T>): Promise<T>;
}

export type VerifyFetchFn = (url: string) => Promise<VerifyFetchOutcome>;

export interface DeploymentServiceDeps {
  provider: NetlifyDeploymentProvider;
  fetch: VerifyFetchFn;
  store: DeployStore;
  uow: DeployUnitOfWork;
  logger: Logger;
  config: DeployConfig;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployResult {
  leadId: string;
  outcome: DeployOutcome;
  verifiedUrl: string | null;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Phase 11 deployment orchestration for ONE approved demo. Fail-closed at every step:
 * eligibility → package (allowlist) → idempotent reconcile → DRAFT deploy → bounded poll →
 * hardened verification → email finalization → persist. Transient/pending/rate-limited leave
 * the lead at WAITING_FOR_DEMO_URL (retryable); a verified deploy + finalized email advances to
 * FINALIZED_EMAIL_PENDING (a SECOND human approval); invalid artifact/verification → manual review.
 * Never sends, never creates Gmail drafts, never touches the production deploy.
 */
export class DeploymentService {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: DeploymentServiceDeps) {
    this.sleep = deps.sleep ?? realSleep;
  }

  async deploy(input: DeployInput, runId: string): Promise<DeployResult> {
    const c = this.deps.config;

    // Recompute the artifact hash from the on-disk index.html (matches the composer formula).
    let html: string | null;
    try {
      html = await readFile(join(input.demoDir, 'index.html'), 'utf8');
    } catch {
      html = null;
    }
    const recomputedArtifactHash = html === null ? null : hashCanonical({ html, template: input.demo.templateId, version: input.demo.templateVersion });

    const existingVerified = input.demo.contentHash
      ? await this.deps.store.existingVerified(c.siteId, input.demo.contentHash)
      : null;

    const snapshot: EligibilitySnapshot = {
      leadStatus: input.leadStatus,
      demo: { status: input.demo.status, contentHash: input.demo.contentHash },
      email: input.email ? { humanDecision: input.email.humanDecision, ctaKind: input.email.ctaKind, body: input.email.body } : null,
      artifactPresent: html !== null,
      recomputedArtifactHash,
      featureEnabled: c.featureEnabled,
      credentialsConfigured: c.credentialsConfigured,
      existingVerifiedForArtifact: existingVerified !== null,
    };
    const elig = checkEligibility(snapshot);

    // ---- Duplicate reuse: a prior verified deploy for this artifact — reuse its URL. ----
    if (elig.duplicateReusable && existingVerified && input.email) {
      return this.finalizeAndRoute(input, runId, existingVerified.verifiedUrl, existingVerified.deployId, 'DUPLICATE_REUSED', null, existingVerified.runId, html);
    }
    if (!elig.eligible) {
      const artifactProblem = elig.reasons.some((r) => r.startsWith('artifact_'));
      const outcome: DeployOutcome = artifactProblem ? 'INVALID_ARTIFACT' : 'INVALID_ELIGIBILITY';
      // Artifact problems need a human; missing preconditions just stay waiting.
      return this.recordTerminal(input, runId, outcome, artifactProblem ? 'NEEDS_MANUAL_REVIEW' : null, elig.reasons.join(','), null, null);
    }

    const now = new Date();

    // ---- Build the deploy package (strict allowlist). ----
    const built = await buildDeployPackage(input.demoDir, { maxBytes: c.maxUploadBytes, maxFiles: c.maxUploadFiles, artifactHash: input.demo.contentHash as string });
    if (!built.ok || !built.pkg || html === null) {
      return this.recordTerminal(input, runId, 'INVALID_ARTIFACT', 'NEEDS_MANUAL_REVIEW', built.violations.join(','), null, null);
    }
    const pkg = built.pkg;

    // ---- Reconcile + create. The attempt fingerprint is (site|artifact). A prior
    // non-succeeded run for it is RESUMED (its deploy id reused) so an uncertain outcome
    // never spawns a second deploy. The per-day + min-interval throttles gate ONLY a genuine
    // new create — never a reconciling retry. The run row (with fingerprint) is persisted
    // BEFORE any create POST. ----
    const attemptFingerprint = sha256Hex(`${c.siteId}|${pkg.artifactHash}`);
    const reserved = await this.deps.store.findReservedByFingerprint(attemptFingerprint);
    let run: DeploymentRunRecord | null = reserved;
    let deployId: string | null = reserved?.deployId ?? null;

    const newRun = (): DeploymentRunRecord => ({
      id: randomUUID(), leadId: input.leadId, demoId: input.demo.id, originalEmailDraftId: input.email?.id ?? null,
      provider: this.deps.provider.name, siteId: c.siteId, deployId: null, artifactHash: pkg.artifactHash,
      attemptFingerprint, outcome: 'DEPLOYMENT_PENDING', draftUrl: null, permalinkUrl: null, verifiedUrl: null,
      verificationResult: null, errorClass: null, callsMade: 0, startedAt: now, completedAt: null,
    });

    if (!deployId) {
      // Reconcile via the provider (a prior uncertain create may have produced a deploy).
      const found = await this.deps.provider.findDeployByFingerprint(c.siteId, attemptFingerprint);
      if (found.outcome === 'ok' && found.found && found.ref) {
        deployId = found.ref.deployId;
        if (!run) { run = newRun(); await this.deps.store.reserveRun(run); }
      } else {
        // Genuine new create — throttle BEFORE reserving/creating (lastAttemptAt excludes this
        // not-yet-reserved attempt, so it compares against the PREVIOUS deploy).
        if (await this.deps.store.deployAttemptsToday(now) >= c.maxPerDay) return this.recordTerminal(input, runId, 'BUDGET_BLOCKED', null, 'max_per_day', run?.id ?? null, null);
        const lastAt = await this.deps.store.lastAttemptAt();
        if (lastAt && now.getTime() - lastAt.getTime() < c.minIntervalMs) return this.recordTerminal(input, runId, 'BUDGET_BLOCKED', null, 'min_interval', run?.id ?? null, null);
        if (!run) { run = newRun(); await this.deps.store.reserveRun(run); }
        const create = await this.deps.provider.createDraftDeploy({ siteId: c.siteId, pkg, attemptFingerprint });
        if (create.outcome === 'rate_limited') return this.recordTerminal(input, runId, 'RATE_LIMITED', null, 'create_rate_limited', run.id, null);
        if (create.outcome === 'transient') return this.recordTerminal(input, runId, 'TRANSIENT_ERROR', null, 'create_transient', run.id, null);
        if (create.outcome === 'auth_error') return this.recordTerminal(input, runId, 'DEPLOYMENT_FAILED', 'NEEDS_MANUAL_REVIEW', 'auth_error', run.id, null);
        if (create.outcome !== 'ok' || !create.ref) return this.recordTerminal(input, runId, 'DEPLOYMENT_FAILED', 'NEEDS_MANUAL_REVIEW', create.reason ?? 'create_failed', run.id, null);
        deployId = create.ref.deployId;
      }
      await this.deps.store.setDeployId(run.id, deployId);
    }
    if (!run) run = reserved ?? newRun();

    // ---- Bounded poll until ready / terminal. ----
    let draftUrl: string | null = null;
    for (let attempt = 0; attempt < c.maxPollAttempts; attempt += 1) {
      const st = await this.deps.provider.getDeploy(c.siteId, deployId);
      if (st.outcome === 'rate_limited' || st.outcome === 'transient') { await this.sleep(c.pollIntervalMs); continue; }
      if (st.outcome !== 'ok' || !st.ref) return this.recordTerminal(input, runId, 'DEPLOYMENT_FAILED', 'NEEDS_MANUAL_REVIEW', st.reason ?? 'poll_failed', run.id, deployId);
      if (st.ref.state === 'error') return this.recordTerminal(input, runId, 'DEPLOYMENT_FAILED', 'NEEDS_MANUAL_REVIEW', 'deploy_state_error', run.id, deployId);
      if (st.ref.state === 'ready' && st.ref.draftUrl) { draftUrl = st.ref.draftUrl; break; }
      await this.sleep(c.pollIntervalMs);
    }
    if (!draftUrl) return this.recordTerminal(input, runId, 'DEPLOYMENT_PENDING', null, 'poll_timeout', run.id, deployId);

    // ---- Verify (hardened fetch + fail-closed checks). ----
    const fetched = await this.deps.fetch(draftUrl);
    if (fetched.kind === 'transient') return this.recordTerminal(input, runId, 'TRANSIENT_ERROR', null, `verify_${fetched.reason}`, run.id, deployId, draftUrl);
    if (fetched.kind !== 'ok') return this.recordTerminal(input, runId, 'VERIFICATION_FAILED', 'NEEDS_MANUAL_REVIEW', `verify_${fetched.kind}`, run.id, deployId, draftUrl);

    if (!input.email) return this.recordTerminal(input, runId, 'INVALID_ELIGIBILITY', null, 'no_email', run.id, deployId, draftUrl);
    const fin = finalizeEmailBody(input.email.body, fetched.finalUrl);
    if (!fin.ok || !fin.resolvedBody) return this.recordTerminal(input, runId, 'VERIFICATION_FAILED', 'NEEDS_MANUAL_REVIEW', `finalize_${fin.reason ?? 'error'}`, run.id, deployId, draftUrl);

    const verification = verifyDeployment({
      status: fetched.status, finalUrl: fetched.finalUrl, host: fetched.host, headers: fetched.headers,
      fetchedHtml: fetched.body, localHtml: html, expectedHostname: c.expectedHostname, resolvedEmailBody: fin.resolvedBody,
    });
    if (!verification.ok) return this.recordTerminal(input, runId, 'VERIFICATION_FAILED', 'NEEDS_MANUAL_REVIEW', verification.violations.join(','), run.id, deployId, draftUrl, verification.violations);

    // ---- Verified: create the finalized email + advance to the second human review. ----
    return this.finalizeAndRoute(input, runId, fetched.finalUrl, deployId, 'DEPLOYED_AND_VERIFIED', run.id, run.id, html, draftUrl, verification.violations);
  }

  /** Persist a terminal (non-verified) outcome + optional lead route, in one transaction. */
  private async recordTerminal(
    input: DeployInput, runId: string, outcome: DeployOutcome, route: LeadStatus | null, errorClass: string | null,
    reservedRunId: string | null, deployId: string | null, draftUrl: string | null = null, violations: string[] | null = null,
  ): Promise<DeployResult> {
    await this.deps.uow.transaction(async (repos) => {
      if (reservedRunId) {
        await repos.completeRun(reservedRunId, { outcome, deployId, draftUrl, errorClass, verificationResult: violations, completedAt: new Date() });
      }
      if (route) {
        const lead = await repos.leads.getById(input.leadId);
        if (lead && lead.status === 'WAITING_FOR_DEMO_URL') await repos.leadService.transition(input.leadId, route);
      }
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: `deploy: ${outcome}`, data: { outcome, errorClass } });
    });
    return { leadId: input.leadId, outcome, verifiedUrl: null };
  }

  /** Persist a verified/reused deploy + the immutable finalized email, then advance the lead. */
  private async finalizeAndRoute(
    input: DeployInput, runId: string, verifiedUrl: string, deployId: string | null, outcome: 'DEPLOYED_AND_VERIFIED' | 'DUPLICATE_REUSED',
    reservedRunId: string | null, deploymentRunId: string, html: string | null, draftUrl: string | null = null, violations: string[] | null = null,
  ): Promise<DeployResult> {
    if (!input.email) return this.recordTerminal(input, runId, 'INVALID_ELIGIBILITY', null, 'no_email', reservedRunId, deployId, draftUrl);
    const fin = finalizeEmailBody(input.email.body, verifiedUrl);
    if (!fin.ok || !fin.resolvedBody) return this.recordTerminal(input, runId, 'VERIFICATION_FAILED', 'NEEDS_MANUAL_REVIEW', `finalize_${fin.reason ?? 'error'}`, reservedRunId, deployId, draftUrl);
    void html;

    // The finalization links to the deployment run that produced the verified URL (the reserved
    // run for a fresh deploy, or the prior verified run for a reuse).
    const finalizedRunId = deploymentRunId;
    await this.deps.uow.transaction(async (repos) => {
      if (reservedRunId) {
        await repos.completeRun(reservedRunId, { outcome, deployId, draftUrl, verifiedUrl, verificationResult: violations, completedAt: new Date(), errorClass: null });
      }
      await repos.createFinalization({
        id: randomUUID(), originalDraftId: input.email!.id, deploymentRunId: finalizedRunId, verifiedDeploymentUrl: verifiedUrl,
        originalBodyHash: fin.originalBodyHash as string, resolvedBody: fin.resolvedBody as string, resolvedBodyHash: fin.resolvedBodyHash as string,
      });
      const lead = await repos.leads.getById(input.leadId);
      if (lead && lead.status === 'WAITING_FOR_DEMO_URL') await repos.leadService.transition(input.leadId, 'FINALIZED_EMAIL_PENDING');
      await repos.events.record({ leadId: input.leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null, message: `deploy: ${outcome} (finalized email pending 2nd review)`, data: { outcome, verifiedUrl } });
    });
    return { leadId: input.leadId, outcome, verifiedUrl };
  }
}
