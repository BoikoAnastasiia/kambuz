import { describe, it, expect } from "vitest";
import { buildScoutUser } from "../../src/agents/scout.js";
import { buildExtractorUser } from "../../src/agents/extractor.js";
import { buildVerifierUser } from "../../src/agents/verifier.js";
import type { VideoSource } from "../../src/schemas/source.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { Vocab } from "../../src/vocab/load.js";

const pizza: VideoSource = {
  videoId: "MDX8fylSisU", url: "u", title: "Perfect Homemade Pizza", tags: [], channel: "C", channelId: "UC", durationSec: 513, uploadDate: null,
  language: "en", captionKind: "chapters",
  cues: [{ start: 28, end: 97, text: "1 TSP YEAST" }],
  chapters: [{ start: 28, end: 97, title: "1 TSP YEAST" }],
  description: "Pizza Dough Ingredients:\n1 cup all-purpose flour (160 g)\n1 tsp yeast",
};
const segment: ScoutSegment = { workingName: "Пицца пепперони", start: 0, end: 513, rawText: "1 TSP YEAST", cleanText: "" };
const vocab: Vocab = { ingredients: [], cuisines: [], courses: [], methods: [] } as unknown as Vocab;
const draft: DraftRecipe = {
  nameRu: "Пицца пепперони", nameEn: "Pepperoni pizza", servings: null, unmappedIngredients: [], steps: [],
  ingredients: [{ ingredient: "flour", rawName: "мука", baseName: "мука", quantity: 160, unit: "g", provenance: "stated", note: null }],
};

describe("source context in agent inputs", () => {
  it("tells the scout the language, what the transcript is, and gives it the description", () => {
    const user = buildScoutUser(pizza);
    expect(user).toContain("Language: en");
    expect(user).toContain("Description (written by the author):\nPizza Dough Ingredients:");
    expect(user).toContain("Transcript (the video's chapter titles");
    // The chapters are the transcript here, so they aren't listed a second time.
    expect(user).not.toContain("Chapters:");
  });

  it("lists chapters separately when the transcript is speech", () => {
    expect(buildScoutUser({ ...pizza, captionKind: "spoken" })).toContain("Chapters:\n[00:28] 1 TSP YEAST");
  });

  it("gives the extractor and verifier the description, and leaves it out when there is none", () => {
    const ctx = { language: "en", description: pizza.description };
    expect(buildExtractorUser(segment, vocab, "[0:28] 1 TSP YEAST", ctx)).toContain("Video language: en");
    expect(buildExtractorUser(segment, vocab, "[0:28] 1 TSP YEAST", ctx)).toContain("1 cup all-purpose flour (160 g)");
    expect(buildVerifierUser(segment, draft, ctx)).toContain("Description (written by the author):");
    expect(buildVerifierUser(segment, draft, { language: "ru", description: "  " })).not.toContain("Description");
    expect(buildExtractorUser(segment, vocab, "x")).not.toContain("Video language");
  });
});
