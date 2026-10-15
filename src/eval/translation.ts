import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import { checkTranslation, describeIssue, runProofreader, runTranslator } from "../agents/translator.js";
import type { ProofreadIssue } from "../schemas/recipe.js";
import type { Collections } from "../db/mongo.js";
import { fromDoc } from "../db/mongoCatalog.js";

const EvalFileSchema = z.object({ note: z.string().optional(), recipes: z.array(z.string()).min(1) });

// One translation and one proofread per recipe, Sonnet + Opus, measured on the first run.
export const ESTIMATED_USD_PER_CASE = 0.04;

export interface TranslationEvalRow {
  recipeId: string;
  nameRu: string;
  /** Code checks: counts, numbers, °C, leftover Cyrillic. */
  checks: string[];
  issues: ProofreadIssue[];
}

export async function readTranslationEvalIds(file: string): Promise<string[]> {
  return EvalFileSchema.parse(JSON.parse(await readFile(file, "utf8"))).recipes;
}

/**
 * Scores the translator as it is configured (KAMBUZ_MODEL_TRANSLATOR switches the model): one
 * translation per recipe, no retry, then the code checks and the proofreader. It never writes
 * to the catalog. Recipes no longer in the catalog are returned in `missing`.
 */
export async function runTranslationEval(
  c: Collections,
  deps: { config: Config; llm: LlmClient },
  ids: string[],
): Promise<{ rows: TranslationEvalRow[]; missing: string[] }> {
  const docs = await c.recipes.find({ _id: { $in: ids }, archived: false }).toArray();
  const byId = new Map(docs.map((d) => [d._id, fromDoc(d)]));
  const missing = ids.filter((id) => !byId.has(id));
  const limit = pLimit(deps.config.concurrency);
  const rows = await Promise.all(
    ids.filter((id) => byId.has(id)).map((id) =>
      limit(async () => {
        const recipe = byId.get(id)!;
        const t = await runTranslator(recipe, deps.llm, deps.config.paths.prompts);
        const checks = checkTranslation(recipe, t);
        const issues = await runProofreader(recipe, t, deps.llm, deps.config.paths.prompts);
        return { recipeId: id, nameRu: recipe.nameRu, checks, issues };
      }),
    ),
  );
  return { rows, missing };
}

const KINDS = ["meaning", "added", "dropped", "unclear", "tool_note"] as const;

export function renderTranslationEval(r: { rows: TranslationEvalRow[]; missing: string[] }, models: { translator: string; proofreader: string }, cost: string): string {
  const clean = r.rows.filter((x) => !x.checks.length && !x.issues.length).length;
  const count = (kind: string) => r.rows.reduce((n, x) => n + x.issues.filter((i) => i.kind === kind).length, 0);
  return [
    `# Translation eval`,
    "",
    `Translator: ${models.translator} · proofreader: ${models.proofreader} · cost: ${cost}`,
    "",
    `| recipes with no issues | ${KINDS.join(" | ")} | code checks |`,
    `|---|${KINDS.map(() => "---").join("|")}|---|`,
    `| ${clean}/${r.rows.length} | ${KINDS.map(count).join(" | ")} | ${r.rows.reduce((n, x) => n + x.checks.length, 0)} |`,
    "",
    ...(r.missing.length ? [`Not in the catalog any more: ${r.missing.join(", ")}`, ""] : []),
    ...r.rows.flatMap((x) => [
      `## ${x.nameRu} — ${x.recipeId}`,
      "",
      ...(x.checks.length || x.issues.length ? [...x.checks.map((p) => `- check: ${p}`), ...x.issues.map((i) => `- ${describeIssue(i)}`)] : ["- no issues"]),
      "",
    ]),
  ].join("\n");
}
