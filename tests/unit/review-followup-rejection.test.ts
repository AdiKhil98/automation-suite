import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  ReviewService,
  type ReviewReadRepo,
  type ReviewTxRepos,
  type ReviewUnitOfWork,
  type ReviewWriteRepo,
} from '../../src/domain/review/review-service.js';
import { LeadService, type EventRecorder, type LeadStore } from '../../src/domain/leads/lead-service.js';
import { type Lead } from '../../src/domain/leads/lead.js';
import { type LeadStatus } from '../../src/domain/leads/status.js';
import { type NewPipelineEvent } from '../../src/domain/pipeline/pipeline-event.js';

/**
 * REJECTING FOLLOW-UP COPY RETURNS THE LEAD TO SENT — against the REAL state machine.
 *
 * PRODUCTION: `ReviewService.decideEmail(lead, 'REJECTED')` on a Follow-up #2 threw
 * `InvalidStateTransitionError: READY_FOR_HUMAN_APPROVAL -> SENT`. The transaction rolled back, so
 * the draft kept `human_decision = null` and the operator could not reject the copy at all.
 *
 * The service was right and the transition table was wrong. The existing unit coverage missed it
 * because its `leadService` was a permissive fake that recorded whatever it was asked to do — it
 * could never have caught an illegal edge. THESE tests drive the REAL `LeadService`, so every
 * transition is checked by the real state machine exactly as production checks it.
 */

interface World {
  leadStatus: LeadStatus;
  email: { id: string; humanDecision: string | null; sequenceStep: number } | null;
  emailDecisions: Array<{ decision: string; notes: string | null; actor: string; at: Date }>;
  transitions: LeadStatus[];
  events: NewPipelineEvent[];
}

const world = (over: Partial<World> = {}): World => ({
  leadStatus: 'READY_FOR_HUMAN_APPROVAL',
  email: { id: 'draft-1', humanDecision: null, sequenceStep: 1 },
  emailDecisions: [],
  transitions: [],
  events: [],
  ...over,
});

/**
 * The service under test, wired to the REAL LeadService over an in-memory store. A rolled-back
 * transaction is simulated the way the Drizzle unit of work behaves: the callback throws, and the
 * world is restored to its pre-transaction snapshot.
 */
function service(w: World): ReviewService {
  const store: LeadStore = {
    async create() { /* unused */ },
    async getById() { return { id: 'lead-1', status: w.leadStatus } as unknown as Lead; },
    async updateStatus(_id, status) { w.leadStatus = status; w.transitions.push(status); },
  };
  const events: EventRecorder = { async record(e) { w.events.push(e); } };
  const leadService = new LeadService(store, events);

  const write: ReviewWriteRepo = {
    async latestDemo() { return null; },
    async latestEmail() { return w.email; },
    async setDemoDecision() { /* unused */ },
    async setEmailHumanDecision(_id, decision, notes, actor, now) {
      if (w.email) w.email.humanDecision = decision;
      w.emailDecisions.push({ decision, notes, actor, at: now });
    },
    async latestFinalization() { return null; },
    async setFinalizationDecision() { /* unused */ },
  };

  const uow: ReviewUnitOfWork = {
    async transaction(fn) {
      const snapshot: World = {
        ...w,
        email: w.email ? { ...w.email } : null,
        emailDecisions: [...w.emailDecisions],
        transitions: [...w.transitions],
        events: [...w.events],
      };
      try {
        return await fn({
          leads: { async getById() { return { id: 'lead-1', status: w.leadStatus } as unknown as Lead; } } as never,
          leadService,
          write,
          events: { async record(e) { w.events.push(e); } },
        } as ReviewTxRepos);
      } catch (err) {
        // ROLLBACK: nothing the callback wrote survives a throw.
        Object.assign(w, snapshot);
        throw err;
      }
    },
  };

  const read: ReviewReadRepo = { async listAwaiting() { return []; }, async detail() { return null; } };
  return new ReviewService({ uow, read, logger: pino({ level: 'silent' }), actor: 'operator' });
}

describe('rejecting a FOLLOW-UP draft (real state machine)', () => {
  it('records the rejection and returns the lead to SENT', async () => {
    const w = world();

    const result = await service(w).decideEmail('lead-1', 'REJECTED', 'restates the first email');

    expect(result).toBe('DONE');
    // The verdict lands on the DRAFT...
    expect(w.email?.humanDecision).toBe('REJECTED');
    expect(w.emailDecisions).toHaveLength(1);
    expect(w.emailDecisions[0]?.notes).toBe('restates the first email');
    expect(w.emailDecisions[0]?.actor).toBe('operator');
    // ...with the review timestamp written.
    expect(w.emailDecisions[0]?.at).toBeInstanceOf(Date);

    // ...and the LEAD returns to where it stood before the sequence re-entry.
    expect(w.leadStatus).toBe('SENT');
    expect(w.transitions).toEqual(['SENT']);
  });

  it('never rejects the prospect', async () => {
    const w = world();
    await service(w).decideEmail('lead-1', 'REJECTED', null);

    expect(w.transitions).not.toContain('REJECTED');
    expect(w.leadStatus).not.toBe('REJECTED');
    // REJECTED is terminal apart from an audited reopen; a live, already-contacted prospect must
    // never be destroyed by one unsatisfactory draft.
  });

  it('records the return to SENT on the immutable timeline', async () => {
    const w = world();
    await service(w).decideEmail('lead-1', 'REJECTED', 'restates the first email');

    const transition = w.events.find((e) => e.type === 'STATE_TRANSITION' && e.toStatus === 'SENT');
    expect(transition).toBeDefined();
    expect(transition?.fromStatus).toBe('READY_FOR_HUMAN_APPROVAL');

    // ...and the decision note says, in the timeline itself, that this rejected the COPY and that
    // the lead was returned rather than rejected.
    const note = w.events.find((e) => e.type === 'NOTE' && (e.message ?? '').startsWith('email rejected'));
    expect(note).toBeDefined();
    expect(note?.message).toContain('outreach follow-up step 1');
    expect(note?.message).toContain('lead returned to SENT, NOT rejected');
    expect(note?.data).toMatchObject({ decision: 'REJECTED', sequenceStep: 1 });
  });

  it.each([1, 2, 3])('applies to every follow-up step (step %i)', async (sequenceStep) => {
    const w = world({ email: { id: 'draft-1', humanDecision: null, sequenceStep } });
    expect(await service(w).decideEmail('lead-1', 'REJECTED', null)).toBe('DONE');
    expect(w.leadStatus).toBe('SENT');
  });

  it('would have thrown before the missing edge was added', async () => {
    // The production failure, reproduced through the real machine: the service asks for
    // READY_FOR_HUMAN_APPROVAL -> SENT, and the table has to permit it. If that edge is ever removed
    // this test fails with the exact InvalidStateTransitionError production saw.
    const w = world();
    await expect(service(w).decideEmail('lead-1', 'REJECTED', null)).resolves.toBe('DONE');
  });
});

describe('rejecting a FIRST email is unchanged', () => {
  it('rejects the LEAD, not just the copy', async () => {
    const w = world({ email: { id: 'draft-0', humanDecision: null, sequenceStep: 0 } });

    expect(await service(w).decideEmail('lead-1', 'REJECTED', 'not worth sending')).toBe('DONE');

    expect(w.email?.humanDecision).toBe('REJECTED');
    expect(w.leadStatus).toBe('REJECTED');
    expect(w.transitions).toEqual(['REJECTED']);
    expect(w.transitions).not.toContain('SENT');
  });

  it('approval still advances a follow-up to HUMAN_APPROVED', async () => {
    const w = world();
    expect(await service(w).decideEmail('lead-1', 'APPROVED', null)).toBe('DONE');
    expect(w.leadStatus).toBe('HUMAN_APPROVED');
  });
});

describe('the decision and the lead transition commit together', () => {
  it('a failed lead transition leaves the draft decision uncommitted', async () => {
    // Exactly what production demonstrated: the transition threw and the whole transaction rolled
    // back, so `human_decision` and `human_reviewed_at` stayed null rather than recording a decision
    // whose consequence never happened.
    const w = world({ leadStatus: 'HUMAN_APPROVED' }); // not an actionable review state...
    const blocked = world({ email: { id: 'draft-1', humanDecision: null, sequenceStep: 1 } });

    // ...so nothing is written at all.
    expect(await service(w).decideEmail('lead-1', 'REJECTED', null)).not.toBe('DONE');
    expect(w.email?.humanDecision).toBeNull();
    expect(w.emailDecisions).toEqual([]);

    // And when the transition itself fails mid-transaction, the rollback restores everything.
    const store: LeadStore = {
      async create() { /* unused */ },
      async getById() { return { id: 'lead-1', status: blocked.leadStatus } as unknown as Lead; },
      async updateStatus() { throw new Error('database unavailable'); },
    };
    const leadService = new LeadService(store, { async record(e) { blocked.events.push(e); } });
    const uow: ReviewUnitOfWork = {
      async transaction(fn) {
        const snapshot = { email: blocked.email ? { ...blocked.email } : null, decisions: [...blocked.emailDecisions] };
        try {
          return await fn({
            leads: { async getById() { return { id: 'lead-1', status: blocked.leadStatus } as unknown as Lead; } } as never,
            leadService,
            write: {
              async latestDemo() { return null; },
              async latestEmail() { return blocked.email; },
              async setDemoDecision() { /* unused */ },
              async setEmailHumanDecision(_id, decision) {
                if (blocked.email) blocked.email.humanDecision = decision;
                blocked.emailDecisions.push({ decision, notes: null, actor: 'operator', at: new Date() });
              },
              async latestFinalization() { return null; },
              async setFinalizationDecision() { /* unused */ },
            } as ReviewWriteRepo,
            events: { async record(e) { blocked.events.push(e); } },
          } as ReviewTxRepos);
        } catch (err) {
          blocked.email = snapshot.email;
          blocked.emailDecisions = snapshot.decisions;
          throw err;
        }
      },
    };
    const svc = new ReviewService({ uow, read: { async listAwaiting() { return []; }, async detail() { return null; } }, logger: pino({ level: 'silent' }), actor: 'operator' });

    await expect(svc.decideEmail('lead-1', 'REJECTED', null)).rejects.toThrow('database unavailable');
    expect(blocked.email?.humanDecision).toBeNull();
    expect(blocked.emailDecisions).toEqual([]);
  });
});
