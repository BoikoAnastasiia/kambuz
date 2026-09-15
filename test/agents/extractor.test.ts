import { describe, it, expect, vi } from "vitest";
import { runExtractor, buildExtractorUser } from "../../src/agents/extractor.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [], categories: [],
  ingredients: [{ id: "onion", nameRu: "Лук", nameEn: "Onion", aliases: [] }],
};
const segment: ScoutSegment = { workingName: "лазанья", start: 30, end: 200, rawText: "raw", cleanText: "Нарежем кубиком лук. Добавим фарш." };

describe("buildExtractorUser", () => {
  it("includes working name, range, clean text and the vocabulary", () => {
    const u = buildExtractorUser(segment, vocab);
    expect(u).toContain("лазанья");
    expect(u).toContain("onion — Лук / Onion");
    expect(u).toContain("Нарежем кубиком лук");
  });
});

describe("runExtractor", () => {
  it("nulls unknown ingredient ids, records them as unmapped, and renumbers steps by timestamp", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({
      nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
      ingredients: [
        { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
        { ingredient: "minced-unicorn", rawName: "фарш", quantity: null, unit: null, provenance: "unknown", note: null },
      ],
      steps: [
        { order: 1, text: "Добавить фарш.", timestamp: 90 },
        { order: 2, text: "Нарезать лук.", timestamp: 10 },
      ],
    })) };
    const r = await runExtractor(segment, vocab, llm as any, config.paths.prompts);
    expect(r.ingredients[1].ingredient).toBeNull();
    expect(r.unmappedIngredients).toEqual(["фарш"]);
    expect(r.steps.map((s) => [s.order, s.timestamp])).toEqual([[1, 30], [2, 90]]);
    expect(llm.callStructured.mock.calls[0][0].agent).toBe("extractor");
  });

  it("includes the rawName of a model-nulled ingredient in unmappedIngredients even when the model omitted it", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({
      nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
      ingredients: [
        { ingredient: null, rawName: "неизвестный ингредиент", quantity: null, unit: null, provenance: "unknown", note: null },
      ],
      steps: [],
    })) };
    const r = await runExtractor(segment, vocab, llm as any, config.paths.prompts);
    expect(r.unmappedIngredients).toEqual(["неизвестный ингредиент"]);
  });
});
