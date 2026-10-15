import "server-only";
import type { Filter } from "mongodb";
import { collections } from "./db";
import type { Lang } from "./i18n";
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

/**
 * In English an ingredient is named by the recipe's accepted translation, then by the vocabulary,
 * and only then left in Russian (a recipe whose translation didn't pass).
 */
function toCard(r: RecipeDoc, lang: Lang, vocabEn: Map<string, string>): RecipeCard {
  const ingredients =
    lang === "ru"
      ? r.ingredients.map((i) => i.baseName ?? i.rawName)
      : r.ingredients.map((i, k) => r.en?.ingredients[k]?.name ?? (i.ingredient ? vocabEn.get(i.ingredient) : undefined) ?? i.rawName);
  return {
    id: r.id,
    name: lang === "ru" ? r.nameRu : (r.en?.name ?? r.nameEn),
    cuisine: r.cuisine,
    course: r.course,
    method: r.method,
    totalMinutes: r.totalMinutes,
    ingredients,
    videoId: r.source.videoId,
    segmentStart: r.source.segmentStart,
  };
}

/** A random match, never the one just shown when another exists, plus a few more that fit. */
export async function suggest(f: Filters, lang: Lang, exclude?: string): Promise<Suggestion> {
  const { recipes, vocab } = await collections();
  const [found, ingredientVocab] = await Promise.all([recipes.find(recipeQuery(f)).toArray(), lang === "en" ? vocab.findOne({ _id: "ingredients" }) : null]);
  const vocabEn = new Map((ingredientVocab?.items ?? []).map((i) => [i.id, i.nameEn]));
  const matches = shuffle(found);
  const preferred = matches.findIndex((r) => r.id !== exclude);
  const pickIndex = preferred === -1 ? 0 : preferred;
  const pick = matches[pickIndex];
  const others = matches.filter((_, i) => i !== pickIndex).slice(0, 6);
  const available: Record<string, number> = {};
  for (const r of matches) {
    for (const id of new Set(r.ingredients.map((i) => i.ingredient))) if (id) available[id] = (available[id] ?? 0) + 1;
  }
  const card = (r: RecipeDoc) => toCard(r, lang, vocabEn);
  return { pick: pick ? card(pick) : null, others: others.map(card), total: matches.length, available };
}

export interface PickerOptions {
  /** Cuisines that have at least one recipe, most recipes first; "other" is left to Random. */
  cuisines: VocabItem[];
  /** Ingredients used by at least one recipe, alphabetical in the page's language. */
  ingredients: VocabItem[];
}

export async function pickerOptions(lang: Lang): Promise<PickerOptions> {
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
      .sort((a, b) => (lang === "ru" ? a.nameRu.localeCompare(b.nameRu, "ru") : a.nameEn.localeCompare(b.nameEn, "en"))),
  };
}
