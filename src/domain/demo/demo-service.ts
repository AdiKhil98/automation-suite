import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import { type LeadFact } from '../lead-facts/lead-fact.js';
import { type LeadService, type LeadStore } from '../leads/lead-service.js';
import { type NewPipelineEvent } from '../pipeline/pipeline-event.js';
import { buildDemo, type DemoBuildInput } from './demo-builder.js';
import { DEMO_BRIEF_RULES_VERSION, type DemoOutcome, type DemoStatus } from './demo-types.js';
import { type DemoDecisionConfig } from './demo-decision.js';

export interface DemoConfig extends DemoDecisionConfig {
  templateId: string;
  templateVersion: string;
}

export interface DemoPersist {
  decision: {
    id: string;
    leadId: string;
    runId: string;
    decision: 'BUILD_DEMO' | 'NO_DEMO';
    outcome: DemoOutcome;
    reason: string;
    opportunityScore: number | null;
    minOpportunity: number;
    justifiedByScore: boolean;
    justifiedByFinding: boolean;
    briefRulesVersion: string;
  };
  demo: {
    id: string;
    leadId: string;
    demoDecisionId: string;
    templateId: string;
    templateVersion: string;
    path: string;
    status: DemoStatus;
    noindexVerified: boolean;
    disclosurePresent: boolean;
    contentHash: string | null;
    ctaKind: string | null;
    factsUsed: unknown;
    findingRefs: unknown;
  } | null;
  factInputs: Array<{ id: string; demoId: string; leadFactId: string; field: string }>;
  findingInputs: Array<{ id: string; demoId: string; auditFindingId: string; directive: string }>;
}

export interface DemoRunStore {
  persist(record: DemoPersist): Promise<void>;
}
export interface DemoTxRepos {
  leads: LeadStore;
  leadService: LeadService;
  demos: DemoRunStore;
  events: { record(e: NewPipelineEvent): Promise<void> };
}
export interface DemoUnitOfWork {
  transaction<T>(fn: (repos: DemoTxRepos) => Promise<T>): Promise<T>;
}

/** Writes the generated demo files to a per-lead directory; returns the directory path. */
export interface DemoOutputWriter {
  write(leadId: string, files: Record<string, string>): Promise<string>;
}

export interface DemoServiceDeps {
  uow: DemoUnitOfWork;
  writer: DemoOutputWriter;
  logger: Logger;
  config: DemoConfig;
}

export interface DemoInput {
  leadId: string;
  facts: LeadFact[];
  opportunityScore: number | null;
  findings: DemoBuildInput['findings'];
}

export interface DemoResult {
  leadId: string;
  outcome: DemoOutcome;
  demoPath: string | null;
}

/**
 * Orchestrates one lead's demo: decide → build (pure) → write files → persist decision,
 * demo record, and RELATIONAL provenance (fact/finding inputs), then route the lead
 * state. Generation is separate from approval — a built demo is GENERATED_PENDING_REVIEW
 * and the lead reaches DEMO_READY; nothing is published.
 */
export class DemoService {
  constructor(private readonly deps: DemoServiceDeps) {}

  async generate(input: DemoInput, runId: string): Promise<DemoResult> {
    const c = this.deps.config;
    const build = buildDemo(
      { opportunityScore: input.opportunityScore, findings: input.findings, facts: input.facts },
      { minOpportunityForDemo: c.minOpportunityForDemo },
    );

    const decisionId = randomUUID();
    const decision: DemoPersist['decision'] = {
      id: decisionId,
      leadId: input.leadId,
      runId,
      decision: build.decision.kind,
      outcome: build.outcome,
      reason: build.decision.reason,
      opportunityScore: input.opportunityScore,
      minOpportunity: c.minOpportunityForDemo,
      justifiedByScore: build.decision.justifiedByScore,
      justifiedByFinding: build.decision.justifiedByFinding,
      briefRulesVersion: DEMO_BRIEF_RULES_VERSION,
    };

    // NO_DEMO: record the decision, advance to DEMO_DECIDED, stop.
    if (build.decision.kind === 'NO_DEMO') {
      await this.persist({ decision, demo: null, factInputs: [], findingInputs: [] }, input.leadId, runId, false);
      return { leadId: input.leadId, outcome: build.outcome, demoPath: null };
    }

    // BUILD_DEMO but validation failed: record a BUILD_FAILED demo, stay at DEMO_DECIDED.
    if (build.outcome === 'VALIDATION_FAILED' || !build.built) {
      this.deps.logger.warn({ leadId: input.leadId, violations: build.violations }, 'demo validation failed');
      const demoId = randomUUID();
      await this.persist(
        {
          decision,
          demo: {
            id: demoId, leadId: input.leadId, demoDecisionId: decisionId, templateId: c.templateId, templateVersion: c.templateVersion,
            path: '', status: 'BUILD_FAILED', noindexVerified: false, disclosurePresent: false, contentHash: null, ctaKind: null,
            factsUsed: null, findingRefs: (build.violations ?? []),
          },
          factInputs: [], findingInputs: [],
        },
        input.leadId, runId, false,
      );
      return { leadId: input.leadId, outcome: 'VALIDATION_FAILED', demoPath: null };
    }

    // DEMO_BUILT: write files (outside the tx), then persist + reach DEMO_READY.
    const { built, brief } = build;
    const path = await this.deps.writer.write(input.leadId, { 'index.html': built.html, 'netlify.toml': built.netlifyToml });
    const demoId = randomUUID();
    await this.persist(
      {
        decision,
        demo: {
          id: demoId, leadId: input.leadId, demoDecisionId: decisionId, templateId: c.templateId, templateVersion: c.templateVersion,
          path, status: 'GENERATED_PENDING_REVIEW',
          noindexVerified: true, disclosurePresent: true, contentHash: built.contentHash, ctaKind: built.content.cta.kind,
          factsUsed: built.content.factInputs.map((fi) => ({ factType: fi.factType, field: fi.field })),
          findingRefs: brief?.findingInputs.map((f) => f.findingRef) ?? [],
        },
        factInputs: built.content.factInputs.map((fi) => ({ id: randomUUID(), demoId, leadFactId: fi.factId, field: fi.field })),
        findingInputs: (brief?.findingInputs ?? []).map((f) => ({ id: randomUUID(), demoId, auditFindingId: f.findingId, directive: f.directive })),
      },
      input.leadId, runId, true,
    );
    return { leadId: input.leadId, outcome: 'DEMO_BUILT', demoPath: path };
  }

  private async persist(record: DemoPersist, leadId: string, runId: string, reachedDemoReady: boolean): Promise<void> {
    await this.deps.uow.transaction(async (repos) => {
      const lead = await repos.leads.getById(leadId);
      if (lead && lead.status === 'OPPORTUNITY_READY') {
        await repos.leadService.transition(leadId, 'DEMO_DECIDED');
        if (reachedDemoReady) await repos.leadService.transition(leadId, 'DEMO_READY');
      }
      await repos.demos.persist(record);
      await repos.events.record({
        leadId, runId, type: 'NOTE', fromStatus: null, toStatus: null,
        message: `demo: ${record.decision.outcome}${record.demo?.path ? ` (${record.demo.path})` : ''}`,
        data: { demoDecisionId: record.decision.id, outcome: record.decision.outcome },
      });
    });
  }
}
