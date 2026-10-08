import { describe, it, expect } from "vitest";
import { costUsd, PRICES } from "../../src/llm/pricing.js";

describe("costUsd", () => {
  it("prices Sonnet 5 at $12 for 1M input + 1M output tokens", () => {
    expect(costUsd("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(12);
  });

  it("resolves a dated model id by prefix", () => {
    expect(costUsd("claude-haiku-4-5-20251001", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(1);
  });

  it("returns null for an unknown model", () => {
    expect(costUsd("claude-made-up-model", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeNull();
  });

  it("prices cache reads at 0.1x input and cache writes at 1.25x input", () => {
    const readCost = costUsd("claude-sonnet-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
    const writeCost = costUsd("claude-sonnet-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
    expect(readCost).toBeCloseTo(PRICES["claude-sonnet-5"].input * 0.1, 10);
    expect(writeCost).toBeCloseTo(PRICES["claude-sonnet-5"].input * 1.25, 10);
  });

  it("prices Haiku 5.5 at its short-prompt rate up to 100k prompt tokens and its long-prompt rate above", () => {
    expect(costUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 10_000 })).toBeCloseTo(0.01 + 0.005, 10);
    expect(costUsd("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 0 })).toBeCloseTo(100_001 * 0.5 / 1_000_000, 10);
    // cache reads count toward the prompt length that picks the tier
    expect(costUsd("claude-haiku-5-5", { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 60_000 }))
      .toBeCloseTo((60_000 * 0.5 + 60_000 * 0.5 * 0.1) / 1_000_000, 10);
  });

  it("ignores absent cache fields", () => {
    expect(costUsd("claude-sonnet-5", { input_tokens: 500_000, output_tokens: 0 })).toBeCloseTo(1, 10);
  });

  it("only resolves a dated snapshot of a registered id, never a different model sharing its prefix", () => {
    expect(costUsd("claude-sonnet-5-20260301", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(2);
    expect(costUsd("claude-sonnet-5-1", { input_tokens: 1_000_000, output_tokens: 0 })).toBeNull();
    expect(costUsd("claude-sonnet-5-1-20260301", { input_tokens: 1_000_000, output_tokens: 0 })).toBeNull();
    expect(costUsd("claude-sonnet-5-2026", { input_tokens: 1_000_000, output_tokens: 0 })).toBeNull();
  });
});
