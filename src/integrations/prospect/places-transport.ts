import { AppError } from '../../utils/errors.js';

export interface PlacesTransport {
  post<T>(url: string, body: unknown, fieldMask: string): Promise<T>;
}

/** Single-attempt Places (New) transport. It never retries and never logs keys or bodies. */
export class FetchPlacesTransport implements PlacesTransport {
  constructor(private readonly apiKey: string, private readonly timeoutMs: number) {}

  async post<T>(url: string, body: unknown, fieldMask: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fieldMask },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const systemic = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
        throw new AppError(systemic ? 'PLACES_PROVIDER_FAILURE' : 'PLACES_REQUEST_REJECTED', `Places request failed with status ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('PLACES_PROVIDER_FAILURE', error instanceof Error && error.name === 'AbortError' ? 'Places request timed out' : 'Places request failed');
    } finally { clearTimeout(timer) }
  }
}
