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
});
