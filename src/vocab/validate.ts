import type { Vocab } from "./load.js";
import type { DraftIngredient } from "../schemas/recipe.js";

export function validateRecipe(
  recipe: { cuisine: string; category: string; ingredients: DraftIngredient[] },
  vocab: Vocab,
): string[] {
  const errors: string[] = [];
  if (!vocab.cuisines.some((c) => c.id === recipe.cuisine)) errors.push(`unknown cuisine: ${recipe.cuisine}`);
  if (!vocab.categories.some((c) => c.id === recipe.category)) errors.push(`unknown category: ${recipe.category}`);
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
