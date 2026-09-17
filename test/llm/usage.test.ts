import { describe, it, expect } from "vitest";
import { UsageLedger, formatCost } from "../../src/llm/usage.js";
import { costUsd } from "../../src/llm/pricing.js";

describe("UsageLedger", () => {
  it("sums totals and groups by agent", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 100, output_tokens: 10 });
    l.add("scout", "claude-sonnet-5", { input_tokens: 50, output_tokens: 5 });
    l.add("extractor", "claude-sonnet-5", { input_tokens: 1, output_tokens: 1 });
    const expectedScoutCost =
      costUsd("claude-sonnet-5", { input_tokens: 100, output_tokens: 10 })! + costUsd("claude-sonnet-5", { input_tokens: 50, output_tokens: 5 })!;
    const expectedExtractorCost = costUsd("claude-sonnet-5", { input_tokens: 1, output_tokens: 1 })!;
    expect(l.total()).toEqual({ input: 151, output: 16, calls: 3, costUsd: expectedScoutCost + expectedExtractorCost });
    expect(l.byAgent().scout).toEqual({ input: 150, output: 15, calls: 2, costUsd: expectedScoutCost });
    expect(l.toString()).toContain("scout");
  });

  it("notifies subscribers with each call's own usage, in order, and stops after unsubscribe", () => {
    const l = new UsageLedger();
    const calls: { agent: string; model: string; usage: { input_tokens: number; output_tokens: number } }[] = [];
    const unsubscribe = l.subscribe((agent, model, usage) => calls.push({ agent, model, usage }));

    l.add("scout", "claude-sonnet-5", { input_tokens: 100, output_tokens: 10 });
    l.add("extractor", "claude-sonnet-5", { input_tokens: 5, output_tokens: 1 });
    expect(calls).toEqual([
      { agent: "scout", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 10 } },
      { agent: "extractor", model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 1 } },
    ]);

    unsubscribe();
    l.add("scout", "claude-sonnet-5", { input_tokens: 1, output_tokens: 1 });
    expect(calls).toHaveLength(2);
  });

  it("keeps totalling usage even if a subscriber throws", () => {
    const l = new UsageLedger();
    l.subscribe(() => {
      throw new Error("renderer blew up");
    });
    expect(() => l.add("scout", "claude-sonnet-5", { input_tokens: 10, output_tokens: 2 })).not.toThrow();
    expect(l.total()).toEqual({ input: 10, output: 2, calls: 1, costUsd: costUsd("claude-sonnet-5", { input_tokens: 10, output_tokens: 2 }) });
  });

  it("gives two agents on different models their own costs", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 });
    l.add("extractor", "claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(l.byAgent().scout.costUsd).toBe(2);
    expect(l.byAgent().extractor.costUsd).toBe(5);
    expect(l.total().costUsd).toBe(7);
  });

  it("marks a bucket's cost unknown (never 0) when any of its calls used an unpriced model", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 });
    l.add("scout", "claude-made-up-model", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(l.byAgent().scout.costUsd).toBeNull();
    expect(l.total().costUsd).toBeNull();
    expect(l.toString()).toContain("?");
  });

  it("exposes rows() with per-agent cost for the HTML renderer", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 });
    l.add("extractor", "claude-made-up-model", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(l.rows()).toEqual([
      { agent: "scout", calls: 1, input: 1_000_000, output: 0, costUsd: 2 },
      { agent: "extractor", calls: 1, input: 1_000_000, output: 0, costUsd: null },
    ]);
  });
});

describe("formatCost", () => {
  it("renders 4 decimals under $1 and 2 above", () => {
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(12)).toBe("$12.00");
  });

  it("renders unknown cost as ?", () => {
    expect(formatCost(null)).toBe("?");
  });

  it("counts attempts whose usage could not be billed, without touching the token buckets", () => {
    const l = new UsageLedger();
    l.addUnbilled("scout", "claude-sonnet-5");
    l.addUnbilled("scout", "claude-sonnet-5");
    expect(l.unbilledCalls()).toBe(2);
    expect(l.total()).toEqual({ input: 0, output: 0, calls: 0, costUsd: 0 });
  });
});
