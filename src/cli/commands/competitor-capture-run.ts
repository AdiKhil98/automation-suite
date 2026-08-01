import { CompetitorCaptureService, type CaptureRunInput } from '../../domain/competitor/capture-service.js';
import { type CaptureMethod, type CaptureProvider } from '../../domain/competitor/capture-constants.js';
import { DrizzleCompetitorCaptureUnitOfWork } from '../../persistence/competitor-capture-unit-of-work.js';
import { type BrowserCaptureProvider } from '../../integrations/capture/provider.js';
import { type CliContext } from '../context.js';
import {
  buildCaptureConfig,
  buildFixtureProvider,
  buildLiveProvider,
  getProspectDomain,
  resolveResearchRun,
} from './competitor-capture-build.js';

export interface CompetitorCaptureRunOptions {
  lead?: string;
  researchRun?: string;
  fixture?: string;
  provider?: string;
  apply?: boolean;
  confirmLiveCapture?: boolean;
}

/**
 * Phase 7A2: capture narrow, reproducible presence/absence evidence from selected competitors' public
 * pages. Fixture mode (offline) + dry report are the defaults. Persisting a fixture run requires
 * --apply. A LIVE capture requires COMPETITOR_CAPTURE_ENABLED=true + provider=playwright +
 * --confirm-live-capture; any missing guard exits nonzero and NEVER falls back to fixtures. Never
 * composes email, calls AI, or touches Gmail/Sheets/sending.
 */
export async function competitorCaptureRunCommand(ctx: CliContext, opts: CompetitorCaptureRunOptions): Promise<void> {
  if (!opts.lead) {
    console.error('Provide --lead <lead-id>.');
    process.exitCode = 1;
    return;
  }
  const lead = await ctx.leads.getById(opts.lead);
  if (!lead) {
    console.error(`Lead not found: ${opts.lead}`);
    process.exitCode = 1;
    return;
  }

  const requestedProvider = opts.provider ?? ctx.config.COMPETITOR_CAPTURE_PROVIDER;
  const wantsLive = requestedProvider === 'playwright';

  // Fail-closed live guards (the service re-checks, but we refuse early with a clear message).
  if (wantsLive) {
    if (!ctx.config.COMPETITOR_CAPTURE_ENABLED) {
      console.error('Refusing LIVE capture: COMPETITOR_CAPTURE_ENABLED=false. Live capture is disabled by default.');
      process.exitCode = 1;
      return;
    }
    if (!opts.confirmLiveCapture) {
      console.error('Refusing LIVE capture: pass --confirm-live-capture to explicitly authorize a real browser capture.');
      process.exitCode = 1;
      return;
    }
  } else if (opts.confirmLiveCapture) {
    console.error('--confirm-live-capture is only valid with --provider playwright.');
    process.exitCode = 1;
    return;
  }

  const resolved = await resolveResearchRun(ctx, opts.lead, opts.researchRun);
  if (!resolved) {
    console.error('No persisted competitor-research run found. Run competitor-research-run --apply first.');
    process.exitCode = 1;
    return;
  }

  const method: CaptureMethod = wantsLive ? 'LIVE_BROWSER' : 'FIXTURE';
  const provider: CaptureProvider = wantsLive ? 'playwright' : 'fixture';

  let browserProvider: BrowserCaptureProvider;
  try {
    if (wantsLive) {
      browserProvider = buildLiveProvider(ctx);
    } else {
      if (!opts.fixture) {
        console.error('Fixture mode requires --fixture <path> (a local HTML fixture JSON).');
        process.exitCode = 1;
        return;
      }
      browserProvider = await buildFixtureProvider(opts.fixture);
    }
  } catch (err) {
    console.error(`Provider setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const prospectDomain = await getProspectDomain(ctx, opts.lead);
  const service = new CompetitorCaptureService({
    provider: browserProvider,
    uow: new DrizzleCompetitorCaptureUnitOfWork(ctx.db),
    config: buildCaptureConfig(ctx.config),
  });

  const input: CaptureRunInput = {
    leadId: opts.lead,
    researchRunId: resolved.runId,
    prospectNormalizedDomain: prospectDomain,
    competitors: resolved.competitors,
    method,
    provider,
    liveEnabled: ctx.config.COMPETITOR_CAPTURE_ENABLED,
    liveConfirmed: opts.confirmLiveCapture === true,
    apply: opts.apply === true,
  };

  let res;
  try {
    res = await service.run(input);
  } catch (err) {
    console.error(`Capture failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nCompetitor capture ${opts.apply ? 'APPLY' : 'DRY REPORT'} — lead ${lead.id}`);
  console.log(`  research run: ${resolved.runId}  method: ${method}  provider: ${provider}`);
  console.log(`  outcome: ${res.outcome}  eligible: ${String(res.eligibility.filter((e) => e.eligible).length)}/${String(res.eligibility.length)}`);
  console.log(`  pages: ${String(res.pages.length)}  evidence: ${String(res.evidence.length)} (active ${String(res.evidence.filter((e) => e.active).length)}, safe-for-outreach ${String(res.evidence.filter((e) => e.safeForOutreach).length)})`);
  console.log(`  contentHash: ${res.contentHash.slice(0, 12)}`);

  console.log('\n  Active evidence:');
  const active = res.evidence.filter((e) => e.active);
  if (active.length === 0) console.log('    (none)');
  for (const e of active) {
    console.log(`    [${e.confidence}] ${e.evidenceCategory} (${e.profile}) — ${e.observation}`);
    console.log(`        ${e.sourcePageUrl}  freshness=${e.freshnessStatus}  safe=${String(e.safeForOutreach)}`);
  }
  const withheld = res.evidence.filter((e) => !e.active);
  if (withheld.length > 0) {
    console.log('\n  Withheld evidence:');
    for (const e of withheld) console.log(`    ${e.evidenceCategory} (${e.profile}) — ${e.withholdingReason ?? 'withheld'}`);
  }

  if (opts.apply) {
    if (res.reusedExisting) {
      console.log(`\n  Idempotent: identical capture already persisted as run ${res.runRecordId ?? ''} (v${String(res.version)}). No duplicate created.`);
    } else if (res.persisted) {
      console.log(`\n  Persisted DRAFT capture run ${res.runRecordId ?? ''} (v${String(res.version)}). Prior DRAFT runs superseded (not deleted).`);
    }
  } else {
    console.log('\n  Dry report — no database writes were performed. No comparative pattern or email wording was produced.');
  }
}
