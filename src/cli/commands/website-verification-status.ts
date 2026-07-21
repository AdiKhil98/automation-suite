import { EnrichmentRepository } from '../../persistence/repositories/enrichment.repo.js';
import { type CliContext } from '../context.js';

export async function websiteVerificationStatusCommand(
  ctx: CliContext,
  opts: { lead: string },
): Promise<void> {
  const attempt = await new EnrichmentRepository(ctx.db).latestVerificationForLead(opts.lead);
  if (!attempt) {
    console.log('website_verification_status=none');
    return;
  }

  console.log(`attempted_at=${attempt.attemptedAt.toISOString()}`);
  console.log(`hostname=${attempt.hostname ?? 'unknown'}`);
  console.log(`classification=${attempt.finalClassification}`);
  console.log(`failure_stage=${attempt.failureStage ?? 'none'}`);
  console.log(`error_code=${attempt.errorCode ?? 'none'}`);
  console.log(`http_status=${attempt.httpStatus ?? 'none'}`);
  console.log(`redirect_count=${attempt.redirectCount}`);
  console.log(`elapsed_ms=${attempt.elapsedMs}`);
  console.log(`resolved_ip_family=${attempt.resolvedIpFamily ?? 'unknown'}`);
  console.log(`retryable=${attempt.retryable}`);
}
