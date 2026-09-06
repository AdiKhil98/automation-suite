import { type CandidatePerson } from '../contact-enrichment/types.js';

/**
 * The three terminal contact-resolution states for a lead. Deliberately separate from
 * `ContactEnrichmentOutcome`: that vocabulary describes what a PAID PROVIDER CALL did, this one
 * describes who we may actually write to and how we are allowed to address them.
 *
 *  PERSONAL_VERIFIED — a named decision-maker's own work address, proven by the Instantly/Hunter
 *                      trust boundary. The only state in which copy may greet a person by name.
 *  GENERIC_OFFICIAL  — a published, generic business inbox on the verified official domain. Belongs
 *                      to the ORGANISATION, never to a person. Copy must stay unaddressed.
 *  UNRESOLVED        — no usable recipient. Nothing downstream may send.
 */
export const CONTACT_RESOLUTION_TYPES = ['PERSONAL_VERIFIED', 'GENERIC_OFFICIAL', 'UNRESOLVED'] as const;
export type ContactResolutionType = (typeof CONTACT_RESOLUTION_TYPES)[number];

/** The two types that are actually persisted; UNRESOLVED is the absence of a row, never a row. */
export const PERSISTED_CONTACT_RESOLUTION_TYPES = ['PERSONAL_VERIFIED', 'GENERIC_OFFICIAL'] as const;
export type PersistedContactResolutionType = (typeof PERSISTED_CONTACT_RESOLUTION_TYPES)[number];

/**
 * A decision-maker we BELIEVE is behind a generic inbox, carried so downstream copy can ask for a
 * forward ("could you pass this to ...") — explicitly NOT a claim that the mailbox is theirs.
 * Never populated for PERSONAL_VERIFIED, where the person IS the recipient.
 */
export interface IntendedDecisionMaker {
  fullName: string;
  title: string;
  priority: number;
}

export function toIntendedDecisionMakers(candidates: readonly CandidatePerson[]): IntendedDecisionMaker[] {
  return [...candidates]
    .sort((a, b) => a.priority - b.priority || a.fullName.localeCompare(b.fullName))
    .map((c) => ({ fullName: c.fullName, title: c.title, priority: c.priority }));
}

/** A persisted contact resolution (mirrors one `contact_resolutions` row). */
export interface ContactResolution {
  id: string;
  leadId: string;
  resolutionType: PersistedContactResolutionType;
  /** Snapshot of the address resolved at decision time. Provenance lives in the FK fields below. */
  recipientEmail: string;
  /** GENERIC_OFFICIAL only: the authoritative `contact_email` lead fact this was accepted from. */
  sourceFactId: string | null;
  /** PERSONAL_VERIFIED only: the enrichment row whose trust boundary accepted the address. */
  enrichmentResultId: string | null;
  /** Where the address was published/obtained. Retained for audit and human review. */
  sourceUrl: string | null;
  /** GENERIC_OFFICIAL only: who we hope the inbox forwards to. Empty for PERSONAL_VERIFIED. */
  intendedDecisionMakers: IntendedDecisionMaker[];
  resolvedAt: Date;
  isCurrent: boolean;
}

export interface NewContactResolution {
  leadId: string;
  resolutionType: PersistedContactResolutionType;
  recipientEmail: string;
  sourceFactId?: string | null;
  enrichmentResultId?: string | null;
  sourceUrl?: string | null;
  intendedDecisionMakers?: IntendedDecisionMaker[];
}
