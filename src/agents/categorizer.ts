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
 * Also returns the cuisine and method exactly as the model answered, before an off-vocabulary
 * answer is coerced (cuisine to "other", method to null) — a bench scoring the coerced value
 * would credit a model for inventing a cuisine, or for inventing a method that happens to
 * coerce to the same null a genuinely-unknown-method label carries.
 */
export async function runCategorizerDetailed(
  draft: DraftRecipe,
  vocab: Vocab,
  llm: LlmClient,
  promptsDir: string,
): Promise<{ categorization: Categorization; rawCuisine: string; rawMethod: string | null }> {
  const system = await loadPrompt("categorizer", promptsDir);
  const raw = await llm.callStructured({ agent: "categorizer", system, user: buildCategorizerUser(draft, vocab), schema: CategorizationWireSchema });
  const cuisine = vocab.cuisines.some((c) => c.id === raw.cuisine) ? raw.cuisine : "other";
  // An off-vocabulary course is kept as-is: validateRecipe reports it and the
  // orchestrator drops that one recipe, rather than a throw killing the whole video.
  const method = raw.method !== null && vocab.methods.some((m) => m.id === raw.method) ? raw.method : null;
  return { categorization: { ...raw, cuisine, method, dishKey: slugify(raw.dishKey) }, rawCuisine: raw.cuisine, rawMethod: raw.method };
}

export async function runCategorizer(draft: DraftRecipe, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<Categorization> {
  return (await runCategorizerDetailed(draft, vocab, llm, promptsDir)).categorization;
}
