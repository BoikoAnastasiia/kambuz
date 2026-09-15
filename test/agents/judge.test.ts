import { describe, it, expect, vi } from "vitest";
import { jaccard, findCandidates, completeness, decide, runJudge } from "../../src/agents/judge.js";
import type { Recipe } from "../../src/schemas/recipe.js";
import { config } from "../../src/config.js";

function recipe(over: Partial<Recipe> & { ingredientIds?: string[] }): Recipe {
  const { ingredientIds = [], ...rest } = over;
  return {
    id: "x", nameRu: "X", nameEn: "X", dishKey: "x", cuisine: "other", mealTypes: ["dinner"], category: "stew", richness: "medium",
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
  it("is the share of quantified ingredients minus flags plus small bonuses, clamped", () => {
    const ing = (p: "stated" | "inferred" | "unknown") => ({ ingredient: null, rawName: "r", quantity: null, unit: null, provenance: p, note: null });
    expect(completeness({ ingredients: [ing("stated"), ing("unknown")], flags: [], steps: [], rawTextLength: 0 })).toBeCloseTo(0.5);
    expect(completeness({ ingredients: [ing("stated")], flags: [{ kind: "step", ref: "1", reason: "" }], steps: [], rawTextLength: 0 })).toBeCloseTo(0.9);
    expect(completeness({ ingredients: [ing("stated")], flags: [], steps: new Array(20), rawTextLength: 10000 })).toBeCloseTo(1);
    expect(completeness({ ingredients: [], flags: [], steps: [], rawTextLength: 0 })).toBe(0);
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
