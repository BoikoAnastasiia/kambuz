import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { DraftRecipeSchema, type DraftRecipe } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Vocab } from "../vocab/load.js";
import { ingredientPromptList } from "../vocab/validate.js";
import { formatTimestamp } from "../fetcher/vtt.js";

export function buildExtractorUser(segment: ScoutSegment, vocab: Vocab): string {
  return [
    `Dish (working name): ${segment.workingName}`,
    `Segment range: ${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)} (${segment.start}s–${segment.end}s)`,
    "",
    "Ingredient vocabulary (id — Russian / English (aliases)):",
    ingredientPromptList(vocab),
    "",
    "Cleaned transcript:",
    segment.cleanText,
  ].join("\n");
}

export async function runExtractor(segment: ScoutSegment, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<DraftRecipe> {
  const system = await loadPrompt("extractor", promptsDir);
  const raw = await llm.callStructured({ agent: "extractor", system, user: buildExtractorUser(segment, vocab), schema: DraftRecipeSchema });
  const known = new Set(vocab.ingredients.map((i) => i.id));
  const unmapped = new Set(raw.unmappedIngredients);
  const ingredients = raw.ingredients.map((ing) => {
    if (ing.ingredient !== null && !known.has(ing.ingredient)) {
      unmapped.add(ing.rawName);
      return { ...ing, ingredient: null };
    }
    if (ing.ingredient === null) {
      unmapped.add(ing.rawName);
    }
    return ing;
  });
  const steps = [...raw.steps]
    .map((s) => ({ ...s, timestamp: Math.max(segment.start, s.timestamp) }))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((s, i) => ({ ...s, order: i + 1 }));
  return { ...raw, ingredients, steps, unmappedIngredients: [...unmapped] };
}
