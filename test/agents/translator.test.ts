import { describe, it, expect, vi } from "vitest";
import { buildTranslatorUser, checkTranslation, translateRecipe } from "../../src/agents/translator.js";
import type { Recipe, TranslationWire } from "../../src/schemas/recipe.js";
import { config } from "../../src/config.js";

const recipe = {
  id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht",
  ingredients: [
    { ingredient: "beet", rawName: "свёкла", baseName: "свёкла", quantity: 2, unit: "pc", provenance: "stated", note: "нарезать соломкой" },
    { ingredient: "salt", rawName: "соль", baseName: "соль", quantity: null, unit: null, provenance: "unknown", note: "количество не названо" },
  ],
  steps: [
    { order: 1, text: "Варить бульон 2 часа.", timestamp: 0 },
    { order: 2, text: "Запекать при 180 градусах.", timestamp: 10 },
  ],
} as unknown as Recipe;

const good: TranslationWire = {
  steps: ["Simmer the broth for 2 hours.", "Bake at 180°C."],
  ingredients: [{ name: "beets", note: "cut into matchsticks" }, { name: "salt", note: null }],
};

const models = { translator: config.models.translator, proofreader: config.models.proofreader };

function llmAnswering(translations: TranslationWire[], reviews: unknown[][]) {
  return {
    callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
      if (agent === "translator") return translations.shift();
      if (agent === "proofreader") return { issues: reviews.shift() };
      throw new Error(agent);
    }),
  };
}

const issue = { item: "step 1", kind: "meaning", russian: "Варить бульон 2 часа.", english: "Fry the broth for 2 hours.", explanation: "boil, not fry" };

describe("checkTranslation", () => {
  it("passes a faithful translation", () => {
    expect(checkTranslation(recipe, good)).toEqual([]);
  });

  it("catches a dropped step or ingredient, leftover Russian, a lost number and a bare temperature", () => {
    const problems = checkTranslation(recipe, {
      steps: ["Simmer the broth for hours.", "Bake at 180 degrees."],
      ingredients: [{ name: "свёкла", note: null }],
    });
    expect(problems).toEqual([
      "1 English ingredients for 2 Russian ones: keep one entry per ingredient",
      "Russian (Cyrillic) text was left in the English",
      "step 1: the number 2 is missing",
      "step 2: write the temperature as °C",
    ]);
  });

  it("accepts a small number written as a word", () => {
    expect(checkTranslation(recipe, { ...good, steps: ["Simmer the broth for two hours.", "Bake at 180°C."] })).toEqual([]);
  });
});

describe("buildTranslatorUser", () => {
  it("sends steps, raw ingredient names and notes, and appends earlier problems when retrying", () => {
    const user = buildTranslatorUser(recipe, ["step 1: the number 2 is missing"]);
    const input = JSON.parse(user.split("\n\nAn earlier")[0]);
    expect(input).toEqual({
      dish: "Борщ (Borscht)",
      steps: ["Варить бульон 2 часа.", "Запекать при 180 градусах."],
      ingredients: [{ name: "свёкла", note: "нарезать соломкой" }, { name: "соль", note: "количество не названо" }],
    });
    expect(user).toContain("- step 1: the number 2 is missing");
  });
});

describe("translateRecipe", () => {
  it("returns the translation with its models once the proofreader finds nothing", async () => {
    const llm = llmAnswering([good], [[]]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out).toMatchObject({ ok: true, en: { ...good, model: "claude-sonnet-5-5", proofreader: "claude-opus-5-5" } });
    expect(llm.callStructured.mock.calls.map((c: any) => c[0].agent)).toEqual(["translator", "proofreader"]);
  });

  it("hands the proofreader's issues back to the translator once, and accepts the fixed version", async () => {
    const llm = llmAnswering([{ ...good, steps: ["Fry the broth for 2 hours.", "Bake at 180°C."] }, good], [[issue], []]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out.ok).toBe(true);
    expect(llm.callStructured.mock.calls.map((c: any) => c[0].agent)).toEqual(["translator", "proofreader", "translator", "proofreader"]);
    expect(llm.callStructured.mock.calls[2][0].user).toContain("boil, not fry");
  });

  it("gives up when the second translation still has issues, returning them", async () => {
    const llm = llmAnswering([good, good], [[issue], [issue]]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out).toEqual({ ok: false, problems: ['step 1 [meaning]: «Варить бульон 2 часа.» → "Fry the broth for 2 hours." — boil, not fry'] });
  });

  it("retries a translation that fails the code checks before paying for a proofread", async () => {
    const llm = llmAnswering([{ ...good, ingredients: [good.ingredients[0]] }, good], [[]]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out.ok).toBe(true);
    expect(llm.callStructured.mock.calls.map((c: any) => c[0].agent)).toEqual(["translator", "translator", "proofreader"]);
  });

  it("gives up without a proofread when the retry still fails the code checks", async () => {
    const bad = { ...good, ingredients: [good.ingredients[0]] };
    const llm = llmAnswering([bad, bad], []);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out).toEqual({ ok: false, problems: ["1 English ingredients for 2 Russian ones: keep one entry per ingredient"] });
    expect(llm.callStructured.mock.calls.map((c: any) => c[0].agent)).toEqual(["translator", "translator"]);
  });
});
