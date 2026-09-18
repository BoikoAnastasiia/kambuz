import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMigration, renderMigrationTable, type MigrationPaths } from "../../src/migrate/runMigration.js";

async function setup(): Promise<{ root: string; paths: MigrationPaths }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-migrate-"));
  const recipesDir = path.join(root, "catalog", "recipes");
  const archiveDir = path.join(root, "catalog", "archive");
  const indexFile = path.join(root, "catalog", "index.json");
  const benchTruthFile = path.join(root, "eval", "bench", "categorizer.json");
  await mkdir(recipesDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await mkdir(path.dirname(benchTruthFile), { recursive: true });

  await writeFile(
    path.join(recipesDir, "baked-beef--v1.json"),
    JSON.stringify({ id: "baked-beef--v1", nameRu: "Запечённая говядина", cuisine: "other", category: "bake", richness: "hearty" }, null, 2),
  );
  await writeFile(
    path.join(recipesDir, "cabbage-salad--v1.json"),
    JSON.stringify({ id: "cabbage-salad--v1", nameRu: "Салат из капусты", cuisine: "ukrainian", category: "salad", richness: "light" }, null, 2),
  );
  await writeFile(
    path.join(archiveDir, "meatballs-cheese--v1--2026-01-01.json"),
    JSON.stringify({ id: "meatballs-cheese--v1", category: "stew" }, null, 2),
  );
  await writeFile(
    indexFile,
    JSON.stringify(
      [
        { id: "baked-beef--v1", cuisine: "other", category: "bake", completeness: 0.9 },
        { id: "cabbage-salad--v1", cuisine: "ukrainian", category: "salad", completeness: 0.8 },
      ],
      null,
      2,
    ),
  );
  await writeFile(
    benchTruthFile,
    JSON.stringify(
      [
        { videoId: "v1", segmentIndex: 0, dish: "Запечённая говядина", cuisine: "other", category: "bake", mealTypes: ["dinner"] },
        { videoId: "v1", segmentIndex: 1, dish: "Салат из капусты", cuisine: "ukrainian", category: "salad", mealTypes: ["lunch"] },
      ],
      null,
      2,
    ),
  );

  return { root, paths: { recipesDir, archiveDir, indexFile, benchTruthFile } };
}

describe("runMigration", () => {
  it("rewrites recipes, archive, index and bench truth from category to course/method", async () => {
    const { root, paths } = await setup();
    try {
      const result = await runMigration(paths);

      expect(result.filesScanned).toBe(5); // 2 recipes + 1 archive + index.json + bench truth
      expect(result.filesChanged).toBe(5);
      expect(result.errors).toEqual([]);

      const beef = JSON.parse(await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8"));
      expect(beef).toEqual({ id: "baked-beef--v1", nameRu: "Запечённая говядина", cuisine: "other", course: "main", method: "bake", richness: "hearty" });

      const salad = JSON.parse(await readFile(path.join(paths.recipesDir, "cabbage-salad--v1.json"), "utf8"));
      expect(salad).toMatchObject({ course: "salad", method: null });

      const archived = JSON.parse(await readFile(path.join(paths.archiveDir, "meatballs-cheese--v1--2026-01-01.json"), "utf8"));
      expect(archived).toEqual({ id: "meatballs-cheese--v1", course: "main", method: "stew" });

      const index = JSON.parse(await readFile(paths.indexFile, "utf8"));
      expect(index).toEqual([
        { id: "baked-beef--v1", cuisine: "other", course: "main", method: "bake", completeness: 0.9 },
        { id: "cabbage-salad--v1", cuisine: "ukrainian", course: "salad", method: null, completeness: 0.8 },
      ]);

      const truth = JSON.parse(await readFile(paths.benchTruthFile, "utf8"));
      expect(truth).toEqual([
        { videoId: "v1", segmentIndex: 0, dish: "Запечённая говядина", cuisine: "other", course: "main", method: "bake", mealTypes: ["dinner"] },
        { videoId: "v1", segmentIndex: 1, dish: "Салат из капусты", cuisine: "ukrainian", course: "salad", method: null, mealTypes: ["lunch"] },
      ]);

      const table = renderMigrationTable(result);
      expect(table).toMatch(/baked-beef--v1: bake -> course=main method=bake/);
      expect(table).toMatch(/v1#0: bake -> course=main method=bake/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: running twice makes zero changes the second time", async () => {
    const { root, paths } = await setup();
    try {
      const first = await runMigration(paths);
      expect(first.filesChanged).toBeGreaterThan(0);

      const second = await runMigration(paths);
      expect(second.filesChanged).toBe(0);
      expect(second.lines).toEqual([]);
      expect(renderMigrationTable(second)).toMatch(/already up to date/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unmapped legacy category as a per-file error without aborting the rest", async () => {
    const { root, paths } = await setup();
    try {
      await writeFile(path.join(paths.recipesDir, "mystery--v2.json"), JSON.stringify({ id: "mystery--v2", category: "casserole" }, null, 2));

      const result = await runMigration(paths);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ file: expect.stringMatching(/mystery--v2\.json$/), detail: expect.stringMatching(/unknown legacy category/) });
      // the other, valid files still migrated
      expect(result.filesChanged).toBeGreaterThan(0);
      const beef = JSON.parse(await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8"));
      expect(beef.course).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tolerates a missing index.json or bench truth file (nothing to migrate there yet)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-migrate-empty-"));
    try {
      const recipesDir = path.join(root, "catalog", "recipes");
      await mkdir(recipesDir, { recursive: true });
      const result = await runMigration({
        recipesDir,
        archiveDir: path.join(root, "catalog", "archive"),
        indexFile: path.join(root, "catalog", "index.json"),
        benchTruthFile: path.join(root, "eval", "bench", "categorizer.json"),
      });
      expect(result.filesScanned).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
