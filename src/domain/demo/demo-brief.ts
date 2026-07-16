import { type AuditCategory } from '../audit/audit-types.js';
import { type DemoBrief, type DemoDirective, type FindingInput } from './demo-types.js';

/** Accepted, outreach-safe Phase 6 finding used to brief the demo. */
export interface BriefFinding {
  id: string;
  findingRef: string;
  category: AuditCategory;
  safeForOutreach: boolean;
}

const CATEGORY_DIRECTIVE: Partial<Record<AuditCategory, DemoDirective>> = {
  CTA_CLARITY: 'PROMINENT_CTA',
  BOOKING_FRICTION: 'PROMINENT_CTA',
  CONTACT_FRICTION: 'VISIBLE_CONTACT',
  LOCAL_INFORMATION: 'VISIBLE_CONTACT',
  MOBILE_USABILITY: 'RESPONSIVE',
  SERVICE_CLARITY: 'SERVICES_SECTION',
  VISUAL_HIERARCHY: 'CLEAR_HIERARCHY',
  // Trust/social proof map to a clean professional layout — never fabricated testimonials.
  TRUST_SIGNALS: 'CLEAR_HIERARCHY',
  SOCIAL_PROOF: 'CLEAR_HIERARCHY',
};

/**
 * Deterministically turn the approved Phase 6 findings into demo emphasis directives.
 * Only outreach-safe findings in demonstrable categories contribute; each contributing
 * finding is recorded (findingId → directive) for relational provenance. RESPONSIVE and
 * CLEAR_HIERARCHY are always present (baseline quality), but only *linked* to a finding
 * when a finding actually motivates them.
 */
export function buildDemoBrief(findings: BriefFinding[]): DemoBrief {
  const findingInputs: FindingInput[] = [];
  const directives = new Set<DemoDirective>(['RESPONSIVE', 'CLEAR_HIERARCHY']);

  for (const f of findings) {
    if (!f.safeForOutreach) continue;
    const directive = CATEGORY_DIRECTIVE[f.category];
    if (!directive) continue;
    directives.add(directive);
    findingInputs.push({ findingId: f.id, findingRef: f.findingRef, category: f.category, directive });
  }

  return { directives: [...directives], findingInputs };
}
