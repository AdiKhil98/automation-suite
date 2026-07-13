/** Deterministic viewport/emulation profile applied to an isolated browser context. */
export const EMULATION_PROFILE_VERSION = 'cap-emu-1';

export interface EmulationProfile {
  profile: 'desktop' | 'mobile';
  width: number;
  height: number;
  userAgent: string;
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  version: string;
}

export const DESKTOP_PROFILE: EmulationProfile = {
  profile: 'desktop',
  width: 1440,
  height: 900,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  version: EMULATION_PROFILE_VERSION,
};

export const MOBILE_PROFILE: EmulationProfile = {
  profile: 'mobile',
  width: 390,
  height: 844,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  version: EMULATION_PROFILE_VERSION,
};

/** A screenshot produced by a capture, as raw bytes + metadata (pre-storage). */
export interface Screenshot {
  profile: 'desktop' | 'mobile';
  kind: 'viewport' | 'fullpage';
  bytes: Buffer;
  mime: 'image/png';
  width: number;
  height: number;
}

/** Neutral, deterministic error/event recorded during capture. No subjectivity. */
export interface CaptureError {
  pageUrl: string | null;
  profile: 'desktop' | 'mobile' | null;
  kind:
    | 'console_error'
    | 'failed_request'
    | 'navigation_timeout'
    | 'blocked_request'
    | 'download_blocked'
    | 'popup_blocked'
    | 'dialog_dismissed'
    | 'cross_domain_redirect'
    | 'bot_challenge'
    | 'auth_required';
  detail: string;
}

/** One rendered page for one profile (what a BrowserCaptureProvider returns). */
export interface RenderedPage {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string | null;
  httpStatus: number;
  profile: 'desktop' | 'mobile';
  ok: boolean;
  html: string; // rendered DOM (page.content()); not persisted — used for extraction/hash only
  loadMs: number;
  hasHorizontalOverflow: boolean; // layout metric from the browser (scrollWidth > clientWidth)
  screenshots: Screenshot[];
  errors: CaptureError[];
}

/** The provider's result for one lead across profiles/pages. */
export interface RenderedCapture {
  pages: RenderedPage[];
  errors: CaptureError[];
  browser: BrowserInfo;
}

export interface BrowserInfo {
  playwrightVersion: string;
  browser: string; // chromium
  browserVersion: string | null;
  chromiumRevision: string | null;
  dockerImageTag: string | null;
}

export interface CaptureTarget {
  url: string;
  role: 'primary' | 'contact' | 'about' | 'services' | 'booking' | 'location';
}
