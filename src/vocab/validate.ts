import type { Vocab } from "./load.js";
import type { DraftIngredient } from "../schemas/recipe.js";

export function validateRecipe(
  recipe: { cuisine: string; course: string; method: string | null; ingredients: DraftIngredient[] },
  vocab: Vocab,
): string[] {
  const errors: string[] = [];
  if (!vocab.cuisines.some((c) => c.id === recipe.cuisine)) errors.push(`unknown cuisine: ${recipe.cuisine}`);
  if (!vocab.courses.some((c) => c.id === recipe.course)) errors.push(`unknown course: ${recipe.course}`);
  if (recipe.method !== null && !vocab.methods.some((m) => m.id === recipe.method)) errors.push(`unknown method: ${recipe.method}`);
  const ids = new Set(vocab.ingredients.map((i) => i.id));
  for (const ing of recipe.ingredients) {
    if (ing.ingredient !== null && !ids.has(ing.ingredient)) errors.push(`unknown ingredient: ${ing.ingredient}`);
  }
  return errors;
}

export function ingredientPromptList(vocab: Vocab): string {
  return vocab.ingredients
    .map((i) => `${i.id} — ${i.nameRu} / ${i.nameEn}${i.aliases.length ? ` (${i.aliases.join(", ")})` : ""}`)
    .join("\n");
}
