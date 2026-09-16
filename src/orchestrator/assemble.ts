import type { VideoSource } from "../schemas/source.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Categorization, DraftRecipe, Recipe, Verification } from "../schemas/recipe.js";
import { flagsFromVerification } from "../agents/verifier.js";
import { completeness } from "../agents/judge.js";

export function assembleRecipe(input: {
  source: VideoSource; segment: ScoutSegment; draft: DraftRecipe; verification: Verification;
  categorization: Categorization; models: Record<string, string>; now?: Date;
}): Recipe {
  const { source, segment, draft, verification, categorization: c } = input;
  const flags = flagsFromVerification(draft, verification);
  return {
    // Two segments of one video can share a dishKey; the orchestrator disambiguates.
    id: `${c.dishKey}--${source.videoId}`,
    nameRu: draft.nameRu,
    nameEn: draft.nameEn,
    dishKey: c.dishKey,
    cuisine: c.cuisine,
    mealTypes: c.mealTypes,
    category: c.category,
    richness: c.richness,
    servings: draft.servings,
    activeMinutes: c.activeMinutes,
    totalMinutes: c.totalMinutes,
    ingredients: draft.ingredients,
    steps: draft.steps,
    flags,
    completeness: completeness({ ingredients: draft.ingredients, flags, steps: draft.steps }),
    source: {
      videoId: source.videoId, url: source.url, videoTitle: source.title, channel: source.channel, channelId: source.channelId,
      segmentStart: segment.start, segmentEnd: segment.end, language: "ru",
    },
    extractedAt: (input.now ?? new Date()).toISOString(),
    models: input.models,
  };
}
