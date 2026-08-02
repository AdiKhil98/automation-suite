/**
 * Phase 7A3A evidence eligibility. Deterministic gates that decide which competitor evidence items may
 * participate in pattern aggregation, and which prospect primitives may back a contrast. Freshness is
 * always re-derived from `capturedAt` + now — a stored FRESH status is never trusted on its own.
 */

import { EVIDENCE_CATEGORIES } from './evidence-types.js';
import { evaluateFreshness } from './evidence-freshness.js';
import { MESSAGING_HOSTS, type ProspectCategoryMapping, type ExclusionReason } from './pattern-constants.js';
import { type PatternCompetitorInput, type PatternEvidenceItem, type ProspectEvidenceRef } from './pattern-types.js';

const APPROVED_CATEGORIES = new Set<string>(EVIDENCE_CATEGORIES);
const APPROVED_OBSERVATION_KINDS = new Set(['DIRECT_OBSERVATION', 'DETERMINISTIC_INTERPRETATION']);

export interface EvidenceEligibility {
  eligible: boolean;
  reason: ExclusionReason | null;
}

/**
 * A single competitor evidence item's eligibility for aggregation. Order matters: the most structural
 * exclusions (not-selected / superseded / inactive) come first so exclusion reasons are stable.
 */
export function evaluateCompetitorEvidenceEligibility(
  competitor: PatternCompetitorInput,
  item: PatternEvidenceItem,
  now: Date,
  maxAgeDays: number,
): EvidenceEligibility {
  if (!competitor.selected) return { eligible: false, reason: 'NOT_SELECTED_CANDIDATE' };
  if (!competitor.captureActive) return { eligible: false, reason: 'CAPTURE_SUPERSEDED' };
  if (!item.active) return { eligible: false, reason: 'EVIDENCE_INACTIVE' };
  if (item.observationKind === 'UNSUPPORTED_INFERENCE') return { eligible: false, reason: 'UNSUPPORTED_INFERENCE' };
  if (!APPROVED_OBSERVATION_KINDS.has(item.observationKind)) return { eligible: false, reason: 'UNSUPPORTED_INFERENCE' };
  if (!APPROVED_CATEGORIES.has(item.evidenceCategory)) return { eligible: false, reason: 'CATEGORY_NOT_APPROVED' };
  if (item.confidence === 'LOW') return { eligible: false, reason: 'LOW_CONFIDENCE' };
  if (!item.safeForOutreach) return { eligible: false, reason: 'NOT_SAFE_FOR_OUTREACH' };
  if (!item.sourcePageUrl || item.sourcePageUrl.trim() === '') return { eligible: false, reason: 'MISSING_SOURCE_URL' };
  // Freshness recomputed from timestamps — an item aged past the window is stale even if stored FRESH.
  if (evaluateFreshness(item.capturedAt, now, maxAgeDays) !== 'FRESH') return { eligible: false, reason: 'STALE' };
  return { eligible: true, reason: null };
}

/**
 * Live state of a single supporting evidence item, re-read at review/approval time. `captureActive`
 * is false when the owning capture run has been SUPERSEDED.
 */
export interface SupportingEvidenceState {
  evidenceItemId: string;
  active: boolean;
  safeForOutreach: boolean;
  capturedAt: Date;
  captureActive: boolean;
}

/**
 * Pure re-evaluation of one supporting evidence item against LIVE state at `now`. Returns a failure
 * reason (which must BLOCK approval) or null when the item is still active, safe, on an active capture,
 * and FRESH. This deliberately recomputes freshness from `capturedAt` — the package's stored
 * generation-time freshness is never trusted.
 */
export function supportingEvidenceFailure(state: SupportingEvidenceState, now: Date, maxAgeDays: number): string | null {
  if (!state.captureActive) return `competitor evidence ${state.evidenceItemId} capture run is superseded`;
  if (!state.active) return `competitor evidence ${state.evidenceItemId} was invalidated (inactive)`;
  if (!state.safeForOutreach) return `competitor evidence ${state.evidenceItemId} is no longer safe-for-outreach`;
  if (evaluateFreshness(state.capturedAt, now, maxAgeDays) !== 'FRESH') return `competitor evidence ${state.evidenceItemId} is now stale`;
  return null;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    // Tolerate bare hosts and full URLs; never throw on malformed input.
    const u = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function refMatchesMessagingHost(ref: ProspectEvidenceRef): boolean {
  const host = hostOf(ref.normalizedValue) ?? hostOf(ref.sourceUrl);
  if (!host) return false;
  return MESSAGING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Whether the prospect's verified evidence shows PRESENCE for a mapped category. Only called when a
 * verified capture exists (`ProspectEvidenceInput.capturedOk`). Absence is inferred by the caller when
 * this returns false AND the capture succeeded.
 */
export function prospectShowsPresence(mapping: ProspectCategoryMapping, refs: ProspectEvidenceRef[]): boolean {
  const wantedTypes = new Set(mapping.prospectEvidenceTypes);
  for (const ref of refs) {
    if (!wantedTypes.has(ref.evidenceType)) continue;
    if (mapping.messagingHostOnly && (ref.evidenceType === 'link' || ref.evidenceType === 'mailto')) {
      if (!refMatchesMessagingHost(ref)) continue;
    }
    return true;
  }
  return false;
}
