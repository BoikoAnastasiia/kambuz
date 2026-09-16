import { describe, it, expect, vi } from "vitest";
import { runCategorizer, buildCategorizerUser, slugify } from "../../src/agents/categorizer.js";
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
  it("collapses repeated dashes", () => {
    expect(slugify("a--b")).toBe("a-b");
  });
  it("leaves an already-clean slug unchanged", () => {
    expect(slugify("lasagna-bolognese")).toBe("lasagna-bolognese");
  });
});

describe("buildCategorizerUser", () => {
  it("includes the draft name and the cuisine and category ids from vocab", () => {
    const u = buildCategorizerUser(draft, vocab);
    expect(u).toContain("Лазанья с соусом болоньезе");
    expect(u).toContain("italian");
    expect(u).toContain("other");
    expect(u).toContain("pasta");
  });
});

describe("runCategorizer", () => {
  it("falls back to other for unknown cuisine, slugifies dishKey, and calls the categorizer agent", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ ...base, cuisine: "klingon", dishKey: "lasagna-bolognese" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.cuisine).toBe("other");
    expect(c.dishKey).toBe("lasagna-bolognese");
    expect(llm.callStructured.mock.calls[0][0].agent).toBe("categorizer");
  });
  it("throws on unknown category", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", category: "casserole", dishKey: "x" })) };
    await expect(runCategorizer(draft, vocab, llm as any, config.paths.prompts)).rejects.toThrow(/unknown category/);
  });

  it("asks the model for a loose dishKey and slugifies the answer itself", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ ...base, cuisine: "italian", dishKey: "Lasagna Bolognese!" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.dishKey).toBe("lasagna-bolognese");
    // a regex the SDK cannot enforce would make messages.parse() throw instead
    const schema = llm.callStructured.mock.calls[0][0].schema;
    expect(schema.safeParse({ ...base, cuisine: "italian", dishKey: "Lasagna Bolognese!" }).success).toBe(true);
  });
});
