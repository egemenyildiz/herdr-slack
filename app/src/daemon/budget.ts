/** One shared token bucket for every outbound Slack write. */

export interface BudgetOptions {
  totalPerMin: number;
  now?: () => number;
}

export class RateBudget {
  readonly totalPerMin: number;

  #now: () => number;
  #windowStart: number;
  #used = 0;

  constructor(options: BudgetOptions) {
    this.totalPerMin = options.totalPerMin;
    this.#now = options.now ?? Date.now;
    this.#windowStart = this.#now();
  }

  /** Try to spend one write. */
  tryConsume(): boolean {
    this.#rollWindow();
    if (this.#used >= this.totalPerMin) return false;
    this.#used += 1;
    return true;
  }

  get used(): number {
    this.#rollWindow();
    return this.#used;
  }

  #rollWindow(): void {
    const now = this.#now();
    if (now - this.#windowStart >= 60_000) {
      this.#windowStart = now;
      this.#used = 0;
    }
  }
}
