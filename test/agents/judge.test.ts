import { describe, it, expect, vi } from "vitest";
import { jaccard, findCandidates, completeness, decide, runJudge } from "../../src/agents/judge.js";
import type { Recipe } from "../../src/schemas/recipe.js";
import { config } from "../../src/config.js";

function recipe(over: Partial<Recipe> & { ingredientIds?: string[] }): Recipe {
  const { ingredientIds = [], ...rest } = over;
  return {
    id: "x", nameRu: "X", nameEn: "X", dishKey: "x", cuisine: "other", mealTypes: ["dinner"], course: "main", method: "stew", richness: "medium",
    servings: null, activeMinutes: null, totalMinutes: null, flags: [], completeness: 0.5, extractedAt: "", models: {},
    ingredients: ingredientIds.map((id) => ({ ingredient: id, rawName: id, quantity: 1, unit: "pc", provenance: "stated" as const, note: null })),
    steps: [],
    source: { videoId: "v", url: "", videoTitle: "", channel: "", channelId: "", segmentStart: 0, segmentEnd: 0, language: "ru" },
    ...rest,
  };
}

describe("jaccard", () => {
  it("computes overlap", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("findCandidates", () => {
  it("matches by dishKey or ingredient overlap >= 0.6", () => {
    const catalog = [
      recipe({ id: "1", dishKey: "borscht", ingredientIds: ["beet", "cabbage"] }),
      recipe({ id: "2", dishKey: "plov", ingredientIds: ["rice", "lamb", "carrot", "onion"] }),
      recipe({ id: "3", dishKey: "salad", ingredientIds: ["cucumber"] }),
    ];
    const incoming = recipe({ dishKey: "borscht-beans", ingredientIds: ["rice", "lamb", "carrot", "onion", "garlic"] });
    expect(findCandidates(incoming, catalog).map((r) => r.id)).toEqual(["2"]);
    expect(findCandidates(recipe({ dishKey: "borscht" }), catalog).map((r) => r.id)).toEqual(["1"]);
  });
});

describe("completeness", () => {
  const ing = (p: "stated" | "inferred" | "unknown") => ({ ingredient: null, rawName: "r", quantity: null, unit: null, provenance: p, note: null });

  it("rewards cookability (having enough ingredients AND steps) far more than stated quantities", () => {
    // 9 ingredients (all unknown provenance) + 11 steps + no flags: cookability maxes out,
    // no ingredient is quantified — full cookability weight, zero quantity weight.
    expect(
      completeness({ ingredients: new Array(9).fill(ing("unknown")), flags: [], steps: new Array(11) }),
    ).toBeCloseTo(0.9);
  });

  it("scores a one-ingredient recipe low even with plenty of steps — the owner's 'Тефтели с сыром' case", () => {
    // 1 ingredient, 5 steps: ingredientScore = 1/5 = 0.2, stepScore = 5/6 = 0.8333,
    // cookability = 0.2 * 0.8333 = 0.16667, weighted 0.9 * 0.16667 = 0.15.
    expect(completeness({ ingredients: [ing("unknown")], flags: [], steps: new Array(5) })).toBeCloseTo(0.15);
  });

  it("adds the quantity bonus on top of a maxed-out cookability score", () => {
    // 12 ingredients (5 quantified), 18 steps, no flags: cookability maxes at 1 (both
    // over their full-score thresholds), plus 0.1 * (5/12) for the quantified share.
    const ingredients = [...new Array(5).fill(ing("stated")), ...new Array(7).fill(ing("unknown"))];
    expect(completeness({ ingredients, flags: [], steps: new Array(18) })).toBeCloseTo(0.9 + 0.1 * (5 / 12));
  });

  it("subtracts 0.1 per verifier flag", () => {
    const base = completeness({ ingredients: new Array(12).fill(ing("unknown")), flags: [], steps: new Array(18) });
    const flagged = completeness({
      ingredients: new Array(12).fill(ing("unknown")),
      flags: [{ kind: "step", ref: "1", reason: "" }, { kind: "step", ref: "2", reason: "" }],
      steps: new Array(18),
    });
    expect(base - flagged).toBeCloseTo(0.2);
  });

  it("is 0 for a recipe with no ingredients", () => {
    expect(completeness({ ingredients: [], flags: [], steps: [] })).toBe(0);
  });
});

describe("decide", () => {
  it("replaces when same and incoming is more complete; keeps existing on tie", () => {
    const existing = recipe({ id: "old", completeness: 0.5 });
    expect(decide(existing, recipe({ id: "new", completeness: 0.7 }), { relation: "same", reason: "", newNameRu: null, existingNameRu: null }).action).toBe("replace");
    expect(decide(existing, recipe({ id: "new", completeness: 0.5 }), { relation: "same", reason: "", newNameRu: null, existingNameRu: null }).action).toBe("keep-existing");
  });
  it("keeps both and renames on variant", () => {
    const r = decide(recipe({ id: "old" }), recipe({ id: "new" }), { relation: "variant", reason: "", newNameRu: "Лазанья овощная", existingNameRu: "Лазанья с соусом болоньезе" });
    expect(r.action).toBe("keep-both");
    expect(r.incoming.nameRu).toBe("Лазанья овощная");
    expect(r.existing.nameRu).toBe("Лазанья с соусом болоньезе");
  });
});

describe("runJudge", () => {
  it("calls the judge agent with both recipes", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ relation: "same", reason: "r", newNameRu: null, existingNameRu: null })) };
    const d = await runJudge(recipe({ nameRu: "Старый" }), recipe({ nameRu: "Новый" }), llm as any, config.paths.prompts);
    expect(d.relation).toBe("same");
    expect(llm.callStructured.mock.calls[0][0].user).toContain("Старый");
  });
});
