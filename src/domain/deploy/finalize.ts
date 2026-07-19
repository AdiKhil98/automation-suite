import { sha256Hex } from '../../utils/hash.js';
import { DEMO_URL_TOKEN } from '../email/email-types.js';

export interface FinalizeResult {
  ok: boolean;
  reason?: string;
  resolvedBody?: string;
  originalBodyHash?: string;
  resolvedBodyHash?: string;
}

/**
 * Deterministically produce the URL-resolved email body by replacing the SINGLE {{DEMO_URL}}
 * token with the verified deployment URL. Fails closed unless there is exactly one token and
 * the result contains none. Pure — never mutates the original draft; the caller persists this
 * as a SEPARATE immutable finalized-email record.
 */
export function finalizeEmailBody(originalBody: string, verifiedUrl: string): FinalizeResult {
  const occurrences = originalBody.split(DEMO_URL_TOKEN).length - 1;
  if (occurrences !== 1) return { ok: false, reason: `expected exactly one ${DEMO_URL_TOKEN}, found ${String(occurrences)}` };
  if (!/^https:\/\//i.test(verifiedUrl)) return { ok: false, reason: 'verified URL must be https' };

  const resolvedBody = originalBody.replace(DEMO_URL_TOKEN, verifiedUrl);
  if (resolvedBody.includes(DEMO_URL_TOKEN)) return { ok: false, reason: 'placeholder remains after substitution' };

  return {
    ok: true,
    resolvedBody,
    originalBodyHash: sha256Hex(originalBody),
    resolvedBodyHash: sha256Hex(resolvedBody),
  };
}
