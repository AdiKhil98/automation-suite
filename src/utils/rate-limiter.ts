/** Minimal min-interval rate limiter: awaits so calls are spaced by 1/rps seconds. */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastAt = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
  }

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = this.lastAt + this.minIntervalMs - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastAt = Date.now();
  }
}
