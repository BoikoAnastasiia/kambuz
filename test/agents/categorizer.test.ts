import { describe, it, expect, vi } from "vitest";
import { runCategorizer, slugify } from "../../src/agents/categorizer.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [{ id: "italian", nameRu: "", nameEn: "" }, { id: "other", nameRu: "", nameEn: "" }],
  categories: [{ id: "pasta", nameRu: "", nameEn: "" }],
  ingredients: [],
};
const draft: DraftRecipe = { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, ingredients: [], steps: [], unmappedIngredients: [] };
const base = { mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };

describe("slugify", () => {
  it("normalizes to a dish key", () => {
    expect(slugify(" Lasagna  Bolognese! ")).toBe("lasagna-bolognese");
  });
});

describe("runCategorizer", () => {
  it("falls back to other for unknown cuisine and slugifies dishKey", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "klingon", dishKey: "lasagna-bolognese" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.cuisine).toBe("other");
    expect(c.dishKey).toBe("lasagna-bolognese");
  });
  it("throws on unknown category", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", category: "casserole", dishKey: "x" })) };
    await expect(runCategorizer(draft, vocab, llm as any, config.paths.prompts)).rejects.toThrow(/unknown category/);
  });
});
