import path from "node:path";
import { config } from "../src/config.js";
import { runMigration, renderMigrationTable } from "../src/migrate/runMigration.js";

/**
 * One-time migration: `category` -> `course` + `method` across catalog/recipes, catalog/archive,
 * catalog/index.json and eval/bench/categorizer.json. Idempotent — safe to run more than once.
 * Never touches .cache/: a cached categorize-<i>.json still has `category` and will simply fail
 * the new schema on next read, which StageCache treats as a cache miss (see README).
 *
 * Run with: npm run migrate-catalog
 */
async function main(): Promise<void> {
  const result = await runMigration({
    recipesDir: path.join(config.paths.catalog, "recipes"),
    archiveDir: path.join(config.paths.catalog, "archive"),
    indexFile: path.join(config.paths.catalog, "index.json"),
    benchTruthFile: path.join(config.paths.eval, "bench", "categorizer.json"),
  });
  console.log(renderMigrationTable(result));
  if (result.errors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
