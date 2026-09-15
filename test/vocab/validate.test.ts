import { describe, it, expect } from "vitest";
import { validateRecipe, ingredientPromptList } from "../../src/vocab/validate.js";
import { loadVocab } from "../../src/vocab/load.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [{ id: "italian", nameRu: "Итальянская", nameEn: "Italian" }],
  categories: [{ id: "pasta", nameRu: "Паста", nameEn: "Pasta" }],
  ingredients: [{ id: "onion", nameRu: "Лук", nameEn: "Onion", aliases: ["лук репчатый"] }],
};
const ing = (ingredient: string | null) => ({ ingredient, rawName: "x", quantity: null, unit: null, provenance: "unknown" as const, note: null });

describe("validateRecipe", () => {
  it("returns no errors for known ids", () => {
    expect(validateRecipe({ cuisine: "italian", category: "pasta", ingredients: [ing("onion"), ing(null)] }, vocab)).toEqual([]);
  });
  it("reports unknown cuisine, category and ingredient ids", () => {
    const errors = validateRecipe({ cuisine: "martian", category: "soup", ingredients: [ing("unicorn")] }, vocab);
    expect(errors).toEqual([
      "unknown cuisine: martian",
      "unknown category: soup",
      "unknown ingredient: unicorn",
    ]);
  });
});

describe("ingredientPromptList", () => {
  it("renders one line per ingredient with aliases", () => {
    expect(ingredientPromptList(vocab)).toBe("onion — Лук / Onion (лук репчатый)");
  });
});

describe("loadVocab", () => {
  it("loads the real vocab files and every id is a slug", async () => {
    const v = await loadVocab(config.paths.vocab);
    for (const e of [...v.cuisines, ...v.categories, ...v.ingredients]) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(v.ingredients.length).toBeGreaterThanOrEqual(60);
  });
});
