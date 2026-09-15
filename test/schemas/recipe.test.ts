import { describe, it, expect } from "vitest";
import { DraftRecipeSchema, CategorizationSchema } from "../../src/schemas/recipe.js";

describe("DraftRecipeSchema", () => {
  it("accepts a minimal valid draft", () => {
    const r = DraftRecipeSchema.parse({
      nameRu: "Лазанья с соусом болоньезе",
      nameEn: "Lasagna with bolognese",
      servings: null,
      ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
      steps: [{ order: 1, text: "Нарезать лук кубиком.", timestamp: 61 }],
      unmappedIngredients: [],
    });
    expect(r.ingredients[0].provenance).toBe("inferred");
  });
  it("rejects an unknown provenance", () => {
    expect(() =>
      DraftRecipeSchema.parse({
        nameRu: "x", nameEn: "x", servings: null, unmappedIngredients: [], steps: [],
        ingredients: [{ ingredient: null, rawName: "лук", quantity: null, unit: null, provenance: "guessed", note: null }],
      }),
    ).toThrow();
  });
});

describe("CategorizationSchema", () => {
  it("rejects a dishKey with spaces or uppercase", () => {
    const base = { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };
    expect(() => CategorizationSchema.parse({ ...base, dishKey: "Lasagna Bolognese" })).toThrow();
    expect(CategorizationSchema.parse({ ...base, dishKey: "lasagna-bolognese" }).dishKey).toBe("lasagna-bolognese");
  });
});
