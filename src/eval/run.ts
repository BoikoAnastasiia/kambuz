import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { IngestDeps, IngestOptions } from "../orchestrator/run.js";
import { ingest } from "../orchestrator/run.js";

const CaseSchema = z.object({
  videoId: z.string(),
  note: z.string(),
  expect: z.object({
    dishCount: z.number(),
    names: z.array(z.string()),
    cuisines: z.array(z.string()),
    courses: z.array(z.string()),
    methods: z.array(z.string().nullable()).optional(),
    mealTypes: z.array(z.array(z.string())),
    ingredients: z
      .object({
        dishIndex: z.number(),
        must: z.array(z.object({ ingredient: z.string(), provenance: z.enum(["stated", "inferred", "unknown"]), quantity: z.number().optional() })),
      })
      .optional(),
  }),
});

export interface EvalRow {
  videoId: string;
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface RunEvalOptions {
  force: boolean;
  // Off by default: runEval never calls ingest() for a video unless this is
  // explicitly true — the eval only reads whatever is already in the catalog.
  // When true, a missing/stale video is ingested first (real API + yt-dlp
  // calls), so the eval is free (cache-backed) after the first real run.
  ingest?: boolean;
  onlyStage?: IngestOptions["onlyStage"];
}

export async function runEval(deps: IngestDeps, caseDir: string, opts: RunEvalOptions): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const files = (await readdir(caseDir)).filter((f) => f.endsWith(".json")).sort();
  // Zero cases is a setup mistake, not a passing regression run.
  if (files.length === 0) throw new Error(`no cases in ${caseDir}`);
  for (const f of files) {
    let c: z.infer<typeof CaseSchema>;
    try {
      c = CaseSchema.parse(JSON.parse(await readFile(path.join(caseDir, f), "utf8")));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`${f}: ${message}`);
    }
    if (opts.ingest) {
      await ingest(`https://www.youtube.com/watch?v=${c.videoId}`, deps, { force: opts.force, onlyStage: opts.onlyStage });
    }
    const recipes = (await deps.catalog.load())
      .filter((r) => r.source.videoId === c.videoId)
      .sort((a, b) => a.source.segmentStart - b.source.segmentStart);
    const row = (check: string, expected: unknown, actual: unknown) =>
      rows.push({ videoId: c.videoId, check, expected: JSON.stringify(expected), actual: JSON.stringify(actual), pass: JSON.stringify(expected) === JSON.stringify(actual) });
    row("dishCount", c.expect.dishCount, recipes.length);
    row("names", c.expect.names, recipes.map((r) => r.nameRu));
    row("cuisines", c.expect.cuisines, recipes.map((r) => r.cuisine));
    row("courses", c.expect.courses, recipes.map((r) => r.course));
    if (c.expect.methods) row("methods", c.expect.methods, recipes.map((r) => r.method));
    row("mealTypes", c.expect.mealTypes, recipes.map((r) => r.mealTypes));
    if (c.expect.ingredients) {
      const dish = recipes[c.expect.ingredients.dishIndex];
      for (const m of c.expect.ingredients.must) {
        const found = dish?.ingredients.find((i) => i.ingredient === m.ingredient);
        row(
          `ingredient:${m.ingredient}`,
          m,
          found ? { ingredient: found.ingredient, provenance: found.provenance, ...(m.quantity !== undefined ? { quantity: found.quantity } : {}) } : null,
        );
      }
    }
  }
  return rows;
}

export function renderEval(rows: EvalRow[]): string {
  const lines = ["| video | check | expected | actual | ok |", "|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.videoId} | ${r.check} | ${r.expected} | ${r.actual} | ${r.pass ? "✓" : "✗"} |`);
  const failed = rows.filter((r) => !r.pass).length;
  lines.push("", `${rows.length - failed}/${rows.length} checks passed`);
  return lines.join("\n");
}
