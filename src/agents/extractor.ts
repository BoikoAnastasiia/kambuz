import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { DraftRecipeSchema, type DraftRecipe } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Vocab } from "../vocab/load.js";
import { ingredientPromptList } from "../vocab/validate.js";
import { formatTimestamp } from "../fetcher/vtt.js";

/**
 * `timedTranscript` is the rendered `[mm:ss] line` slice of the segment's cues. Step
 * timestamps are read off those markers, so the extractor never has to guess a second.
 */
export function buildExtractorUser(segment: ScoutSegment, vocab: Vocab, timedTranscript: string): string {
  return [
    `Dish (working name): ${segment.workingName}`,
    `Segment range: ${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)} (${segment.start}s–${segment.end}s)`,
    "",
    "Ingredient vocabulary (id — Russian / English (aliases)):",
    ingredientPromptList(vocab),
    "",
    "Timestamped transcript (take every step timestamp from these [mm:ss] markers):",
    timedTranscript,
    "",
    "Cleaned transcript (same lines, speech-to-text errors fixed):",
    segment.cleanText,
  ].join("\n");
}

export async function runExtractor(
  segment: ScoutSegment,
  vocab: Vocab,
  llm: LlmClient,
  promptsDir: string,
  timedTranscript: string,
): Promise<DraftRecipe> {
  const system = await loadPrompt("extractor", promptsDir);
  const raw = await llm.callStructured({ agent: "extractor", system, user: buildExtractorUser(segment, vocab, timedTranscript), schema: DraftRecipeSchema });
  const known = new Set(vocab.ingredients.map((i) => i.id));
  const unmapped = new Set(raw.unmappedIngredients);
  const ingredients = raw.ingredients.map((ing) => {
    // Provenance is a claim about a number: without a quantity there's nothing "stated"
    // or "inferred" about it, whatever the model said, so a null quantity always wins.
    const provenance = ing.quantity === null ? "unknown" : ing.provenance;
    if (ing.ingredient !== null && !known.has(ing.ingredient)) {
      unmapped.add(ing.rawName);
      return { ...ing, ingredient: null, provenance };
    }
    if (ing.ingredient === null) {
      unmapped.add(ing.rawName);
    }
    return { ...ing, provenance };
  });
  const steps = [...raw.steps]
    .map((s) => ({ ...s, timestamp: Math.max(segment.start, s.timestamp) }))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((s, i) => ({ ...s, order: i + 1 }));
  return { ...raw, ingredients, steps, unmappedIngredients: [...unmapped] };
}
