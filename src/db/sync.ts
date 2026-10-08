import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RecipeSchema, type Recipe } from "../schemas/recipe.js";
import type { RunReport } from "../orchestrator/report.js";
import type { Collections, VocabDoc } from "./mongo.js";

/** Upserts one videos row per video the run touched. */
export async function recordVideos(c: Collections, report: RunReport): Promise<void> {
  const processedAt = report.finishedAt || new Date().toISOString();
  for (const v of report.videos) {
    await c.videos.replaceOne(
      { _id: v.videoId },
      { title: v.title, status: v.status, recipes: v.recipes, error: v.error ?? null, processedAt },
      { upsert: true },
    );
  }
}

const VOCAB_FILES: VocabDoc["_id"][] = ["ingredients", "cuisines", "courses", "methods"];

/** Copies vocab/*.json into the vocab collection, so the site can name ids without reading the repo. */
export async function syncVocab(c: Collections, vocabDir: string): Promise<void> {
  for (const name of VOCAB_FILES) {
    const raw = JSON.parse(await readFile(path.join(vocabDir, `${name}.json`), "utf8")) as { id: string; nameRu: string; nameEn: string }[];
    const items = raw.map(({ id, nameRu, nameEn }) => ({ id, nameRu, nameEn }));
    await c.vocab.replaceOne({ _id: name }, { items }, { upsert: true });
  }
}

async function readRecipes(dir: string): Promise<{ file: string; recipe: Recipe }[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return Promise.all(files.map(async (file) => ({ file, recipe: RecipeSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8"))) })));
}

/**
 * Copies the JSON catalog (live and archived recipes) into MongoDB and records a videos
 * row for every video a live recipe came from. Safe to run again: everything is upserted
 * by id, and a video already recorded by the worker keeps its own row.
 */
export async function importCatalog(c: Collections, catalogRoot: string): Promise<{ recipes: number; archived: number; videos: number }> {
  const live = await readRecipes(path.join(catalogRoot, "recipes"));
  for (const { recipe } of live) {
    await c.recipes.replaceOne({ _id: recipe.id }, { ...recipe, archived: false, archivedAt: null }, { upsert: true });
  }
  const archived = await readRecipes(path.join(catalogRoot, "archive"));
  for (const { file, recipe } of archived) {
    const _id = file.replace(/\.json$/, "");
    await c.recipes.replaceOne({ _id }, { ...recipe, archived: true, archivedAt: recipe.extractedAt }, { upsert: true });
  }
  const byVideo = new Map<string, Recipe[]>();
  for (const { recipe } of live) byVideo.set(recipe.source.videoId, [...(byVideo.get(recipe.source.videoId) ?? []), recipe]);
  let videos = 0;
  for (const [videoId, recipes] of byVideo) {
    const processedAt = recipes.map((r) => r.extractedAt).sort().at(-1)!;
    const res = await c.videos.updateOne(
      { _id: videoId },
      { $setOnInsert: { title: recipes[0].source.videoTitle, status: "done", recipes: recipes.length, error: null, processedAt } },
      { upsert: true },
    );
    videos += res.upsertedCount;
  }
  return { recipes: live.length, archived: archived.length, videos };
}
