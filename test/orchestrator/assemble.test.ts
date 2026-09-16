import { describe, it, expect } from "vitest";
import { assembleRecipe } from "../../src/orchestrator/assemble.js";

describe("assembleRecipe", () => {
  it("builds id from dishKey and videoId, attaches flags and completeness", () => {
    const r = assembleRecipe({
      source: { videoId: "v1", url: "u", title: "T", tags: [], channel: "C", channelId: "UC", durationSec: 100, uploadDate: null, language: "ru", cues: [] },
      segment: { workingName: "борщ", start: 10, end: 90, rawText: "x".repeat(2000), cleanText: "" },
      draft: {
        nameRu: "Борщ", nameEn: "Borscht", servings: null, unmappedIngredients: [],
        ingredients: [{ ingredient: "beet", rawName: "свёкла", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
        steps: [{ order: 1, text: "Сварить.", timestamp: 20 }],
      },
      verification: { ingredients: [{ rawName: "свёкла", quote: null, supported: false }], steps: [], confidence: 0.5 },
      categorization: { cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", activeMinutes: 30, totalMinutes: 90, richness: "medium", dishKey: "borscht" },
      models: { scout: "claude-sonnet-5" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(r.id).toBe("borscht--v1");
    // one unsupported ingredient, plus the step the verification never reported on
    expect(r.flags).toEqual([
      { kind: "ingredient", ref: "свёкла", reason: "quantity or presence not supported by transcript" },
      { kind: "step", ref: "1", reason: "action not found in transcript" },
    ]);
    expect(r.completeness).toBeCloseTo(1 - 0.2 + 0.005 + 0.02);
    expect(r.source).toMatchObject({ videoId: "v1", videoTitle: "T", segmentStart: 10, segmentEnd: 90 });
    expect(r.extractedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
