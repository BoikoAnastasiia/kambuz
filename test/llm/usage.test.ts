import { describe, it, expect } from "vitest";
import { UsageLedger } from "../../src/llm/usage.js";

describe("UsageLedger", () => {
  it("sums totals and groups by agent", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 100, output_tokens: 10 });
    l.add("scout", "claude-sonnet-5", { input_tokens: 50, output_tokens: 5 });
    l.add("extractor", "claude-sonnet-5", { input_tokens: 1, output_tokens: 1 });
    expect(l.total()).toEqual({ input: 151, output: 16, calls: 3 });
    expect(l.byAgent().scout).toEqual({ input: 150, output: 15, calls: 2 });
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
    expect(l.total()).toEqual({ input: 10, output: 2, calls: 1 });
  });
});
