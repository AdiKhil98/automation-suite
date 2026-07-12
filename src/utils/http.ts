import { AppError } from './errors.js';

export class HttpError extends AppError {
  readonly status: number;
  constructor(status: number, message: string) {
    super('HTTP_ERROR', message);
    this.status = status;
  }
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  backoffMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * POST JSON with a per-attempt timeout, bounded retries and exponential backoff.
 * Retries only transient failures (network errors, 429, 5xx); 4xx fail fast.
 * This is "retry within the current run" — callers do not persist a resume token.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: PostJsonOptions,
): Promise<T> {
  const backoffMs = opts.backoffMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (isRetriableStatus(res.status) && attempt < opts.maxRetries) {
          lastError = new HttpError(res.status, `HTTP ${res.status}`);
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        throw new HttpError(res.status, `HTTP ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && !isRetriableStatus(err.status)) throw err;
      if (attempt >= opts.maxRetries) break;
      await sleep(backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AppError('HTTP_REQUEST_FAILED', `Request to ${url} failed after retries: ${message}`);
}
