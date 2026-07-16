import { type GeneratorFinding } from '../domain/audit/audit-types.js';
import { type MockResponder } from '../integrations/llm/mock-llm.js';

interface ParsedEvidenceLine {
  id: string;
  type: string;
  profile: 'desktop' | 'mobile';
  url: string | null;
}

// Matches serializeEvidence lines: "- [<id>] (<type>, <profile>, url=<url>): <value>"
const EVIDENCE_LINE = /^- \[([^\]]+)\] \((\w+), (desktop|mobile), url=(.*?)\): /gm;
const PROPOSED_REF = /^- (F\d+) \[/gm;

function parseEvidence(user: string): ParsedEvidenceLine[] {
  const out: ParsedEvidenceLine[] = [];
  for (const m of user.matchAll(EVIDENCE_LINE)) {
    out.push({
      id: m[1] as string,
      type: m[2] as string,
      profile: m[3] as 'desktop' | 'mobile',
      url: m[4] === 'n/a' ? null : (m[4] as string),
    });
  }
  return out;
}

/**
 * Default responder for mock CLI runs (LLM_PROVIDER=mock). Deterministic, evidence-
 * grounded: it cites only evidence IDs actually present in the serialized package,
 * uses restrained language that passes the forbidden-claim validators, and the
 * reviewer approves with one revision. Zero network, zero cost.
 */
export const defaultMockAuditResponder: MockResponder = (req) => {
  if (req.task === 'website_audit') {
    const evidence = parseEvidence(req.user);
    if (evidence.length === 0) {
      return {
        rawJson: {
          summary: 'Insufficient extracted evidence to support any specific finding.',
          findings: [],
          insufficientEvidenceAreas: ['all'],
          conflictingEvidence: [],
          captureLimitations: [],
        },
      };
    }
    const cta = evidence.find((e) => e.type === 'cta') ?? (evidence[0] as ParsedEvidenceLine);
    const contact = evidence.find((e) => e.type === 'tel' || e.type === 'mailto');
    const findings: GeneratorFinding[] = [
      {
        findingRef: 'F1',
        category: 'CTA_CLARITY',
        observation:
          'The primary call-to-action is present but may be easy to overlook relative to surrounding content on the first screen.',
        evidenceIds: [cta.id],
        affectedUrls: cta.url ? [cta.url] : [],
        affectedProfiles: [cta.profile === 'mobile' ? 'MOBILE' : 'DESKTOP'],
        severity: 'MEDIUM',
        confidence: 0.7,
        businessImpact:
          'A less prominent primary action may create friction for visitors who are ready to get in touch.',
        recommendation:
          'Consider making the primary action more visually distinct and repeating it near the top of the page.',
        safeForOutreach: true,
        outreachAngle:
          'Noticed the main action on the homepage could stand out more for visitors ready to book.',
        uncertainty: 'Based on extracted elements and the primary screenshots only.',
      },
    ];
    if (contact) {
      findings.push({
        findingRef: 'F2',
        category: 'CONTACT_FRICTION',
        observation:
          'Contact details are available but may require extra steps to reach from the first screen.',
        evidenceIds: [contact.id],
        affectedUrls: contact.url ? [contact.url] : [],
        affectedProfiles: [contact.profile === 'mobile' ? 'MOBILE' : 'DESKTOP'],
        severity: 'LOW',
        confidence: 0.6,
        businessImpact: 'Extra steps to contact the business could make reaching out harder than it needs to be.',
        recommendation: 'Consider surfacing a direct contact option in the header on both profiles.',
        safeForOutreach: false,
        outreachAngle: null,
        uncertainty: 'Placement inferred from extracted elements, not full-page layout.',
      });
    }
    return {
      rawJson: {
        summary: 'Evidence-backed review of the primary pages; a small number of restrained findings.',
        findings,
        insufficientEvidenceAreas: [],
        conflictingEvidence: [],
        captureLimitations: [],
      },
    };
  }

  // audit_review: approve every proposed finding, revising F1's wording.
  const refs = [...req.user.matchAll(PROPOSED_REF)].map((m) => m[1] as string);
  return {
    rawJson: {
      findings: refs.map((findingRef) => ({
        findingRef,
        decision: findingRef === 'F1' ? 'REVISE' : 'APPROVE',
        evidenceSupported: true,
        impactSupported: true,
        safeForOutreach: findingRef === 'F1',
        problems: [],
        revisedObservation:
          findingRef === 'F1'
            ? 'The primary call-to-action is present but may not stand out on the first screen.'
            : null,
        revisedBusinessImpact: null,
        revisedRecommendation: null,
        revisedOutreachAngle: null,
      })),
      overallDecision: 'APPROVE_WITH_REVISIONS',
    },
  };
};
