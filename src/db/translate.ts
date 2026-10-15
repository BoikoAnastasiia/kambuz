import pLimit from "p-limit";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import { translateRecipe } from "../agents/translator.js";
import type { Collections } from "./mongo.js";
import { fromDoc } from "./mongoCatalog.js";

// Measured on the 20-recipe eval: Sonnet translating plus Opus proofreading, with the occasional retry.
export const ESTIMATED_USD_PER_RECIPE = 0.045;

export interface TranslateCatalogResult {
  pending: number;
  translated: string[];
  rejected: { recipeId: string; problems: string[] }[];
  failed: { recipeId: string; error: string }[];
}

/**
 * Adds the English version to active recipes that don't have one yet. Without `yes` it only
 * counts them. A translation is written with $set on the live document, so a worker writing
 * other recipes at the same time is never overwritten; a recipe archived meanwhile is skipped.
 */
export async function translateCatalog(
  c: Collections,
  deps: { config: Config; llm: LlmClient },
  opts: { yes: boolean; limit?: number },
  log: (line: string) => void,
): Promise<TranslateCatalogResult> {
  const docs = await c.recipes.find({ archived: false, en: { $exists: false } }).sort({ _id: 1 }).toArray();
  const todo = opts.limit ? docs.slice(0, opts.limit) : docs;
  const result: TranslateCatalogResult = { pending: docs.length, translated: [], rejected: [], failed: [] };
  if (!opts.yes) {
    log(`${docs.length} recipe(s) have no English version; this run would translate ${todo.length} for about $${(todo.length * ESTIMATED_USD_PER_RECIPE).toFixed(2)}.`);
    log("Add --yes to run it.");
    return result;
  }
  const limit = pLimit(deps.config.concurrency);
  let done = 0;
  await Promise.all(
    todo.map((doc) =>
      limit(async () => {
        const recipe = fromDoc(doc);
        try {
          const out = await translateRecipe(recipe, deps.llm, deps.config.paths.prompts, deps.config.models);
          if (out.ok) {
            await c.recipes.updateOne({ _id: doc._id, archived: false }, { $set: { en: out.en } });
            result.translated.push(recipe.id);
          } else {
            result.rejected.push({ recipeId: recipe.id, problems: out.problems });
          }
        } catch (e) {
          result.failed.push({ recipeId: recipe.id, error: e instanceof Error ? e.message : String(e) });
        }
        log(`${++done}/${todo.length} ${recipe.id}`);
      }),
    ),
  );
  return result;
}

export function renderTranslateReport(r: TranslateCatalogResult, cost: string): string {
  return [
    `# Translation run`,
    "",
    `Translated: ${r.translated.length} · not accepted: ${r.rejected.length} · errors: ${r.failed.length} · cost: ${cost}`,
    "",
    "## Not accepted (kept in Russian only)",
    "",
    ...r.rejected.flatMap((x) => [`- ${x.recipeId}`, ...x.problems.map((p) => `  - ${p}`)]),
    "",
    "## Errors",
    "",
    ...r.failed.map((x) => `- ${x.recipeId}: ${x.error}`),
    "",
  ].join("\n");
}
