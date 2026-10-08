import "server-only";
import type { Filter } from "mongodb";
import { collections } from "./db";
import type { MealType, RecipeCard, RecipeDoc, Suggestion, VocabItem } from "./types";

export const MEALS = ["breakfast", "lunch", "dinner", "dessert"] as const;
export type Meal = (typeof MEALS)[number];

export interface Filters {
  meal: Meal;
  /** A cuisine id, or "random" for any. */
  cuisine: string;
  /** Ingredient ids that must all be in the dish. */
  include: string[];
}

export function parseFilters(params: URLSearchParams): Filters {
  const meal = params.get("meal");
  return {
    meal: (MEALS as readonly string[]).includes(meal ?? "") ? (meal as Meal) : "dinner",
    cuisine: params.get("cuisine")?.trim() || "random",
    include: (params.get("include") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * "Dessert" is a course in the data, not a meal: a pear cake is course dessert with
 * mealTypes [breakfast]. So the meal buttons match mealTypes but leave desserts out,
 * and the dessert button matches the course whatever the meal.
 */
export function recipeQuery(f: Filters): Filter<RecipeDoc> {
  const q: Filter<RecipeDoc> = { archived: false };
  if (f.meal === "dessert") q.course = "dessert";
  else {
    q.mealTypes = f.meal as MealType;
    q.course = { $ne: "dessert" };
  }
  if (f.cuisine !== "random") q.cuisine = f.cuisine;
  if (f.include.length) q["ingredients.ingredient"] = { $all: f.include };
  return q;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toCard(r: RecipeDoc): RecipeCard {
  return {
    id: r.id,
    nameRu: r.nameRu,
    nameEn: r.nameEn,
    cuisine: r.cuisine,
    course: r.course,
    method: r.method,
    totalMinutes: r.totalMinutes,
    ingredients: r.ingredients.map((i) => i.baseName ?? i.rawName),
    videoId: r.source.videoId,
    segmentStart: r.source.segmentStart,
  };
}

/** A random match, never the one just shown when another exists, plus a few more that fit. */
export async function suggest(f: Filters, exclude?: string): Promise<Suggestion> {
  const { recipes } = await collections();
  const matches = shuffle(await recipes.find(recipeQuery(f)).toArray());
  const preferred = matches.findIndex((r) => r.id !== exclude);
  const pickIndex = preferred === -1 ? 0 : preferred;
  const pick = matches[pickIndex];
  const others = matches.filter((_, i) => i !== pickIndex).slice(0, 6);
  return { pick: pick ? toCard(pick) : null, others: others.map(toCard), total: matches.length };
}

export interface PickerOptions {
  /** Cuisines that have at least one recipe, most recipes first; "other" is left to Random. */
  cuisines: VocabItem[];
  /** Ingredients used by at least one recipe, alphabetical by English name. */
  ingredients: VocabItem[];
}

export async function pickerOptions(): Promise<PickerOptions> {
  const { recipes, vocab } = await collections();
  const [cuisineCounts, ingredientIds, cuisineVocab, ingredientVocab] = await Promise.all([
    recipes.aggregate<{ _id: string; n: number }>([{ $match: { archived: false } }, { $group: { _id: "$cuisine", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    recipes.distinct("ingredients.ingredient", { archived: false }),
    vocab.findOne({ _id: "cuisines" }),
    vocab.findOne({ _id: "ingredients" }),
  ]);
  const cuisineById = new Map((cuisineVocab?.items ?? []).map((c) => [c.id, c]));
  const ingredientById = new Map((ingredientVocab?.items ?? []).map((i) => [i.id, i]));
  return {
    cuisines: cuisineCounts
      .filter((c) => c._id !== "other" && cuisineById.has(c._id))
      .map((c) => cuisineById.get(c._id)!),
    ingredients: (ingredientIds as (string | null)[])
      .filter((id): id is string => !!id && ingredientById.has(id))
      .map((id) => ingredientById.get(id)!)
      .sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
  };
}
