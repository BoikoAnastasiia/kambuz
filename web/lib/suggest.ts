import "server-only";
import type { Filter } from "mongodb";
import { collections } from "./db";
import type { Lang } from "./i18n";
import { score } from "./search";
import type { MealType, RecipeCard, RecipeDoc, Suggestion, VocabItem } from "./types";

export const MEALS = ["breakfast", "lunch", "dinner", "dessert", "any"] as const;
export type Meal = (typeof MEALS)[number];

export interface Filters {
  meal: Meal;
  /** A cuisine id, or "random" for any. */
  cuisine: string;
  /** Ingredient ids that must all be in the dish. */
  include: string[];
  /** Free text to find among the dishes the filters allow; empty for a random pick. */
  q?: string;
}

export function parseFilters(params: URLSearchParams): Filters {
  const meal = params.get("meal");
  return {
    meal: (MEALS as readonly string[]).includes(meal ?? "") ? (meal as Meal) : "dinner",
    cuisine: params.get("cuisine")?.trim() || "random",
    include: (params.get("include") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    q: params.get("q")?.trim().slice(0, 80) || undefined,
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
  else if (f.meal !== "any") {
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

/** Everything a search looks at, in both languages whatever the page's. */
function searchable(r: RecipeDoc, vocabEn: Map<string, string>) {
  return {
    names: [r.nameRu, r.nameEn, r.en?.name ?? ""],
    ingredients: r.ingredients.flatMap((i, k) => [i.baseName ?? "", i.rawName, r.en?.ingredients[k]?.name ?? "", (i.ingredient && vocabEn.get(i.ingredient)) || ""]),
  };
}

/** A random match, never the one just shown when another exists, plus a few more that fit. */
export async function suggest(f: Filters, lang: Lang, exclude?: string): Promise<Suggestion> {
  const { recipes, vocab } = await collections();
  // The vocabulary's English names also let a search find ingredients by their English name.
  const [found, ingredientVocab] = await Promise.all([recipes.find(recipeQuery(f)).toArray(), lang === "en" || f.q ? vocab.findOne({ _id: "ingredients" }) : null]);
  const vocabEn = new Map((ingredientVocab?.items ?? []).map((i) => [i.id, i.nameEn]));
  const card = (r: RecipeDoc) => toCard(r, lang, vocabEn);
  const countIngredients = (rs: RecipeDoc[]) => {
    const available: Record<string, number> = {};
    for (const r of rs) {
      for (const id of new Set(r.ingredients.map((i) => i.ingredient))) if (id) available[id] = (available[id] ?? 0) + 1;
    }
    return available;
  };

  // A search lists every dish that matches, best first, instead of picking one at random.
  if (f.q) {
    const ranked = found
      .map((r) => ({ r, s: score(searchable(r, vocabEn), f.q!) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || card(a.r).name.localeCompare(card(b.r).name, lang))
      .map((x) => x.r);
    return { pick: null, others: [], total: ranked.length, available: countIngredients(ranked), results: ranked.slice(0, 48).map(card) };
  }

  const matches = shuffle(found);
  const preferred = matches.findIndex((r) => r.id !== exclude);
  const pickIndex = preferred === -1 ? 0 : preferred;
  const pick = matches[pickIndex];
  const others = matches.filter((_, i) => i !== pickIndex).slice(0, 6);
  return { pick: pick ? card(pick) : null, others: others.map(card), total: matches.length, available: countIngredients(matches), results: null };
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
