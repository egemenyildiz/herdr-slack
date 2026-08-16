import { describe, expect, it } from "vitest";
import { RateBudget } from "../../src/daemon/budget.js";

describe("RateBudget", () => {
  it("never exceeds the configured writes per minute", () => {
    const budget = new RateBudget({ totalPerMin: 3, now: () => 0 });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(3);
  });

  it("resets after the minute rolls", () => {
    let clock = 0;
    const budget = new RateBudget({ totalPerMin: 1, now: () => clock });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    clock = 60_001;
    expect(budget.tryConsume()).toBe(true);
    expect(budget.used).toBe(1);
  });

  it("uses the real clock by default", () => {
    expect(new RateBudget({ totalPerMin: 1 }).tryConsume()).toBe(true);
  });
});
