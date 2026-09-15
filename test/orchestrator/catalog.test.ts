import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../../src/orchestrator/catalog.js";
import type { Recipe } from "../../src/schemas/recipe.js";

const base: Recipe = {
  id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht", dishKey: "borscht", cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", richness: "medium",
  servings: null, activeMinutes: null, totalMinutes: null, ingredients: [], steps: [], flags: [], completeness: 0.5,
  source: { videoId: "v1", url: "", videoTitle: "", channel: "", channelId: "", segmentStart: 0, segmentEnd: 0, language: "ru" },
  extractedAt: "2026-01-01T00:00:00.000Z", models: {},
};

describe("Catalog", () => {
  it("writes, indexes, renames and archives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-cat-"));
    try {
      const cat = new Catalog(root);
      expect(await cat.load()).toEqual([]);
      await cat.write(base);
      expect((await cat.load())[0].id).toBe("borscht--v1");
      const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
      expect(index).toEqual([{ id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht", dishKey: "borscht", cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", completeness: 0.5, videoId: "v1" }]);
      await cat.rename(base, "Борщ с фасолью");
      expect((await cat.load())[0].nameRu).toBe("Борщ с фасолью");
      await cat.archive(base);
      expect(await cat.load()).toEqual([]);
      expect((await readdir(path.join(root, "archive")))[0]).toMatch(/^borscht--v1--/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
