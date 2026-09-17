import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import type { Vocab } from "../../src/vocab/load.js";

export const vocab: Vocab = {
  cuisines: [
    { id: "italian", nameRu: "Итальянская", nameEn: "Italian" },
    { id: "russian", nameRu: "Русская", nameEn: "Russian" },
    { id: "other", nameRu: "Другая", nameEn: "Other" },
  ],
  categories: [
    { id: "pasta", nameRu: "Паста", nameEn: "Pasta" },
    { id: "soup", nameRu: "Суп", nameEn: "Soup" },
  ],
  ingredients: [
    { id: "onion", nameRu: "Лук", nameEn: "Onion", aliases: ["репчатый лук"] },
    { id: "beef-mince", nameRu: "Говяжий фарш", nameEn: "Beef mince", aliases: ["фарш"] },
    { id: "carrot", nameRu: "Морковь", nameEn: "Carrot", aliases: [] },
    { id: "cream", nameRu: "Сливки", nameEn: "Cream", aliases: [] },
    { id: "cinnamon", nameRu: "Корица", nameEn: "Cinnamon", aliases: [] },
    { id: "lemon", nameRu: "Лимон", nameEn: "Lemon", aliases: [] },
  ],
};

export const lasagnaSegment: ScoutSegment = {
  workingName: "Лазанья",
  start: 10,
  end: 300,
  rawText: "нарежем репчатый лук, добавим 500 г фарша и морковку, польём сливками",
  cleanText: "",
};

export const lasagnaDraft: DraftRecipe = {
  nameRu: "Лазанья",
  nameEn: "Lasagna",
  servings: null,
  unmappedIngredients: [],
  ingredients: [
    { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
    { ingredient: "beef-mince", rawName: "фарш", quantity: 500, unit: "g", provenance: "stated", note: null },
    { ingredient: null, rawName: "соль", quantity: null, unit: null, provenance: "unknown", note: null },
  ],
  steps: [
    { order: 1, text: "Нарезать лук.", timestamp: 30 },
    { order: 2, text: "Обжарить 500 г фарша.", timestamp: 60 },
  ],
};

export const soupSegment: ScoutSegment = { workingName: "Суп", start: 0, end: 120, rawText: "варим бульон, картошка", cleanText: "" };
export const soupDraft: DraftRecipe = {
  nameRu: "Суп",
  nameEn: "Soup",
  servings: null,
  unmappedIngredients: [],
  ingredients: [{ ingredient: null, rawName: "картошка", quantity: null, unit: null, provenance: "unknown", note: null }],
  steps: [{ order: 1, text: "Сварить суп.", timestamp: 5 }],
};

/** v1: two segments with drafts; v2: scout only (its segment is skipped); v3: no scout at all. */
export async function makeCache(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-bench-"));
  const write = async (videoId: string, stage: string, value: unknown) => {
    await mkdir(path.join(root, videoId), { recursive: true });
    await writeFile(path.join(root, videoId, `${stage}.json`), JSON.stringify(value));
  };
  await write("v1", "scout", { isRecipeVideo: true, segments: [lasagnaSegment, soupSegment] });
  await write("v1", "extract-0", lasagnaDraft);
  await write("v1", "extract-1", soupDraft);
  await write("v1", "categorize-0", { category: "pasta" });
  await write("v2", "scout", { isRecipeVideo: true, segments: [soupSegment] });
  await mkdir(path.join(root, "v3"), { recursive: true });
  return root;
}
