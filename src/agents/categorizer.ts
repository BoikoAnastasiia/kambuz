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
    `Categories: ${vocab.categories.map((c) => c.id).join(", ")}`,
    "",
    "Ingredients:",
    draft.ingredients.map((i) => `- ${i.rawName} ${i.quantity ?? ""} ${i.unit ?? ""}`.trim()).join("\n"),
    "",
    "Steps:",
    draft.steps.map((s) => `${s.order}. ${s.text}`).join("\n"),
  ].join("\n");
}

export async function runCategorizer(draft: DraftRecipe, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<Categorization> {
  const system = await loadPrompt("categorizer", promptsDir);
  const raw = await llm.callStructured({ agent: "categorizer", system, user: buildCategorizerUser(draft, vocab), schema: CategorizationWireSchema });
  const cuisine = vocab.cuisines.some((c) => c.id === raw.cuisine) ? raw.cuisine : "other";
  if (!vocab.categories.some((c) => c.id === raw.category)) throw new Error(`categorizer returned unknown category: ${raw.category}`);
  return { ...raw, cuisine, dishKey: slugify(raw.dishKey) };
}
