import { DEFAULT_MAX_AGE_DAYS } from './capture-constants.js';
import { type FreshnessStatus } from './evidence-types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-day age of an evidence item at `now` (floored). */
export function ageInDays(capturedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - capturedAt.getTime()) / MS_PER_DAY);
}

/**
 * Deterministic freshness evaluation. Evidence is FRESH for `maxAgeDays` days after capture; on/after
 * that boundary it is STALE and can no longer support outreach. This is computed from timestamps —
 * never trusted solely from a stored status — so an item that has aged past the window is always
 * treated as stale even if it was persisted FRESH.
 */
export function evaluateFreshness(capturedAt: Date, now: Date, maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): FreshnessStatus {
  return ageInDays(capturedAt, now) >= maxAgeDays ? 'STALE' : 'FRESH';
}
