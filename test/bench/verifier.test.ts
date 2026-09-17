import { describe, it, expect } from "vitest";
import { scoreVerifier, type VerifierCase } from "../../src/bench/verifier.js";
import type { RecipeFlag } from "../../src/schemas/recipe.js";

const ing = (ref: string): RecipeFlag => ({ kind: "ingredient", ref, reason: "r" });
const step = (ref: string): RecipeFlag => ({ kind: "step", ref, reason: "r" });

function c(p: { variant: string; mutation: VerifierCase["mutation"]; target?: VerifierCase["target"]; flags?: RecipeFlag[]; segmentIndex?: number; ms?: number }): VerifierCase {
  return { repeat: 0, videoId: "v1", segmentIndex: 0, target: null, ok: true, flags: [], ms: 50, ...p };
}

describe("scoreVerifier", () => {
  const cases: VerifierCase[] = [
    // variant a: clean run flags step 2 on segment 0
    c({ variant: "a", mutation: "clean", flags: [step("2")] }),
    c({ variant: "a", mutation: "extra-ingredient", target: { kind: "ingredient", ref: "Корица" }, flags: [step("2"), ing("Корица")] }),
    c({ variant: "a", mutation: "changed-quantity", target: { kind: "ingredient", ref: "фарш" }, flags: [step("2"), ing("лук")] }),
    c({ variant: "a", mutation: "extra-step", target: { kind: "step", ref: "3" }, flags: [step("3")] }),
    c({ variant: "a", mutation: "clean", segmentIndex: 1, flags: [] }),
    c({ variant: "a", mutation: "extra-step", segmentIndex: 1, target: { kind: "step", ref: "2" }, flags: [step("2")], ms: 150 }),
    // variant b: never flags; one call failed
    c({ variant: "b", mutation: "clean", flags: [] }),
    c({ variant: "b", mutation: "extra-ingredient", target: { kind: "ingredient", ref: "Корица" }, flags: [] }),
    { variant: "b", repeat: 0, videoId: "v1", segmentIndex: 0, mutation: "extra-step", target: { kind: "step", ref: "3" }, ok: false, error: "boom", ms: 1 },
  ];
  const scored = scoreVerifier(cases, ["a", "b"]);

  it("scores detection per kind and overall, clean flags and noise", () => {
    const a = scored.find((v) => v.variant === "a")!;
    expect(a.detection["extra-ingredient"]).toEqual({ detected: 1, total: 1, rate: 1 });
    expect(a.detection["changed-quantity"]).toEqual({ detected: 0, total: 1, rate: 0 });
    expect(a.detection["extra-step"]).toEqual({ detected: 2, total: 2, rate: 1 });
    expect(a.overallDetection).toBe(0.75);
    expect(a.cleanFlagsMean).toBe(0.5);
    // noise: step 2 was already flagged on clean; лук on the changed-quantity draft is new → 1 extra over 4 mutated cases
    expect(a.noiseMean).toBe(0.25);
    expect(a).toMatchObject({ cases: 6, errors: 0, meanLatencyMs: (50 * 5 + 150) / 6 });
  });

  it("excludes failed calls from rates and counts them as errors", () => {
    const b = scored.find((v) => v.variant === "b")!;
    expect(b.errors).toBe(1);
    expect(b.detection["extra-step"]).toEqual({ detected: 0, total: 0, rate: null });
    expect(b.overallDetection).toBe(0);
    expect(b.cleanFlagsMean).toBe(0);
    expect(b.noiseMean).toBe(0);
  });
});
