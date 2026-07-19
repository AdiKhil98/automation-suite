import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadService } from '../../src/domain/leads/lead-service.js';
import {
  ReviewService, type LeadReviewDetail, type ReviewReadRepo, type ReviewTxRepos, type ReviewUnitOfWork, type ReviewWriteRepo,
} from '../../src/domain/review/review-service.js';
import { renderIndex, renderLeadDetail } from '../../src/dashboard/pages.js';
import {
  csrfMatches, isAllowedHost, isSameOrigin, parseFormBody,
} from '../../src/dashboard/security.js';

describe('dashboard security', () => {
  it('allows only loopback hosts', () => {
    expect(isAllowedHost('127.0.0.1:4600')).toBe(true);
    expect(isAllowedHost('localhost:4600')).toBe(true);
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
  it('same-origin requires matching Origin (or Referer) on loopback', () => {
    expect(isSameOrigin({ origin: 'http://127.0.0.1:4600', host: '127.0.0.1:4600' })).toBe(true);
    expect(isSameOrigin({ origin: 'http://evil.com', host: '127.0.0.1:4600' })).toBe(false);
    expect(isSameOrigin({ referer: 'http://127.0.0.1:4600/lead/x', host: '127.0.0.1:4600' })).toBe(true);
    expect(isSameOrigin({ host: '127.0.0.1:4600' })).toBe(false); // no origin, no referer
    expect(isSameOrigin({ origin: 'http://127.0.0.1:4600', host: 'evil.com' })).toBe(false);
  });
  it('csrf compares safely', () => {
    expect(csrfMatches('abc123', 'abc123')).toBe(true);
    expect(csrfMatches('abc123', 'abc124')).toBe(false);
    expect(csrfMatches('abc123', undefined)).toBe(false);
  });
  it('parses urlencoded bodies', () => {
    expect(parseFormBody('csrf=abc&notes=hello+world')).toEqual({ csrf: 'abc', notes: 'hello world' });
  });
});

const detail = (over: Partial<LeadReviewDetail> = {}): LeadReviewDetail => ({
  leadId: 'l1', businessName: 'Zahnärzte am Ufer', city: 'Berlin', leadStatus: 'READY_FOR_HUMAN_APPROVAL',
  facts: [{ factType: 'business_name', value: 'Zahnärzte am Ufer' }],
  findings: [{ findingRef: 'F1', category: 'CTA_CLARITY', severity: 'MEDIUM', observation: 'o', recommendation: 'r' }],
  demo: { id: 'd1', status: 'GENERATED_PENDING_REVIEW', path: '/demos/l1', approvedAt: null, approvedBy: null, approvalNotes: null },
  email: { id: 'e1', subject: 'Hi', body: 'Hello,\n\nbody', ctaKind: 'reply', hasDemoUrlPlaceholder: false, reviewerDecision: 'APPROVE', humanDecision: null, humanNotes: null },
  deployment: null,
  finalizedEmail: null,
  ...over,
});

describe('dashboard pages', () => {
  it('index escapes and links', () => {
    const html = renderIndex([{ leadId: 'l1', businessName: '<script>x</script>', leadStatus: 'READY_FOR_HUMAN_APPROVAL', demoStatus: 'GENERATED_PENDING_REVIEW', emailHumanDecision: null, hasEmail: true }]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('/lead/l1');
  });
  it('detail shows independent demo + email sections with csrf, escapes body', () => {
    const html = renderLeadDetail(detail({ email: { id: 'e1', subject: 'S', body: '<b>x</b>', ctaKind: 'reply', hasDemoUrlPlaceholder: false, reviewerDecision: 'APPROVE', humanDecision: null, humanNotes: null } }), 'TOKEN123');
    expect(html).toContain('Approve demo');
    expect(html).toContain('Approve email');
    expect(html).toContain('value="TOKEN123"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('/demo/l1'); // iframe
  });
  it('shows the WAITING_FOR_DEMO_URL wording-only note', () => {
    const html = renderLeadDetail(detail({ leadStatus: 'WAITING_FOR_DEMO_URL', email: { id: 'e1', subject: 'S', body: 'b', ctaKind: 'demo_link', hasDemoUrlPlaceholder: true, reviewerDecision: 'APPROVE', humanDecision: null, humanNotes: null } }), 'T');
    expect(html).toContain('wording only');
    expect(html).toContain('WAITING_FOR_DEMO_URL');
  });
});

// --- Review service guards + independence ---

interface Model { demo: { id: string; status: string } | null; email: { id: string; humanDecision: string | null } | null; leadStatus: string; transitions: string[]; demoWrites: string[]; emailWrites: string[]; }

function fakeStack(m: Model): { uow: ReviewUnitOfWork; read: ReviewReadRepo } {
  const write: ReviewWriteRepo = {
    async latestDemo() { return m.demo; },
    async latestEmail() { return m.email; },
    async setDemoDecision(_id, dec) { if (m.demo) m.demo.status = dec; m.demoWrites.push(dec); },
    async setEmailHumanDecision(_id, dec) { if (m.email) m.email.humanDecision = dec; m.emailWrites.push(dec); },
    async latestFinalization() { return null; },
    async setFinalizationDecision() { /* noop */ },
  };
  const leadService = { async transition(_id: string, to: string) { m.leadStatus = to; m.transitions.push(to); } } as unknown as LeadService;
  const uow: ReviewUnitOfWork = {
    async transaction(fn) {
      return fn({
        leads: { async getById() { return { id: 'l1', status: m.leadStatus } as unknown as Lead; } } as never,
        leadService, write, events: { async record() { /* noop */ } },
      } as ReviewTxRepos);
    },
  };
  const read: ReviewReadRepo = { async listAwaiting() { return []; }, async detail() { return null; } };
  return { uow, read };
}
const svc = (m: Model) => new ReviewService({ ...fakeStack(m), logger: pino({ level: 'silent' }) });
const model = (over: Partial<Model> = {}): Model => ({ demo: { id: 'd1', status: 'GENERATED_PENDING_REVIEW' }, email: { id: 'e1', humanDecision: null }, leadStatus: 'READY_FOR_HUMAN_APPROVAL', transitions: [], demoWrites: [], emailWrites: [], ...over });

describe('ReviewService', () => {
  it('demo approval only touches the demo; no lead transition, no email write', async () => {
    const m = model();
    expect(await svc(m).decideDemo('l1', 'APPROVED', 'looks good')).toBe('DONE');
    expect(m.demo?.status).toBe('APPROVED');
    expect(m.transitions).toEqual([]);
    expect(m.emailWrites).toEqual([]);
  });
  it('demo re-approval is idempotent', async () => {
    const m = model({ demo: { id: 'd1', status: 'APPROVED' } });
    expect(await svc(m).decideDemo('l1', 'APPROVED', null)).toBe('NOOP_ALREADY');
  });
  it('email approval on READY_FOR_HUMAN_APPROVAL advances the lead; does not touch demo', async () => {
    const m = model();
    expect(await svc(m).decideEmail('l1', 'APPROVED', null)).toBe('DONE');
    expect(m.email?.humanDecision).toBe('APPROVED');
    expect(m.transitions).toEqual(['HUMAN_APPROVED']);
    expect(m.demoWrites).toEqual([]);
  });
  it('email approval on WAITING_FOR_DEMO_URL records wording but keeps the lead waiting', async () => {
    const m = model({ leadStatus: 'WAITING_FOR_DEMO_URL' });
    expect(await svc(m).decideEmail('l1', 'APPROVED', null)).toBe('DONE');
    expect(m.email?.humanDecision).toBe('APPROVED');
    expect(m.transitions).toEqual([]); // not send-ready; stays waiting
    expect(m.leadStatus).toBe('WAITING_FOR_DEMO_URL');
  });
  it('email rejection transitions to REJECTED from either actionable state', async () => {
    for (const s of ['READY_FOR_HUMAN_APPROVAL', 'WAITING_FOR_DEMO_URL']) {
      const m = model({ leadStatus: s });
      expect(await svc(m).decideEmail('l1', 'REJECTED', 'off-tone')).toBe('DONE');
      expect(m.transitions).toEqual(['REJECTED']);
    }
  });
  it('rejects email action from a non-actionable lead state', async () => {
    const m = model({ leadStatus: 'DEMO_READY' });
    expect(await svc(m).decideEmail('l1', 'APPROVED', null)).toBe('INVALID_STATE');
    expect(m.emailWrites).toEqual([]);
  });
});
