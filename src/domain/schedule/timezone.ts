/**
 * Minimal timezone-aware helpers built on the platform Intl database — no external deps. The
 * recipient's IANA timezone is REQUIRED and validated; conversions are DST-correct. Used only
 * for deterministic slot computation; never for any external action.
 */

/** True if `tz` is a valid IANA timezone the runtime recognizes. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(tz: string, instantMs: number): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instantMs))) m[p.type] = p.value;
  return { year: +(m.year ?? 0), month: +(m.month ?? 1), day: +(m.day ?? 1), hour: +(m.hour ?? 0) % 24, minute: +(m.minute ?? 0), second: +(m.second ?? 0) };
}

/** Offset in ms that `tz` is ahead of UTC at the given instant (positive = east of UTC). */
export function tzOffsetMs(tz: string, instantMs: number): number {
  const p = partsOf(tz, instantMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instantMs;
}

/** Local wall-clock parts (incl. ISO weekday 1=Mon..7=Sun) for a UTC instant in `tz`. */
export function utcToLocal(tz: string, instantMs: number): LocalParts & { weekdayIso: number } {
  const p = partsOf(tz, instantMs);
  // ISO weekday from the local calendar date (independent of time).
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun..6=Sat
  return { ...p, weekdayIso: dow === 0 ? 7 : dow };
}

/**
 * Convert a local wall-clock time in `tz` to the UTC instant (ms). DST-correct via a two-step
 * offset resolution. Nonexistent spring-forward times resolve to the post-transition instant.
 */
export function zonedWallClockToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const o1 = tzOffsetMs(tz, naive);
  let utc = naive - o1;
  const o2 = tzOffsetMs(tz, utc);
  if (o2 !== o1) utc = naive - o2;
  return utc;
}

/** Format a UTC instant as an ISO-like local string with offset, e.g. "2026-07-20 09:00 (Europe/Berlin)". */
export function formatLocal(tz: string, instantMs: number): string {
  const p = utcToLocal(tz, instantMs);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz})`;
}
