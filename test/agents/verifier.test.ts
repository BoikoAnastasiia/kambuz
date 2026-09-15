import { describe, it, expect, vi } from "vitest";
import { runVerifier, flagsFromVerification } from "../../src/agents/verifier.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import { config } from "../../src/config.js";

const draft: DraftRecipe = {
  nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
  ingredients: [
    { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
    { ingredient: "beef-mince", rawName: "фарш", quantity: 500, unit: "g", provenance: "stated", note: null },
    { ingredient: "salt", rawName: "соль", quantity: null, unit: null, provenance: "unknown", note: null },
  ],
  steps: [{ order: 1, text: "Нарезать лук.", timestamp: 30 }, { order: 2, text: "Обжарить фарш.", timestamp: 60 }],
};
const segment: ScoutSegment = { workingName: "лазанья", start: 0, end: 100, rawText: "нарежем кубиком лук добавляем фарш", cleanText: "" };

describe("flagsFromVerification", () => {
  it("flags unsupported stated/inferred ingredients and steps, never unknown ones", () => {
    const flags = flagsFromVerification(draft, {
      ingredients: [
        { rawName: "лук", quote: "нарежем кубиком лук", supported: true },
        { rawName: "фарш", quote: null, supported: false },
      ],
      steps: [{ order: 1, quote: "нарежем", supported: true }, { order: 2, quote: null, supported: false }],
      confidence: 0.7,
    });
    expect(flags).toEqual([
      { kind: "ingredient", ref: "фарш", reason: "quantity or presence not supported by transcript" },
      { kind: "step", ref: "2", reason: "action not found in transcript" },
    ]);
  });

  it("flags a stated/inferred ingredient entirely missing from v.ingredients", () => {
    const flags = flagsFromVerification(draft, {
      ingredients: [{ rawName: "лук", quote: "нарежем кубиком лук", supported: true }],
      steps: [{ order: 1, quote: "нарежем", supported: true }, { order: 2, quote: "обжарить", supported: true }],
      confidence: 0.7,
    });
    expect(flags).toEqual([
      { kind: "ingredient", ref: "фарш", reason: "quantity or presence not supported by transcript" },
    ]);
  });

  it("does not flag a step whose order has no counterpart in v.steps", () => {
    const flags = flagsFromVerification(draft, {
      ingredients: [
        { rawName: "лук", quote: "нарежем кубиком лук", supported: true },
        { rawName: "фарш", quote: "фарш", supported: true },
      ],
      steps: [{ order: 1, quote: "нарежем", supported: true }],
      confidence: 0.7,
    });
    expect(flags).toEqual([]);
  });

  it("matches ingredient rawName case- and whitespace-insensitively across independent LLM outputs", () => {
    const flags = flagsFromVerification(draft, {
      ingredients: [
        { rawName: " Лук ", quote: "нарежем кубиком лук", supported: true },
        { rawName: "фарш", quote: "фарш", supported: true },
      ],
      steps: [{ order: 1, quote: "нарежем", supported: true }, { order: 2, quote: "обжарить", supported: true }],
      confidence: 0.7,
    });
    expect(flags).toEqual([]);
  });
});

describe("runVerifier", () => {
  it("sends raw text and the draft to the verifier agent", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ ingredients: [], steps: [], confidence: 1 })) };
    await runVerifier(segment, draft, llm as any, config.paths.prompts);
    const call = llm.callStructured.mock.calls[0][0];
    expect(call.agent).toBe("verifier");
    expect(call.user).toContain("нарежем кубиком лук");
    expect(call.user).toContain("Обжарить фарш");
  });
});
