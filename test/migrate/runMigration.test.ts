import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMigration, renderMigrationTable, type MigrationPaths } from "../../src/migrate/runMigration.js";
import { loadVocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

async function realVocab() {
  return loadVocab(config.paths.vocab);
}

function recipeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "baked-beef--v1", nameRu: "Запечённая говядина", nameEn: "Baked beef", dishKey: "baked-beef",
    cuisine: "other", mealTypes: ["dinner"], category: "bake", richness: "hearty",
    servings: null, activeMinutes: 20, totalMinutes: 60,
    ingredients: [], steps: [], flags: [], completeness: 0.8,
    source: { videoId: "v1", url: "https://x", videoTitle: "T", channel: "C", channelId: "CID", segmentStart: 0, segmentEnd: 10, language: "ru" },
    extractedAt: "2026-01-01T00:00:00.000Z", models: {},
    ...overrides,
  };
}

async function setup(): Promise<{ root: string; paths: MigrationPaths }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-migrate-"));
  const recipesDir = path.join(root, "catalog", "recipes");
  const archiveDir = path.join(root, "catalog", "archive");
  const indexFile = path.join(root, "catalog", "index.json");
  const benchTruthFile = path.join(root, "eval", "bench", "categorizer.json");
  await mkdir(recipesDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await mkdir(path.dirname(benchTruthFile), { recursive: true });

  await writeFile(path.join(recipesDir, "baked-beef--v1.json"), JSON.stringify(recipeFixture(), null, 2));
  await writeFile(
    path.join(recipesDir, "cabbage-salad--v1.json"),
    JSON.stringify(recipeFixture({ id: "cabbage-salad--v1", nameRu: "Салат из капусты", nameEn: "Cabbage salad", dishKey: "cabbage-salad", cuisine: "ukrainian", category: "salad", richness: "light" }), null, 2),
  );
  await writeFile(
    path.join(archiveDir, "meatballs-cheese--v1--2026-01-01.json"),
    JSON.stringify(recipeFixture({ id: "meatballs-cheese--v1", nameRu: "Тефтели с сыром", nameEn: "Meatballs with cheese", dishKey: "meatballs-cheese", category: "stew" }), null, 2),
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
  it("rewrites recipes, archive, index and bench truth from category to course/method, no warnings on valid input", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      const result = await runMigration(paths, { vocab });

      expect(result.filesScanned).toBe(5); // 2 recipes + 1 archive + index.json + bench truth
      expect(result.filesChanged).toBe(5);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);

      const beef = JSON.parse(await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8"));
      expect(beef).toMatchObject({ id: "baked-beef--v1", course: "main", method: "bake" });
      expect(beef.category).toBeUndefined();

      const salad = JSON.parse(await readFile(path.join(paths.recipesDir, "cabbage-salad--v1.json"), "utf8"));
      expect(salad).toMatchObject({ course: "salad", method: null });

      const archived = JSON.parse(await readFile(path.join(paths.archiveDir, "meatballs-cheese--v1--2026-01-01.json"), "utf8"));
      expect(archived).toMatchObject({ id: "meatballs-cheese--v1", course: "main", method: "stew" });

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

      // no stray .tmp files left behind after a clean run
      const leftover = (await readdir(paths.recipesDir)).filter((f) => f.endsWith(".tmp"));
      expect(leftover).toEqual([]);

      const table = renderMigrationTable(result);
      expect(table).toMatch(/baked-beef--v1: bake -> course=main method=bake/);
      expect(table).toMatch(/v1#0: bake -> course=main method=bake/);
      expect(table).toMatch(/scanned 5 file\(s\), changed 5, skipped 0/);
      // one bench row has method (bake), one has null
      expect(table).toMatch(/bench truth: 1\/2 row\(s\) have method: null/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: running twice makes zero changes the second time, and skipped covers everything scanned", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      const first = await runMigration(paths, { vocab });
      expect(first.filesChanged).toBeGreaterThan(0);

      const second = await runMigration(paths, { vocab });
      expect(second.filesChanged).toBe(0);
      expect(second.skipped).toBe(second.filesScanned);
      expect(second.lines).toEqual([]);
      expect(renderMigrationTable(second)).toMatch(/already up to date/);
      // the null-method count is still reported even when nothing changed this run
      expect(second.benchNullMethods).toEqual({ total: 2, withNullMethod: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--dry-run computes and reports everything but writes nothing", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      const before = await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8");

      const result = await runMigration(paths, { vocab, dryRun: true });

      expect(result.filesChanged).toBe(5);
      expect(result.lines.some((l) => l.detail.includes("bake -> course=main method=bake"))).toBe(true);

      const after = await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8");
      expect(after).toBe(before);
      expect(JSON.parse(after).category).toBe("bake");

      // a real run afterwards still finds the same work to do
      const real = await runMigration(paths, { vocab });
      expect(real.filesChanged).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unmapped legacy category as a per-file error without aborting the rest", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      await writeFile(path.join(paths.recipesDir, "mystery--v2.json"), JSON.stringify(recipeFixture({ id: "mystery--v2", category: "casserole" }), null, 2));

      const result = await runMigration(paths, { vocab });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ file: expect.stringMatching(/mystery--v2\.json$/), detail: expect.stringMatching(/unknown legacy category/) });
      // the other, valid files still migrated
      expect(result.filesChanged).toBeGreaterThan(0);
      const beef = JSON.parse(await readFile(path.join(paths.recipesDir, "baked-beef--v1.json"), "utf8"));
      expect(beef.course).toBe("main");
      // the bad file's own content is untouched (still has category, not left half-migrated)
      const mystery = JSON.parse(await readFile(path.join(paths.recipesDir, "mystery--v2.json"), "utf8"));
      expect(mystery.category).toBe("casserole");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses (per-file error) an object that already has course/method next to category, rather than clobbering it", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      await writeFile(
        path.join(paths.recipesDir, "hand-edited--v3.json"),
        JSON.stringify(recipeFixture({ id: "hand-edited--v3", category: "bake", course: "side" }), null, 2),
      );

      const result = await runMigration(paths, { vocab });

      expect(result.errors.some((e) => e.file.endsWith("hand-edited--v3.json") && /already has course\/method/.test(e.detail))).toBe(true);
      const untouched = JSON.parse(await readFile(path.join(paths.recipesDir, "hand-edited--v3.json"), "utf8"));
      expect(untouched.course).toBe("side"); // the hand-set value survives, unmigrated
      expect(untouched.category).toBe("bake");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns (but still writes) when a migrated recipe fails RecipeSchema", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      // missing nearly every required Recipe field
      await writeFile(path.join(paths.recipesDir, "incomplete--v4.json"), JSON.stringify({ id: "incomplete--v4", category: "bake" }, null, 2));

      const result = await runMigration(paths, { vocab });

      const warning = result.warnings.find((w) => w.file.endsWith("incomplete--v4.json"));
      expect(warning).toBeDefined();
      expect(warning!.detail).toMatch(/post-migration schema check failed/);
      expect(result.errors).toEqual([]); // a warning, not an error — the run keeps going
      const written = JSON.parse(await readFile(path.join(paths.recipesDir, "incomplete--v4.json"), "utf8"));
      expect(written).toEqual({ id: "incomplete--v4", course: "main", method: "bake" }); // still written despite the warning
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when the migrated bench truth file fails validateCategorizerTruth", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      await writeFile(
        paths.benchTruthFile,
        JSON.stringify([{ videoId: "v9", segmentIndex: 0, dish: "x", cuisine: "other", category: "bake", mealTypes: ["brunch"] }], null, 2), // "brunch" is not a valid mealType
      );

      const result = await runMigration(paths, { vocab });

      const warning = result.warnings.find((w) => w.file.endsWith("categorizer.json"));
      expect(warning).toBeDefined();
      expect(warning!.detail).toMatch(/post-migration truth check/);
      const truth = JSON.parse(await readFile(paths.benchTruthFile, "utf8"));
      expect(truth[0]).toMatchObject({ course: "main", method: "bake" }); // still written
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tolerates a missing index.json or bench truth file (nothing to migrate there yet)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-migrate-empty-"));
    try {
      const vocab = await realVocab();
      const recipesDir = path.join(root, "catalog", "recipes");
      await mkdir(recipesDir, { recursive: true });
      const result = await runMigration(
        {
          recipesDir,
          archiveDir: path.join(root, "catalog", "archive"),
          indexFile: path.join(root, "catalog", "index.json"),
          benchTruthFile: path.join(root, "eval", "bench", "categorizer.json"),
        },
        { vocab },
      );
      expect(result.filesScanned).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.benchNullMethods).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable directory as an error, distinct from an absent one", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      await chmod(paths.archiveDir, 0o000);
      try {
        const result = await runMigration(paths, { vocab });
        expect(result.errors.some((e) => e.file === paths.archiveDir && /cannot list directory/.test(e.detail))).toBe(true);
        // recipesDir was still fully processed
        expect(result.filesChanged).toBeGreaterThan(0);
      } finally {
        await chmod(paths.archiveDir, 0o700);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the original file byte-for-byte untouched when its write fails (atomic write)", async () => {
    const { root, paths } = await setup();
    try {
      const vocab = await realVocab();
      const target = path.join(paths.recipesDir, "baked-beef--v1.json");
      const before = await readFile(target, "utf8");
      await chmod(paths.recipesDir, 0o500); // read + execute only: can't create the .tmp file
      try {
        const result = await runMigration(paths, { vocab });
        const failure = result.errors.find((e) => e.file === target);
        expect(failure).toBeDefined();
        expect(failure!.detail).toMatch(/cannot write/);
      } finally {
        await chmod(paths.recipesDir, 0o700);
      }
      const after = await readFile(target, "utf8");
      expect(after).toBe(before);
      expect(JSON.parse(after).category).toBe("bake"); // never truncated, never half-written
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
