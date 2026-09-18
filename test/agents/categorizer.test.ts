import { describe, it, expect, vi } from "vitest";
import { runCategorizer, runCategorizerDetailed, buildCategorizerUser, slugify } from "../../src/agents/categorizer.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [{ id: "italian", nameRu: "", nameEn: "" }, { id: "other", nameRu: "", nameEn: "" }],
  courses: [{ id: "main", nameRu: "", nameEn: "" }],
  methods: [{ id: "bake", nameRu: "", nameEn: "" }],
  ingredients: [],
};
const draft: DraftRecipe = { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, ingredients: [], steps: [], unmappedIngredients: [] };
const base = { mealTypes: ["dinner"], course: "main", method: "bake", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };

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
  it("includes the draft name and the cuisine, course and method ids from vocab", () => {
    const u = buildCategorizerUser(draft, vocab);
    expect(u).toContain("Лазанья с соусом болоньезе");
    expect(u).toContain("italian");
    expect(u).toContain("other");
    expect(u).toContain("main");
    expect(u).toContain("bake");
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
  it("keeps an unknown course instead of throwing, so only that recipe is rejected later", async () => {
    // Throwing here killed the whole video; validateRecipe reports the bad course and
    // the orchestrator drops just this recipe.
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", course: "casserole", dishKey: "x" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.course).toBe("casserole");
  });

  it("coerces an unknown method to null", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: "sous-vide", dishKey: "x" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.method).toBeNull();
  });

  it("keeps a null method as-is", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: null, dishKey: "x" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.method).toBeNull();
  });

  it("keeps a known method as-is", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: "bake", dishKey: "x" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.method).toBe("bake");
  });

  it("asks the model for a loose dishKey and slugifies the answer itself", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ ...base, cuisine: "italian", dishKey: "Lasagna Bolognese!" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.dishKey).toBe("lasagna-bolognese");
    // a regex the SDK cannot enforce would make messages.parse() throw instead
    const schema = llm.callStructured.mock.calls[0][0].schema;
    expect(schema.safeParse({ ...base, cuisine: "italian", dishKey: "Lasagna Bolognese!" }).success).toBe(true);
  });

  it("runCategorizerDetailed keeps the raw cuisine next to the coerced one", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "klingon", dishKey: "x" })) };
    const r = await runCategorizerDetailed(draft, vocab, llm as any, config.paths.prompts);
    expect(r.categorization.cuisine).toBe("other");
    expect(r.rawCuisine).toBe("klingon");
  });

  it("runCategorizerDetailed keeps the raw method next to the coerced one, so an invented method scored against a null label isn't credited", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: "sous-vide", dishKey: "x" })) };
    const r = await runCategorizerDetailed(draft, vocab, llm as any, config.paths.prompts);
    expect(r.categorization.method).toBeNull();
    expect(r.rawMethod).toBe("sous-vide");
  });

  it("runCategorizerDetailed's rawMethod is null when the model legitimately answers null", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: null, dishKey: "x" })) };
    const r = await runCategorizerDetailed(draft, vocab, llm as any, config.paths.prompts);
    expect(r.categorization.method).toBeNull();
    expect(r.rawMethod).toBeNull();
  });

  it("runCategorizerDetailed's rawMethod matches the coerced value when the method is in vocab", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", method: "bake", dishKey: "x" })) };
    const r = await runCategorizerDetailed(draft, vocab, llm as any, config.paths.prompts);
    expect(r.categorization.method).toBe("bake");
    expect(r.rawMethod).toBe("bake");
  });
});
