import { describe, it, expect } from "vitest";
import { parseVariants, variantLabel } from "../../src/bench/variants.js";

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

describe("variantLabel", () => {
  it("names the effort a model thinks at when none was given", () => {
    expect(variantLabel({ id: "claude-sonnet-5", model: "claude-sonnet-5" })).toBe("claude-sonnet-5 (default effort: high)");
    expect(variantLabel({ id: "claude-opus-5", model: "claude-opus-5" })).toBe("claude-opus-5 (default effort: high)");
    expect(variantLabel({ id: "claude-sonnet-5-20260301", model: "claude-sonnet-5-20260301" })).toBe("claude-sonnet-5-20260301 (default effort: high)");
  });
  it("leaves explicit efforts and models without a default alone", () => {
    expect(variantLabel({ id: "claude-sonnet-5:low", model: "claude-sonnet-5", effort: "low" })).toBe("claude-sonnet-5:low");
    expect(variantLabel({ id: "claude-haiku-4-5", model: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
    expect(variantLabel({ id: "claude-sonnet-5-1", model: "claude-sonnet-5-1" })).toBe("claude-sonnet-5-1");
  });
});
