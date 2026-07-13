import { type CaptureTarget, type EmulationProfile, type RenderedCapture } from '../../domain/capture/capture-types.js';
import { type VerifiedOriginPolicy } from '../../domain/capture/verified-origin.js';

export interface CaptureRequest {
  primary: CaptureTarget;
  originPolicy: VerifiedOriginPolicy;
  profiles: EmulationProfile[];
  maxPages: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
  maxScreenshotBytes: number;
  fullPageMaxHeightPx: number;
  blockTrackers: boolean;
  blockMedia: boolean;
}

/** Renders pages and returns rendered DOM + screenshots + neutral errors. Isolated
 * per lead; a fresh non-persistent context per profile; no shared cookies/storage. */
export interface BrowserCaptureProvider {
  readonly name: string;
  capture(req: CaptureRequest): Promise<RenderedCapture>;
}
