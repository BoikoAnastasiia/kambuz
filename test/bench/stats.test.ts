import { describe, it, expect } from "vitest";
import { mean, proportion, wilson, formatProportion } from "../../src/bench/stats.js";

describe("wilson", () => {
  it("matches the 95% Wilson score interval", () => {
    const [lo, hi] = wilson(5, 10)!;
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
    const [lo0, hi0] = wilson(0, 10)!;
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 4);
    const [lo1, hi1] = wilson(10, 10)!;
    expect(lo1).toBeCloseTo(0.7225, 4);
    expect(hi1).toBe(1);
  });
  it("is null with no observations", () => {
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("proportion", () => {
  it("carries hits, total, rate and interval", () => {
    expect(proportion(3, 4)).toMatchObject({ hits: 3, total: 4, rate: 0.75 });
    expect(proportion(0, 0)).toEqual({ hits: 0, total: 0, rate: null, ci: null });
  });
  it("formats as percent, fraction and interval", () => {
    expect(formatProportion(proportion(5, 10))).toBe("50% 5/10 [24–76]");
    expect(formatProportion(proportion(0, 0))).toBe("— 0/0");
  });
});

describe("mean", () => {
  it("is null for no data", () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2])).toBe(1.5);
  });
});
