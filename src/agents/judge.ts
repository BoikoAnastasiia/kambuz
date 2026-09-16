import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { JudgeDecisionSchema, type JudgeDecision } from "../schemas/judge.js";
import type { DraftIngredient, Recipe, RecipeFlag } from "../schemas/recipe.js";

export const JACCARD_THRESHOLD = 0.6;
export const FLAG_PENALTY = 0.1;

// A recipe is cookable once it names enough ingredients AND enough steps — that's
// the owner's real bar ("this chef rarely states amounts unless baking; knowing the
// ingredients and the steps IS the recipe"). Stated/inferred quantities are a minor
// bonus on top, not a requirement.
export const INGREDIENTS_FOR_FULL_SCORE = 5;
export const STEPS_FOR_FULL_SCORE = 6;
export const COOKABILITY_WEIGHT = 0.9;
export const QUANTITY_WEIGHT = 0.1;

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function ids(ingredients: DraftIngredient[]): string[] {
  return ingredients.map((i) => i.ingredient).filter((x): x is string => x !== null);
}

export function findCandidates(recipe: Pick<Recipe, "dishKey" | "ingredients">, catalog: Recipe[]): Recipe[] {
  const mine = ids(recipe.ingredients);
  return catalog.filter((r) => r.dishKey === recipe.dishKey || jaccard(mine, ids(r.ingredients)) >= JACCARD_THRESHOLD);
}

export function completeness(input: { ingredients: DraftIngredient[]; flags: RecipeFlag[]; steps: unknown[] }): number {
  if (input.ingredients.length === 0) return 0;
  const ingredientScore = Math.min(1, input.ingredients.length / INGREDIENTS_FOR_FULL_SCORE);
  const stepScore = Math.min(1, input.steps.length / STEPS_FOR_FULL_SCORE);
  const cookability = ingredientScore * stepScore; // both are required, so multiply rather than average
  const quantified = input.ingredients.filter((i) => i.provenance !== "unknown").length / input.ingredients.length;
  const penalty = input.flags.length * FLAG_PENALTY;
  return Math.max(0, Math.min(1, COOKABILITY_WEIGHT * cookability + QUANTITY_WEIGHT * quantified - penalty));
}

function describeRecipe(r: Recipe): string {
  return [
    `Name: ${r.nameRu} / ${r.nameEn}`,
    `Ingredients: ${r.ingredients.map((i) => `${i.rawName} ${i.quantity ?? "?"} ${i.unit ?? ""}`.trim()).join("; ")}`,
    `Steps: ${r.steps.map((s) => s.text).join(" ")}`,
  ].join("\n");
}

export async function runJudge(existing: Recipe, incoming: Recipe, llm: LlmClient, promptsDir: string): Promise<JudgeDecision> {
  const system = await loadPrompt("judge", promptsDir);
  const user = ["EXISTING recipe:", describeRecipe(existing), "", "NEW recipe:", describeRecipe(incoming)].join("\n");
  return llm.callStructured({ agent: "judge", system, user, schema: JudgeDecisionSchema });
}

export type JudgeAction = "replace" | "keep-existing" | "keep-both";

export function decide(
  existing: Recipe,
  incoming: Recipe,
  decision: JudgeDecision,
): { action: JudgeAction; incoming: Recipe; existing: Recipe } {
  if (decision.relation === "variant") {
    return {
      action: "keep-both",
      incoming: decision.newNameRu ? { ...incoming, nameRu: decision.newNameRu } : incoming,
      existing: decision.existingNameRu ? { ...existing, nameRu: decision.existingNameRu } : existing,
    };
  }
  return { action: incoming.completeness > existing.completeness ? "replace" : "keep-existing", incoming, existing };
}
