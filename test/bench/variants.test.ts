import { describe, it, expect } from "vitest";
import { parseVariants } from "../../src/bench/variants.js";

describe("parseVariants", () => {
  it("parses model[:effort] entries in order", () => {
    expect(parseVariants("claude-sonnet-5,claude-sonnet-5:low, claude-haiku-4-5 ")).toEqual({
      ok: true,
      variants: [
        { id: "claude-sonnet-5", model: "claude-sonnet-5" },
        { id: "claude-sonnet-5:low", model: "claude-sonnet-5", effort: "low" },
        { id: "claude-haiku-4-5", model: "claude-haiku-4-5" },
      ],
    });
  });

  it("rejects an unknown effort, naming the allowed ones", () => {
    const r = parseVariants("claude-sonnet-5:turbo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/low, medium, high/);
  });

  it("rejects empty input, empty models, extra colons and duplicates", () => {
    expect(parseVariants("").ok).toBe(false);
    expect(parseVariants(" , ").ok).toBe(false);
    expect(parseVariants(":low").ok).toBe(false);
    expect(parseVariants("a:low:high").ok).toBe(false);
    expect(parseVariants("a,a").ok).toBe(false);
    expect(parseVariants("a:low,a:low").ok).toBe(false);
  });

  it("ignores a trailing comma", () => {
    expect(parseVariants("a,").ok).toBe(true);
  });
});
