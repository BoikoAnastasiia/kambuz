import { describe, it, expect } from "vitest";
import { estimateCost, CHARS_PER_TOKEN, OUTPUT_TOKENS_PER_CALL } from "../../src/bench/estimate.js";

describe("estimateCost", () => {
  it("prices chars/3 input and a per-agent output constant per call", () => {
    const e = estimateCost("claude-sonnet-5", "verifier", [3000, 6000]);
    expect(CHARS_PER_TOKEN).toBe(3);
    expect(OUTPUT_TOKENS_PER_CALL).toEqual({ verifier: 2500, categorizer: 150 });
    expect(e).toMatchObject({ calls: 2, inputTokens: 3000, outputTokens: 5000 });
    // sonnet 5: $2/M in, $10/M out
    expect(e.costUsd).toBeCloseTo((3000 * 2 + 5000 * 10) / 1_000_000, 10);
  });

  it("uses the categorizer's smaller output and a dated model's family price", () => {
    const e = estimateCost("claude-haiku-4-5-20251001", "categorizer", [900]);
    expect(e).toMatchObject({ calls: 1, inputTokens: 300, outputTokens: 150 });
    expect(e.costUsd).toBeCloseTo((300 * 1 + 150 * 5) / 1_000_000, 10);
  });

  it("is unknown for an unpriced model", () => {
    expect(estimateCost("claude-made-up", "verifier", [10]).costUsd).toBeNull();
  });
});
