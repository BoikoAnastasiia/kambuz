import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { CategorizationWireSchema, type Categorization, type DraftRecipe } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildCategorizerUser(draft: DraftRecipe, vocab: Vocab): string {
  return [
    `Recipe: ${draft.nameRu} / ${draft.nameEn}`,
    `Cuisines: ${vocab.cuisines.map((c) => c.id).join(", ")}`,
    `Courses: ${vocab.courses.map((c) => c.id).join(", ")}`,
    `Methods: ${vocab.methods.map((m) => m.id).join(", ")}`,
    "",
    "Ingredients:",
    draft.ingredients.map((i) => `- ${i.rawName} ${i.quantity ?? ""} ${i.unit ?? ""}`.trim()).join("\n"),
    "",
    "Steps:",
    draft.steps.map((s) => `${s.order}. ${s.text}`).join("\n"),
  ].join("\n");
}

/**
 * Also returns the cuisine exactly as the model answered, before an off-vocabulary answer is
 * coerced to "other" — a bench scoring "other" must not credit a model for inventing a cuisine.
 */
export async function runCategorizerDetailed(
  draft: DraftRecipe,
  vocab: Vocab,
  llm: LlmClient,
  promptsDir: string,
): Promise<{ categorization: Categorization; rawCuisine: string }> {
  const system = await loadPrompt("categorizer", promptsDir);
  const raw = await llm.callStructured({ agent: "categorizer", system, user: buildCategorizerUser(draft, vocab), schema: CategorizationWireSchema });
  const cuisine = vocab.cuisines.some((c) => c.id === raw.cuisine) ? raw.cuisine : "other";
  // An off-vocabulary course is kept as-is: validateRecipe reports it and the
  // orchestrator drops that one recipe, rather than a throw killing the whole video.
  const method = raw.method !== null && vocab.methods.some((m) => m.id === raw.method) ? raw.method : null;
  return { categorization: { ...raw, cuisine, method, dishKey: slugify(raw.dishKey) }, rawCuisine: raw.cuisine };
}

export async function runCategorizer(draft: DraftRecipe, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<Categorization> {
  return (await runCategorizerDetailed(draft, vocab, llm, promptsDir)).categorization;
}
