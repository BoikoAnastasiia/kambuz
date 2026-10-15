import { describe, it, expect, vi } from "vitest";
import { buildProofreaderUser, buildTranslatorUser, checkTranslation, englishSourceFor, targetsOf, translateRecipe } from "../../src/agents/translator.js";
import type { Recipe, TranslationWire } from "../../src/schemas/recipe.js";
import type { VideoSource } from "../../src/schemas/source.js";
import { config } from "../../src/config.js";

const recipe = {
  id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht",
  ingredients: [
    { ingredient: "beet", rawName: "две свёклы", baseName: "свёкла", quantity: 2, unit: "pc", provenance: "stated", note: "нарезать соломкой" },
    { ingredient: "salt", rawName: "соль", baseName: "соль", quantity: null, unit: null, provenance: "unknown", note: "количество не названо" },
  ],
  steps: [
    { order: 1, text: "Варить бульон 2 часа.", timestamp: 0 },
    { order: 2, text: "Запекать при 180 градусах.", timestamp: 10 },
  ],
  source: { videoId: "v1", segmentStart: 10, segmentEnd: 20 },
} as unknown as Recipe;

const good: TranslationWire = {
  name: "Borscht",
  steps: ["Simmer the broth for 2 hours.", "Bake at 180°C."],
  ingredients: [{ name: "beets", note: "cut into matchsticks" }, { name: "salt", note: null }],
};

const models = { translator: config.models.translator, proofreader: config.models.proofreader };

/** Translator, fixer and proofreader answers, each taken in order. The fixer is the translator asked to rewrite lines. */
function llmAnswering(translations: TranslationWire[], reviews: unknown[][], fixes: unknown[] = []) {
  return {
    callStructured: vi.fn(async ({ agent, user }: any): Promise<any> => {
      if (agent === "translator") return user.includes("Rewrite only these lines") ? fixes.shift() : translations.shift();
      if (agent === "proofreader") return { issues: reviews.shift() };
      throw new Error(agent);
    }),
  };
}

const issue = { item: "step 1", kind: "meaning" as const, russian: "Варить бульон 2 часа.", english: "Fry the broth for 2 hours.", explanation: "boil, not fry" };
const fried = { ...good, steps: ["Fry the broth for 2 hours.", "Bake at 180°C."] };

describe("checkTranslation", () => {
  it("passes a faithful translation", () => {
    expect(checkTranslation(recipe, good)).toEqual([]);
  });

  it("catches a dropped step or ingredient, leftover Russian, a lost number and a bare temperature", () => {
    const problems = checkTranslation(recipe, {
      name: "Borscht",
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

  it("accepts a small number written as a word, and rejects an empty name", () => {
    expect(checkTranslation(recipe, { ...good, steps: ["Simmer the broth for two hours.", "Bake at 180°C."] })).toEqual([]);
    expect(checkTranslation(recipe, { ...good, name: " " })).toEqual(["the dish name is empty"]);
  });
});

describe("buildTranslatorUser", () => {
  it("sends the name, steps, the plain ingredient names and notes, and appends earlier problems when retrying", () => {
    const user = buildTranslatorUser(recipe, ["step 1: the number 2 is missing"]);
    const input = JSON.parse(user.split("\n\nAn earlier")[0]);
    expect(input).toEqual({
      dish: "Борщ",
      draftEnglishName: "Borscht",
      steps: ["Варить бульон 2 часа.", "Запекать при 180 градусах."],
      ingredients: [{ name: "свёкла", note: "нарезать соломкой" }, { name: "соль", note: "количество не названо" }],
    });
    expect(user).toContain("- step 1: the number 2 is missing");
  });

  it("adds the chef's English transcript when there is one", () => {
    expect(buildTranslatorUser(recipe, [], { originalTranscript: "[00:12] boil the broth" })).toContain("The chef spoke English. Original transcript of this dish:\n[00:12] boil the broth");
  });
});

describe("englishSourceFor", () => {
  const source = (over: Partial<VideoSource>): VideoSource =>
    ({ language: "en", captionKind: "spoken", cues: [{ start: 5, end: 8, text: "intro" }, { start: 12, end: 14, text: "boil the broth" }], ...over }) as VideoSource;

  it("gives the dish's slice of English speech or subtitles", () => {
    expect(englishSourceFor(recipe, source({}))).toEqual({ originalTranscript: "[00:12] boil the broth" });
    expect(englishSourceFor(recipe, source({ language: "en-US", captionKind: "author" })).originalTranscript).toContain("boil the broth");
  });

  it("gives nothing for Russian text, chapter titles or an unknown video", () => {
    expect(englishSourceFor(recipe, source({ language: "ru" }))).toEqual({});
    expect(englishSourceFor(recipe, source({ captionKind: "chapters" }))).toEqual({});
    expect(englishSourceFor(recipe, null)).toEqual({});
  });
});

describe("targetsOf", () => {
  it("reads the lines a finding points at", () => {
    const t = targetsOf([
      { ...issue, item: "step 5 / steps 6, 19 and 20" },
      { ...issue, item: "ingredient 3" },
      { ...issue, item: "name" },
    ])!;
    expect([...t.steps]).toEqual([5, 6, 19, 20]);
    expect([...t.ingredients]).toEqual([3]);
    expect(t.name).toBe(true);
  });

  it("gives up on an item it can't read, so the whole recipe is redone", () => {
    expect(targetsOf([{ ...issue, item: "the whole method" }])).toBeNull();
  });
});

describe("buildProofreaderUser", () => {
  it("lists the name first, and narrows a re-check to the corrected lines", () => {
    const user = buildProofreaderUser(recipe, good, {}, { name: false, steps: new Set([1]), ingredients: new Set() });
    expect(user).toContain("name\nRU: Борщ\nEN: Borscht");
    expect(user).toContain("Check only them, using the rest as context: step 1.");
  });
});

describe("translateRecipe", () => {
  it("returns the translation with its models and a clean review once the proofreader finds nothing", async () => {
    const llm = llmAnswering([good], [[]]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out).toMatchObject({ ok: true, en: { ...good, model: "claude-sonnet-5-5", proofreader: "claude-opus-5-5", review: { rounds: 1, findings: [] }, fromEnglishSource: false } });
    expect(llm.callStructured.mock.calls.map((c: any) => c[0].agent)).toEqual(["translator", "proofreader"]);
  });

  it("rewrites only the flagged line, re-checks only that line, and keeps what was found", async () => {
    const llm = llmAnswering([fried], [[issue], []], [{ name: null, steps: [{ step: 1, text: "Simmer the broth for 2 hours." }], ingredients: [] }]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out).toMatchObject({ ok: true, en: { steps: good.steps, name: "Borscht", review: { rounds: 2, findings: [issue] } } });
    const calls = llm.callStructured.mock.calls.map((c: any) => c[0]);
    expect(calls.map((c: any) => c.agent)).toEqual(["translator", "proofreader", "translator", "proofreader"]);
    expect(calls[2].user).toContain("Rewrite only these lines: step 1.");
    expect(calls[2].user).toContain("boil, not fry");
    expect(calls[3].user).toContain("Check only them, using the rest as context: step 1.");
  });

  it("retranslates everything when a finding names no line", async () => {
    const vague = { ...issue, item: "overall tone" };
    const llm = llmAnswering([fried, good], [[vague], []]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models);
    expect(out.ok).toBe(true);
    expect(llm.callStructured.mock.calls[2][0].user).toContain("An earlier translation of this recipe had these problems");
    expect(llm.callStructured.mock.calls[3][0].user).not.toContain("Check only them");
  });

  it("gives up when the corrected line still has issues, returning them", async () => {
    const llm = llmAnswering([fried], [[issue], [issue]], [{ name: null, steps: [{ step: 1, text: "Fry the broth for 2 hours." }], ingredients: [] }]);
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

  it("marks a translation made with the chef's English transcript", async () => {
    const llm = llmAnswering([good], [[]]);
    const out = await translateRecipe(recipe, llm, config.paths.prompts, models, { originalTranscript: "[00:12] boil the broth" });
    expect(out).toMatchObject({ ok: true, en: { fromEnglishSource: true } });
    expect(llm.callStructured.mock.calls[1][0].user).toContain("The chef spoke English.");
  });
});
