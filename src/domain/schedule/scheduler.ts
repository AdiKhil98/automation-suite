import { utcToLocal, zonedWallClockToUtc } from './timezone.js';

/** Operator-configured scheduling policy (deterministic; not a universal best practice). */
export interface SchedulingRules {
  windowStartHour: number; // recipient-local, 0-23
  windowEndHour: number; // recipient-local, 1-24 (exclusive)
  allowedWeekdays: number[]; // ISO 1=Mon..7=Sun
  minSpacingMinutes: number;
  dailyCap: number;
  earliestOffsetMinutes: number;
  horizonDays: number;
}

export interface SlotResult {
  ok: boolean;
  scheduledAtUtc?: number;
  reason?: string;
}

/**
 * Compute the earliest allowed send slot for a recipient (fail-closed, deterministic). Searches
 * the recipient-local business window on allowed weekdays, at `minSpacing` grid steps, honoring
 * an earliest-not-before, a per-recipient-local-day cap, and minimum spacing from every existing
 * scheduled send (account-wide, in UTC). DST-correct via zonedWallClockToUtc. Returns the first
 * qualifying UTC instant, or `{ ok:false, reason:'blocked' }` if none within the horizon.
 */
export function computeNextSlot(opts: { nowMs: number; tz: string; rules: SchedulingRules; existingUtcMs: number[]; notBeforeMs?: number }): SlotResult {
  const { nowMs, tz, rules, existingUtcMs } = opts;
  const spacingMs = rules.minSpacingMinutes * 60_000;
  const earliest = Math.max(nowMs + rules.earliestOffsetMinutes * 60_000, opts.notBeforeMs ?? 0);
  const allowed = new Set(rules.allowedWeekdays);

  const startLocal = utcToLocal(tz, earliest); // recipient-local date to begin scanning
  const base = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day); // date-only anchor

  for (let dayIdx = 0; dayIdx <= rules.horizonDays; dayIdx += 1) {
    const d = new Date(base + dayIdx * 86_400_000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const dom = d.getUTCDate();
    const weekdayIso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (!allowed.has(weekdayIso)) continue;

    // Count existing sends already scheduled on this recipient-local day (cap check).
    const onThisLocalDay = existingUtcMs.filter((e) => {
      const l = utcToLocal(tz, e);
      return l.year === y && l.month === mo && l.day === dom;
    }).length;
    if (onThisLocalDay >= rules.dailyCap) continue;

    for (let mins = rules.windowStartHour * 60; mins < rules.windowEndHour * 60; mins += rules.minSpacingMinutes) {
      const candidate = zonedWallClockToUtc(tz, y, mo, dom, Math.floor(mins / 60), mins % 60);
      if (candidate < earliest) continue;
      const tooClose = existingUtcMs.some((e) => Math.abs(candidate - e) < spacingMs);
      if (tooClose) continue;
      return { ok: true, scheduledAtUtc: candidate };
    }
  }
  return { ok: false, reason: 'blocked' };
}

/**
 * Validate an operator-requested slot (for --at reschedules) against the same deterministic
 * rules: not in the past / before earliest, allowed weekday, inside the recipient-local window,
 * min spacing from other active sends, and under the per-local-day cap. Fail-closed.
 */
export function isSlotAllowed(opts: { atMs: number; nowMs: number; tz: string; rules: SchedulingRules; otherActiveUtcMs: number[] }): SlotResult {
  const { atMs, nowMs, tz, rules, otherActiveUtcMs } = opts;
  const earliest = nowMs + rules.earliestOffsetMinutes * 60_000;
  if (atMs < earliest) return { ok: false, reason: 'before_earliest' };
  const l = utcToLocal(tz, atMs);
  if (!new Set(rules.allowedWeekdays).has(l.weekdayIso)) return { ok: false, reason: 'weekday_not_allowed' };
  const mins = l.hour * 60 + l.minute;
  if (mins < rules.windowStartHour * 60 || mins >= rules.windowEndHour * 60) return { ok: false, reason: 'outside_window' };
  const spacingMs = rules.minSpacingMinutes * 60_000;
  if (otherActiveUtcMs.some((e) => Math.abs(atMs - e) < spacingMs)) return { ok: false, reason: 'too_close' };
  const onDay = otherActiveUtcMs.filter((e) => { const x = utcToLocal(tz, e); return x.year === l.year && x.month === l.month && x.day === l.day; }).length;
  if (onDay >= rules.dailyCap) return { ok: false, reason: 'daily_cap' };
  return { ok: true, scheduledAtUtc: atMs };
}
