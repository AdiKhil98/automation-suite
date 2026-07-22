export const VERIFICATION_FAILURE_STAGES = [
  'DNS',
  'TCP_CONNECT',
  'TLS',
  'HTTP',
  'REDIRECT',
  'TIMEOUT',
  'POLICY',
  'UNKNOWN',
] as const;

export type VerificationFailureStage = (typeof VERIFICATION_FAILURE_STAGES)[number];

export interface NetworkErrorClassification {
  stage: VerificationFailureStage;
  errorCode: string | null;
  retryable: boolean;
}

export interface HttpErrorClassification extends NetworkErrorClassification {
  finalClassification: 'TRANSIENT' | 'INVALID';
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const GENERIC_WRAPPER_CODES = new Set(['TRANSIENT_FETCH']);

function safeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_]{2,80}$/.test(normalized) ? normalized : null;
}

function nestedErrors(root: unknown): unknown[] {
  const found: unknown[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length > 0 && found.length < 32) {
    const current = queue.shift();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    const record = current as { cause?: unknown; errors?: unknown };
    if (record.cause) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return found;
}

/**
 * Classify Node, undici and AggregateError failures without retaining messages,
 * request metadata, headers, response bodies or stack traces.
 */
export function classifyNetworkError(error: unknown): NetworkErrorClassification {
  const codes = nestedErrors(error)
    .map((entry) => safeCode((entry as { code?: unknown }).code))
    .filter((code): code is string => code !== null);

  const detailedCodes = codes.filter((code) => !GENERIC_WRAPPER_CODES.has(code));
  const classifiedCodes = detailedCodes.length > 0 ? detailedCodes : codes;

  const firstMatching = (set: Set<string>): string | null => classifiedCodes.find((code) => set.has(code)) ?? null;
  const timeout = firstMatching(TIMEOUT_CODES);
  if (timeout) return { stage: 'TIMEOUT', errorCode: timeout, retryable: true };
  const dns = firstMatching(DNS_CODES);
  if (dns) return { stage: 'DNS', errorCode: dns, retryable: true };
  const tls = firstMatching(TLS_CODES);
  if (tls) return { stage: 'TLS', errorCode: tls, retryable: false };
  const connect = firstMatching(CONNECT_CODES);
  if (connect) return { stage: 'TCP_CONNECT', errorCode: connect, retryable: true };
  const tlsLike = classifiedCodes.find(
    (code) => code.startsWith('ERR_TLS_') || code.includes('CERTIFICATE') || code.startsWith('CERT_'),
  );
  if (tlsLike) return { stage: 'TLS', errorCode: tlsLike, retryable: false };
  return { stage: 'UNKNOWN', errorCode: classifiedCodes[0] ?? null, retryable: true };
}

export function classifyHttpStatus(status: number): HttpErrorClassification | null {
  if (status === 429) {
    return { finalClassification: 'TRANSIENT', stage: 'HTTP', errorCode: 'HTTP_429', retryable: true };
  }
  if (status >= 500 && status <= 599) {
    return { finalClassification: 'TRANSIENT', stage: 'HTTP', errorCode: 'HTTP_5XX', retryable: true };
  }
  if (status >= 400 && status <= 499) {
    return { finalClassification: 'INVALID', stage: 'HTTP', errorCode: 'HTTP_4XX', retryable: false };
  }
  return null;
}

export function classifyRedirectLimit(): NetworkErrorClassification {
  return { stage: 'REDIRECT', errorCode: 'TOO_MANY_REDIRECTS', retryable: false };
}

export function classifyInvalidRedirect(): NetworkErrorClassification {
  return { stage: 'REDIRECT', errorCode: 'INVALID_REDIRECT_LOCATION', retryable: false };
}
