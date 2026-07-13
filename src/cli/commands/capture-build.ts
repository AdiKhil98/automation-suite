import { CaptureService } from '../../domain/capture/capture-service.js';
import { MockCaptureProvider } from '../../integrations/capture/mock-capture.js';
import { PlaywrightCaptureProvider } from '../../integrations/capture/playwright-capture.js';
import { LocalFsCaptureStorage } from '../../integrations/capture/local-fs-storage.js';
import { type BrowserCaptureProvider } from '../../integrations/capture/provider.js';
import { mockCapturePages } from '../../fixtures/mock-capture-pages.js';
import { DrizzleCaptureUnitOfWork } from '../../persistence/capture-unit-of-work.js';
import { type CaptureStorageProvider } from '../../integrations/capture/storage.js';
import { type CliContext } from '../context.js';

export interface BuiltCapture {
  service: CaptureService;
  storage: CaptureStorageProvider;
}

export function buildCaptureService(ctx: CliContext): BuiltCapture {
  const c = ctx.config;
  const provider: BrowserCaptureProvider =
    c.CAPTURE_PROVIDER === 'playwright'
      ? new PlaywrightCaptureProvider({ logger: ctx.logger, dockerImageTag: null, allowLoopback: c.CAPTURE_ALLOW_LOOPBACK })
      : new MockCaptureProvider(mockCapturePages);

  const storage = new LocalFsCaptureStorage(c.CAPTURE_ARTIFACT_DIR);
  const service = new CaptureService({
    provider,
    storage,
    uow: new DrizzleCaptureUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: {
      maxPages: c.CAPTURE_MAX_PAGES_PER_LEAD,
      navigationTimeoutMs: c.CAPTURE_NAVIGATION_TIMEOUT_MS,
      totalTimeoutMs: c.CAPTURE_TOTAL_TIMEOUT_MS,
      maxScreenshotBytes: c.CAPTURE_MAX_SCREENSHOT_BYTES,
      fullPageMaxHeightPx: c.CAPTURE_FULLPAGE_MAX_HEIGHT_PX,
      blockTrackers: c.CAPTURE_BLOCK_TRACKERS,
      blockMedia: c.CAPTURE_BLOCK_MEDIA,
      minConfidence: c.ENRICHMENT_MIN_CONFIDENCE,
      ambiguousMargin: c.ENRICHMENT_AMBIGUOUS_MARGIN,
    },
  });
  return { service, storage };
}
