import { DeploymentService, type VerifyFetchFn } from '../../domain/deploy/deployment-service.js';
import { verifyFetch } from '../../domain/deploy/verify-fetch.js';
import { HttpNetlifyDeploymentProvider } from '../../integrations/netlify/http-netlify.js';
import { MockNetlifyDeploymentProvider } from '../../integrations/netlify/mock-netlify.js';
import { type NetlifyDeploymentProvider } from '../../integrations/netlify/provider.js';
import { DrizzleDeployUnitOfWork } from '../../persistence/deploy-unit-of-work.js';
import { DeployRepository } from '../../persistence/repositories/deploy.repo.js';
import { type CliContext } from '../context.js';

export interface BuiltDeploy {
  service: DeploymentService;
  providerName: string;
  live: boolean;
}

/**
 * Build the deployment service. A REAL Netlify deploy requires
 * NETLIFY_DEPLOYMENT_ENABLED=true AND NETLIFY_AUTH_TOKEN AND NETLIFY_SITE_ID AND
 * NETLIFY_EXPECTED_HOSTNAME. Otherwise the mock provider is used (no network). The API origin
 * is fixed in the adapter; the token is never logged or persisted.
 */
export function buildDeploymentService(ctx: CliContext): BuiltDeploy {
  const c = ctx.config;
  const live = c.NETLIFY_DEPLOYMENT_ENABLED && !!c.NETLIFY_AUTH_TOKEN && !!c.NETLIFY_SITE_ID && !!c.NETLIFY_EXPECTED_HOSTNAME;

  let provider: NetlifyDeploymentProvider;
  if (live) {
    provider = new HttpNetlifyDeploymentProvider({ token: c.NETLIFY_AUTH_TOKEN as string, logger: ctx.logger, timeoutMs: c.NETLIFY_DEPLOY_TIMEOUT_MS });
  } else {
    provider = new MockNetlifyDeploymentProvider({ hostname: c.NETLIFY_EXPECTED_HOSTNAME ?? 'deploy-preview.netlify.app' });
  }

  const fetch: VerifyFetchFn = (url) => verifyFetch(url, { timeoutMs: c.NETLIFY_DEPLOY_TIMEOUT_MS, maxRedirects: 3, maxBytes: c.NETLIFY_MAX_UPLOAD_BYTES });

  const service = new DeploymentService({
    provider,
    fetch,
    store: new DeployRepository(ctx.db),
    uow: new DrizzleDeployUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: {
      siteId: c.NETLIFY_SITE_ID ?? 'mock-site',
      expectedHostname: c.NETLIFY_EXPECTED_HOSTNAME ?? 'deploy-preview.netlify.app',
      maxPerDay: c.NETLIFY_MAX_DEPLOYMENTS_PER_DAY,
      minIntervalMs: c.NETLIFY_MIN_DEPLOY_INTERVAL_MS,
      maxUploadBytes: c.NETLIFY_MAX_UPLOAD_BYTES,
      maxUploadFiles: c.NETLIFY_MAX_UPLOAD_FILES,
      pollIntervalMs: c.NETLIFY_POLL_INTERVAL_MS,
      maxPollAttempts: c.NETLIFY_MAX_POLL_ATTEMPTS,
      verifyTimeoutMs: c.NETLIFY_DEPLOY_TIMEOUT_MS,
      featureEnabled: c.NETLIFY_DEPLOYMENT_ENABLED,
      credentialsConfigured: live,
    },
  });
  return { service, providerName: provider.name, live };
}
