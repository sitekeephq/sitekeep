/**
 * Counts failed requests per key (client IP) in a sliding window. In memory, per server process:
 * enough for one on-prem server; behind several instances each counts its own failures.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds to wait while the key is blocked, else 0. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
    // Keep memory bounded when many addresses fail.
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()].slice(0, 1000)) this.failures.delete(k);
  }
}
