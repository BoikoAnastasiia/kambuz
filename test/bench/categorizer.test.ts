import { describe, it, expect } from "vitest";
import { validateCategorizerTruth, scoreCategorizer, type CategorizerCase, type CategorizerLabel } from "../../src/bench/categorizer.js";
import type { Categorization } from "../../src/schemas/recipe.js";
import { vocab } from "./fixtures.js";

describe("validateCategorizerTruth", () => {
  it("keeps valid rows and reports each bad one by row number", () => {
    const { labels, errors } = validateCategorizerTruth(
      [
        { videoId: "v1", segmentIndex: 0, dish: "Лазанья", cuisine: "italian", category: "pasta", mealTypes: ["dinner"] },
        { videoId: "v1", segmentIndex: 1, dish: "Суп", cuisine: "klingon", category: "soup", mealTypes: ["lunch"] },
        { videoId: "v1", segmentIndex: 2, dish: "x", cuisine: "russian", category: "casserole", mealTypes: ["brunch"] },
        { videoId: "v1", segmentIndex: 0, dish: "dup", cuisine: "italian", category: "pasta", mealTypes: ["dinner"] },
        { videoId: "v1" },
      ],
      vocab,
    );
    expect(labels).toEqual([{ videoId: "v1", segmentIndex: 0, dish: "Лазанья", cuisine: "italian", category: "pasta", mealTypes: ["dinner"] }]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/row 2 .*cuisine "klingon"/);
    expect(errors[1]).toMatch(/row 3 .*category "casserole"/);
    expect(errors[1]).toMatch(/mealType "brunch"/);
    expect(errors[2]).toMatch(/row 4 .*duplicate/);
    expect(errors[3]).toMatch(/row 5/);
  });

  it("reports a file that is not an array", () => {
    expect(validateCategorizerTruth({}, vocab).errors[0]).toMatch(/array/);
  });
});

const truth: CategorizerLabel[] = [
  { videoId: "v1", segmentIndex: 0, dish: "Лазанья", cuisine: "italian", category: "pasta", mealTypes: ["dinner"] },
  { videoId: "v1", segmentIndex: 1, dish: "Суп", cuisine: "russian", category: "soup", mealTypes: ["lunch", "dinner"] },
];

function out(p: Partial<Categorization>): Categorization {
  return { cuisine: "italian", category: "pasta", mealTypes: ["dinner"], activeMinutes: null, totalMinutes: null, richness: "medium", dishKey: "lasagna", ...p };
}
function ok(variant: string, repeat: number, segmentIndex: number, output: Categorization, ms = 100, rawCuisine = output.cuisine): CategorizerCase {
  return { variant, repeat, videoId: "v1", segmentIndex, ok: true, output, rawCuisine, ms };
}

describe("scoreCategorizer", () => {
  const cases: CategorizerCase[] = [
    ok("a", 0, 0, out({})),
    ok("a", 1, 0, out({})),
    ok("a", 0, 1, out({ cuisine: "russian", category: "soup", mealTypes: ["dinner", "lunch"], dishKey: "soup" })),
    ok("a", 1, 1, out({ cuisine: "russian", category: "soup", mealTypes: ["lunch"], dishKey: "borscht" }), 300),
    ok("b", 0, 0, out({ cuisine: "other" })),
    { variant: "b", repeat: 1, videoId: "v1", segmentIndex: 0, ok: false, error: "effort not supported", ms: 5 },
    ok("b", 0, 1, out({ cuisine: "other", category: "soup", mealTypes: ["breakfast"], dishKey: "soup" })),
    ok("b", 1, 1, out({ cuisine: "other", category: "soup", mealTypes: ["breakfast"], dishKey: "soup" })),
  ];
  const scored = scoreCategorizer(cases, truth, ["a", "b"], 2);

  it("scores accuracy, meal types and dishKey stability with interval and counts", () => {
    const a = scored.variants.find((v) => v.variant === "a")!;
    expect(a).toMatchObject({ cases: 4, errors: 0, meanLatencyMs: 150 });
    expect(a.cuisine).toMatchObject({ hits: 4, total: 4, rate: 1 });
    expect(a.category).toMatchObject({ hits: 4, total: 4 });
    expect(a.mealTypesExact).toMatchObject({ hits: 3, total: 4, rate: 0.75 });
    expect(a.cuisine.ci![0]).toBeGreaterThan(0.4);
    // jaccard: 1, 1, 1 ({dinner,lunch} vs same), 0.5 ({lunch} vs {lunch,dinner})
    expect(a.mealTypesJaccard).toBeCloseTo(3.5 / 4);
    expect(a.dishKeyStability).toMatchObject({ hits: 1, total: 2 });
  });

  it("counts a failed call as a miss everywhere, including stability", () => {
    const b = scored.variants.find((v) => v.variant === "b")!;
    expect(b).toMatchObject({ cases: 4, errors: 1, meanLatencyMs: 100 });
    expect(b.cuisine).toMatchObject({ hits: 0, total: 4 });
    expect(b.category).toMatchObject({ hits: 3, total: 4 });
    expect(b.mealTypesExact).toMatchObject({ hits: 1, total: 4 });
    expect(b.mealTypesJaccard).toBeCloseTo(0.25);
    expect(b.dishKeyStability).toMatchObject({ hits: 1, total: 2 });
  });

  it("scores the raw cuisine, so an invented cuisine coerced to other is not credited", () => {
    const otherTruth: CategorizerLabel[] = [{ ...truth[0], cuisine: "other" }];
    const s = scoreCategorizer([ok("x", 0, 0, out({ cuisine: "other" }), 1, "klingon"), ok("x", 1, 0, out({ cuisine: "other" }), 1, "other")], otherTruth, ["x"], 2);
    expect(s.variants[0].cuisine).toMatchObject({ hits: 1, total: 2 });
  });

  it("leaves stability empty for a single repeat", () => {
    expect(scoreCategorizer(cases.filter((c) => c.repeat === 0), truth, ["a", "b"], 1).variants[0].dishKeyStability).toBeNull();
  });

  it("reports pairwise dishKey agreement on each variant's first answer", () => {
    expect(scored.agreement).toEqual([{ a: "a", b: "b", agreement: expect.objectContaining({ hits: 2, total: 2, rate: 1 }) }]);
  });

  it("gives zero rates for a variant whose every call failed", () => {
    const s = scoreCategorizer([{ variant: "x", repeat: 0, videoId: "v1", segmentIndex: 0, ok: false, error: "no", ms: 1 }], truth, ["x"], 1);
    expect(s.variants[0]).toMatchObject({ errors: 1, cuisine: { hits: 0, total: 1, rate: 0 }, mealTypesJaccard: 0, meanLatencyMs: null });
  });
});
