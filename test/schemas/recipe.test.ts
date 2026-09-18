import { describe, it, expect } from "vitest";
import {
  DraftRecipeSchema,
  CategorizationSchema,
  CategorizationWireSchema,
  VerificationSchema,
  VerificationWireSchema,
} from "../../src/schemas/recipe.js";

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
    const base = { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: "bake", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };
    expect(() => CategorizationSchema.parse({ ...base, dishKey: "Lasagna Bolognese" })).toThrow();
    expect(CategorizationSchema.parse({ ...base, dishKey: "lasagna-bolognese" }).dishKey).toBe("lasagna-bolognese");
  });
  it("accepts a null method", () => {
    const base = { cuisine: "italian", mealTypes: ["dinner"], course: "salad", method: null, activeMinutes: 40, totalMinutes: 90, richness: "light", dishKey: "cabbage-salad" };
    expect(CategorizationSchema.parse(base).method).toBeNull();
  });
});

// The SDK cannot express `pattern`/`minimum`/`maximum` in a structured-output schema:
// it drops them into the field description and messages.parse() THROWS when the model
// writes something the Zod schema then rejects. The wire schemas are what the model is
// asked for; the agents normalize, and the strict schemas guard what is persisted.
describe("wire schemas for structured output", () => {
  const base = { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: "bake", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };

  it("accepts an un-slugified dishKey that the strict schema rejects", () => {
    expect(CategorizationWireSchema.parse({ ...base, dishKey: "Lasagna Bolognese!" }).dishKey).toBe("Lasagna Bolognese!");
    expect(CategorizationSchema.safeParse({ ...base, dishKey: "Lasagna Bolognese!" }).success).toBe(false);
  });

  it("accepts a confidence outside 0–1 that the strict schema rejects", () => {
    const v = { ingredients: [], steps: [], confidence: 1.5 };
    expect(VerificationWireSchema.parse(v).confidence).toBe(1.5);
    expect(VerificationSchema.safeParse(v).success).toBe(false);
  });
});
