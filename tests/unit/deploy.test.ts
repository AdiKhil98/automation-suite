import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { hashCanonical, sha256Hex } from '../../src/utils/hash.js';
import { finalizeEmailBody } from '../../src/domain/deploy/finalize.js';
import { checkEligibility, type EligibilitySnapshot } from '../../src/domain/deploy/eligibility.js';
import { verifyDeployment } from '../../src/domain/deploy/verify.js';
import { buildDeployPackage } from '../../src/domain/deploy/package-builder.js';
import { verifyFetch } from '../../src/domain/deploy/verify-fetch.js';
import {
  DeploymentService, type DeployConfig, type DeploymentRunRecord, type DeployStore, type DeployUnitOfWork, type FinalizationRecord, type VerifyFetchFn,
} from '../../src/domain/deploy/deployment-service.js';
import { MockNetlifyDeploymentProvider } from '../../src/integrations/netlify/mock-netlify.js';

const HOST = 'deploy-preview.netlify.app';
const DEMO_HTML = `<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow,noarchive"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>x — concept redesign (demo)</title></head><body><a class="cta" href="#contact">Get in touch</a><div>concept redesign</div></body></html>`;
const TEMPLATE_ID = 'composer-v1';
const TEMPLATE_VERSION = 'composer-tpl-1';
const ARTIFACT_HASH = hashCanonical({ html: DEMO_HTML, template: TEMPLATE_ID, version: TEMPLATE_VERSION });

describe('finalizeEmailBody', () => {
  it('substitutes exactly one token and hashes both bodies', () => {
    const r = finalizeEmailBody('Hi {{DEMO_URL}} bye', 'https://x--deploy-preview.netlify.app');
    expect(r.ok).toBe(true);
    expect(r.resolvedBody).toBe('Hi https://x--deploy-preview.netlify.app bye');
    expect(r.originalBodyHash).toBe(sha256Hex('Hi {{DEMO_URL}} bye'));
    expect(r.resolvedBodyHash).toBe(sha256Hex(r.resolvedBody as string));
  });
  it('fails without exactly one token or non-https url', () => {
    expect(finalizeEmailBody('no token', 'https://x').ok).toBe(false);
    expect(finalizeEmailBody('{{DEMO_URL}} {{DEMO_URL}}', 'https://x').ok).toBe(false);
    expect(finalizeEmailBody('{{DEMO_URL}}', 'http://x').ok).toBe(false);
  });
});

describe('checkEligibility', () => {
  const base = (): EligibilitySnapshot => ({
    leadStatus: 'WAITING_FOR_DEMO_URL', demo: { status: 'APPROVED', contentHash: ARTIFACT_HASH },
    email: { humanDecision: 'APPROVED', ctaKind: 'demo_link', body: 'x {{DEMO_URL}} y' },
    artifactPresent: true, recomputedArtifactHash: ARTIFACT_HASH, featureEnabled: true, credentialsConfigured: true, existingVerifiedForArtifact: false,
  });
  it('passes when all conditions hold', () => { expect(checkEligibility(base()).eligible).toBe(true); });
  it('fails closed on each broken condition', () => {
    expect(checkEligibility({ ...base(), leadStatus: 'DEMO_READY' }).eligible).toBe(false);
    expect(checkEligibility({ ...base(), demo: { status: 'GENERATED_PENDING_REVIEW', contentHash: ARTIFACT_HASH } }).eligible).toBe(false);
    expect(checkEligibility({ ...base(), email: { humanDecision: null, ctaKind: 'demo_link', body: 'x {{DEMO_URL}}' } }).eligible).toBe(false);
    expect(checkEligibility({ ...base(), email: { humanDecision: 'APPROVED', ctaKind: 'reply', body: 'x {{DEMO_URL}}' } }).eligible).toBe(false);
    expect(checkEligibility({ ...base(), email: { humanDecision: 'APPROVED', ctaKind: 'demo_link', body: 'no token' } }).eligible).toBe(false);
    expect(checkEligibility({ ...base(), recomputedArtifactHash: 'deadbeef' }).reasons).toContain('artifact_hash_mismatch');
    expect(checkEligibility({ ...base(), featureEnabled: false }).eligible).toBe(false);
  });
  it('flags a reusable duplicate instead of failing', () => {
    const r = checkEligibility({ ...base(), existingVerifiedForArtifact: true });
    expect(r.eligible).toBe(false);
    expect(r.duplicateReusable).toBe(true);
  });
});

describe('verifyDeployment', () => {
  const ok = () => ({
    status: 200, finalUrl: `https://abc--${HOST}`, host: `abc--${HOST}`, headers: { 'x-robots-tag': 'noindex' },
    fetchedHtml: DEMO_HTML, localHtml: DEMO_HTML, expectedHostname: HOST, resolvedEmailBody: 'body with https://abc--x.netlify.app',
  });
  it('passes a clean deployment', () => { expect(verifyDeployment(ok()).ok).toBe(true); });
  it('fails on host, status, hash, missing x-robots, placeholder', () => {
    expect(verifyDeployment({ ...ok(), host: 'evil.com' }).violations.some((v) => v.startsWith('unexpected_host'))).toBe(true);
    expect(verifyDeployment({ ...ok(), status: 404 }).violations.some((v) => v.startsWith('status_not_200'))).toBe(true);
    expect(verifyDeployment({ ...ok(), fetchedHtml: DEMO_HTML + '<!--x-->' }).violations).toContain('artifact_hash_mismatch');
    expect(verifyDeployment({ ...ok(), headers: {} }).violations).toContain('missing_x_robots_tag');
    expect(verifyDeployment({ ...ok(), resolvedEmailBody: 'still {{DEMO_URL}}' }).violations).toContain('placeholder_remains');
  });
});

describe('buildDeployPackage', () => {
  async function mkDemo(extra?: (dir: string) => Promise<void>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'deploy-'));
    await writeFile(join(dir, 'index.html'), DEMO_HTML, 'utf8');
    await writeFile(join(dir, 'netlify.toml'), '# noindex headers', 'utf8');
    if (extra) await extra(dir);
    return dir;
  }
  const opts = { maxBytes: 1_000_000, maxFiles: 10, artifactHash: ARTIFACT_HASH };

  it('builds a package from the allowlist', async () => {
    const dir = await mkDemo();
    try {
      const r = await buildDeployPackage(dir, opts);
      expect(r.ok).toBe(true);
      expect(r.pkg?.fileCount).toBe(2);
      expect(r.pkg?.files.map((f) => f.path).sort()).toEqual(['/index.html', '/netlify.toml']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects unexpected, hidden, source-map files and symlinks', async () => {
    const unexpected = await mkDemo((d) => writeFile(join(d, 'evil.js'), 'x'));
    const hidden = await mkDemo((d) => writeFile(join(d, '.secret'), 'x'));
    const map = await mkDemo((d) => writeFile(join(d, 'index.html.map'), 'x'));
    try {
      expect((await buildDeployPackage(unexpected, opts)).violations.some((v) => v.startsWith('unexpected_file'))).toBe(true);
      expect((await buildDeployPackage(hidden, opts)).violations.some((v) => v.startsWith('hidden_file'))).toBe(true);
      expect((await buildDeployPackage(map, opts)).violations.some((v) => v.startsWith('source_map'))).toBe(true);
      // symlink (skip if unsupported on the platform)
      const sdir = await mkDemo();
      try { await symlink(join(sdir, 'index.html'), join(sdir, 'link.html')); await expect(buildDeployPackage(sdir, opts).then((r) => r.violations.some((v) => v.startsWith('symlink') || v.startsWith('unexpected_file')))).resolves.toBe(true); }
      catch { /* symlink not permitted; allowlist still rejects it as unexpected */ }
      finally { await rm(sdir, { recursive: true, force: true }); }
    } finally {
      for (const d of [unexpected, hidden, map]) await rm(d, { recursive: true, force: true });
    }
  });
  it('enforces the file-count cap', async () => {
    const dir = await mkDemo();
    try { expect((await buildDeployPackage(dir, { ...opts, maxFiles: 1 })).violations.some((v) => v.startsWith('too_many_files'))).toBe(true); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('verifyFetch', () => {
  it('rejects non-https before connecting (no network)', async () => {
    const r = await verifyFetch('http://example.com', { timeoutMs: 500, maxRedirects: 0, maxBytes: 1000, resolver: async () => ['93.184.216.34'] });
    expect(r.kind).toBe('policy_blocked');
  });
});

// --- Deployment service (mock provider; fake store/uow; no network) ---

const logger = pino({ level: 'silent' });
const config = (over: Partial<DeployConfig> = {}): DeployConfig => ({
  siteId: 's', expectedHostname: HOST, maxPerDay: 10, minIntervalMs: 0, maxUploadBytes: 1_000_000, maxUploadFiles: 10,
  pollIntervalMs: 0, maxPollAttempts: 3, verifyTimeoutMs: 500, featureEnabled: true, credentialsConfigured: true, ...over,
});

interface Captured { transitions: string[]; finals: FinalizationRecord[]; completes: { id: string; patch: Partial<DeploymentRunRecord> }[]; }
function fakeUow(cap: Captured, leadStatus = 'WAITING_FOR_DEMO_URL'): DeployUnitOfWork {
  return {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'l1', status: leadStatus } as never; } } as never,
        leadService: { async transition(_id: string, to: string) { cap.transitions.push(to); } } as never,
        completeRun: async (id, patch) => { cap.completes.push({ id, patch }); },
        createFinalization: async (row) => { cap.finals.push(row); },
        events: { async record() { /* noop */ } },
      });
    },
  };
}
function fakeStore(over: Partial<DeployStore> = {}): DeployStore {
  return {
    async deployAttemptsToday() { return 0; },
    async lastAttemptAt() { return null; },
    async existingVerified() { return null; },
    async findReservedByFingerprint() { return null; },
    async reserveRun() { /* noop */ },
    async setDeployId() { /* noop */ },
    ...over,
  };
}
async function demoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'svc-'));
  await writeFile(join(dir, 'index.html'), DEMO_HTML, 'utf8');
  await writeFile(join(dir, 'netlify.toml'), '# x', 'utf8');
  return dir;
}
const input = (dir: string, over: Record<string, unknown> = {}) => ({
  leadId: 'l1', leadStatus: 'WAITING_FOR_DEMO_URL', demoDir: dir,
  demo: { id: 'd1', status: 'APPROVED', contentHash: ARTIFACT_HASH, templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION },
  email: { id: 'e1', humanDecision: 'APPROVED', ctaKind: 'demo_link', body: 'Hallo, {{DEMO_URL}} Text' },
  ...over,
});
const okFetch: VerifyFetchFn = (url) => Promise.resolve({ kind: 'ok', status: 200, finalUrl: url, host: new URL(url).host, headers: { 'x-robots-tag': 'noindex' }, body: DEMO_HTML });

describe('DeploymentService (mock)', () => {
  it('deploys, verifies, finalizes the email, and routes to FINALIZED_EMAIL_PENDING', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    try {
      const svc = new DeploymentService({ provider: new MockNetlifyDeploymentProvider({ hostname: HOST }), fetch: okFetch, store: fakeStore(), uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('DEPLOYED_AND_VERIFIED');
      expect(cap.finals).toHaveLength(1);
      expect(cap.finals[0]!.resolvedBody).not.toContain('{{DEMO_URL}}');
      expect(cap.transitions).toEqual(['FINALIZED_EMAIL_PENDING']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('is ineligible when the email wording is not approved (no deploy)', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    const provider = new MockNetlifyDeploymentProvider({ hostname: HOST });
    try {
      const svc = new DeploymentService({ provider, fetch: okFetch, store: fakeStore(), uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir, { email: { id: 'e1', humanDecision: null, ctaKind: 'demo_link', body: '{{DEMO_URL}}' } }), 'run-1');
      expect(r.outcome).toBe('INVALID_ELIGIBILITY');
      expect(provider.created).toHaveLength(0);
      expect(cap.transitions).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reuses an existing verified deployment (DUPLICATE_REUSED)', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    const provider = new MockNetlifyDeploymentProvider({ hostname: HOST });
    try {
      const store = fakeStore({ async existingVerified() { return { runId: 'run-old', deployId: 'old', verifiedUrl: `https://old--${HOST}` }; } });
      const svc = new DeploymentService({ provider, fetch: okFetch, store, uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('DUPLICATE_REUSED');
      expect(provider.created).toHaveLength(0);
      expect(cap.finals).toHaveLength(1);
      expect(cap.transitions).toEqual(['FINALIZED_EMAIL_PENDING']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('fails verification (host mismatch) and routes to manual review', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    try {
      const badFetch: VerifyFetchFn = (url) => Promise.resolve({ kind: 'ok', status: 200, finalUrl: url, host: 'evil.com', headers: { 'x-robots-tag': 'noindex' }, body: DEMO_HTML });
      const svc = new DeploymentService({ provider: new MockNetlifyDeploymentProvider({ hostname: HOST }), fetch: badFetch, store: fakeStore(), uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('VERIFICATION_FAILED');
      expect(cap.transitions).toEqual(['NEEDS_MANUAL_REVIEW']);
      expect(cap.finals).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not create a new deploy when a reserved run already has a deploy id (idempotency)', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    const provider = new MockNetlifyDeploymentProvider({ hostname: HOST });
    try {
      const reserved: DeploymentRunRecord = { id: 'run-x', leadId: 'l1', demoId: 'd1', originalEmailDraftId: 'e1', provider: 'mock-netlify', siteId: 's', deployId: 'existing-deploy', artifactHash: ARTIFACT_HASH, attemptFingerprint: 'fp', outcome: 'DEPLOYMENT_PENDING', draftUrl: null, permalinkUrl: null, verifiedUrl: null, verificationResult: null, errorClass: null, callsMade: 0, startedAt: new Date(), completedAt: null };
      const store = fakeStore({ async findReservedByFingerprint() { return reserved; } });
      const svc = new DeploymentService({ provider, fetch: okFetch, store, uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('DEPLOYED_AND_VERIFIED');
      expect(provider.created).toHaveLength(0); // reused the reserved deploy id
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rate-limited create stays retryable (RATE_LIMITED, no transition)', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    try {
      const provider = new MockNetlifyDeploymentProvider({ hostname: HOST, create: { outcome: 'rate_limited', reason: '429' } });
      const svc = new DeploymentService({ provider, fetch: okFetch, store: fakeStore(), uow: fakeUow(cap), logger, config: config(), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('RATE_LIMITED');
      expect(cap.transitions).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('blocks on the per-day budget', async () => {
    const dir = await demoDir();
    const cap: Captured = { transitions: [], finals: [], completes: [] };
    try {
      const store = fakeStore({ async deployAttemptsToday() { return 10; } });
      const svc = new DeploymentService({ provider: new MockNetlifyDeploymentProvider({ hostname: HOST }), fetch: okFetch, store, uow: fakeUow(cap), logger, config: config({ maxPerDay: 10 }), sleep: async () => {} });
      const r = await svc.deploy(input(dir), 'run-1');
      expect(r.outcome).toBe('BUDGET_BLOCKED');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
