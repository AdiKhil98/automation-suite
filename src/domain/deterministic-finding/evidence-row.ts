import { type CaptureEvidenceType } from '../capture/capture-evidence.js';

/**
 * A single capture-evidence row in the shape bounded booking discovery scans. This is the shared
 * foundation for Layer 1 (booking-discovery) and is re-exported by the deterministic-finding bridge
 * so both read one definition. It carries only already-captured, deterministic fields — no I/O.
 */
export interface DeterministicEvidenceRow {
  id: string;
  leadId: string;
  captureRunId: string;
  evidenceType: CaptureEvidenceType;
  sourceUrl: string | null;
  profile: 'desktop' | 'mobile';
  extractedValue: string | null;
  normalizedValue: string | null;
}
