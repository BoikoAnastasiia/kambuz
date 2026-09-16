import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEval, renderEval, type EvalRow } from "../../src/eval/run.js";
import { StageCache } from "../../src/orchestrator/cache.js";
import { Catalog } from "../../src/orchestrator/catalog.js";
import { buildConfig } from "../../src/config.js";
import { loadVocab } from "../../src/vocab/load.js";
import type { Recipe } from "../../src/schemas/recipe.js";

const base: Recipe = {
  id: "base--v0", nameRu: "Base", nameEn: "Base", dishKey: "base", cuisine: "italian", mealTypes: ["dinner"], category: "pasta", richness: "medium",
  servings: null, activeMinutes: null, totalMinutes: null,
  ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
  steps: [], flags: [], completeness: 0.5,
  source: { videoId: "v0", url: "", videoTitle: "", channel: "", channelId: "", segmentStart: 0, segmentEnd: 0, language: "ru" },
  extractedAt: "2026-01-01T00:00:00.000Z", models: {},
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-eval-"));
  const config = buildConfig({});
  const llm = { callStructured: vi.fn() };
  const deps = {
    config,
    llm,
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(path.join(root, "cache")),
    catalog: new Catalog(path.join(root, "catalog")),
  };
  const caseDir = path.join(root, "cases");
  await mkdir(caseDir, { recursive: true });
  return { root, deps, caseDir, llm };
}

describe("runEval", () => {
  it("passes every check when the catalog matches the case", async () => {
    const { deps, caseDir, llm } = await setup();
    const recipeV1: Recipe = {
      ...base, id: "lasagna--v1", nameRu: "Лазанья", cuisine: "italian", mealTypes: ["dinner"],
      source: { ...base.source, videoId: "v1", segmentStart: 0 },
    };
    await deps.catalog.write(recipeV1);

    await writeFile(
      path.join(caseDir, "v1.json"),
      JSON.stringify({
        videoId: "v1",
        note: "matching case",
        expect: {
          dishCount: 1,
          names: ["Лазанья"],
          cuisines: ["italian"],
          mealTypes: [["dinner"]],
          ingredients: { dishIndex: 0, must: [{ ingredient: "onion", provenance: "inferred" }] },
        },
      }),
    );

    const rows = await runEval(deps, caseDir, { force: false });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.pass)).toBe(true);
    expect(llm.callStructured).not.toHaveBeenCalled();
  });

  it("fails the checks that don't match and reports expected/actual", async () => {
    const { deps, caseDir } = await setup();
    const recipeV2: Recipe = {
      ...base, id: "soup--v2", nameRu: "Суп", cuisine: "russian", mealTypes: ["lunch"],
      source: { ...base.source, videoId: "v2", segmentStart: 0 },
    };
    await deps.catalog.write(recipeV2);

    await writeFile(
      path.join(caseDir, "v2.json"),
      JSON.stringify({
        videoId: "v2",
        note: "mismatching case: expects two dishes but only one is in the catalog",
        expect: {
          dishCount: 2,
          names: ["Суп", "Второе"],
          cuisines: ["russian", "russian"],
          mealTypes: [["lunch"], ["dinner"]],
        },
      }),
    );

    const rows = await runEval(deps, caseDir, { force: false });

    const dishCountRow = rows.find((r) => r.videoId === "v2" && r.check === "dishCount") as EvalRow;
    expect(dishCountRow.pass).toBe(false);
    expect(dishCountRow.expected).toBe("2");
    expect(dishCountRow.actual).toBe("1");
    expect(rows.some((r) => !r.pass)).toBe(true);
  });

  it("reports an unmatched must-ingredient as a failing check", async () => {
    const { deps, caseDir } = await setup();
    const recipeV3: Recipe = {
      ...base, id: "borscht--v3", nameRu: "Борщ", cuisine: "ukrainian", mealTypes: ["lunch"],
      ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
      source: { ...base.source, videoId: "v3", segmentStart: 0 },
    };
    await deps.catalog.write(recipeV3);

    await writeFile(
      path.join(caseDir, "v3.json"),
      JSON.stringify({
        videoId: "v3",
        note: "expects an ingredient that is not in the recipe",
        expect: {
          dishCount: 1,
          names: ["Борщ"],
          cuisines: ["ukrainian"],
          mealTypes: [["lunch"]],
          ingredients: { dishIndex: 0, must: [{ ingredient: "beetroot", provenance: "stated", quantity: 2 }] },
        },
      }),
    );

    const rows = await runEval(deps, caseDir, { force: false });

    const ingredientRow = rows.find((r) => r.check === "ingredient:beetroot") as EvalRow;
    expect(ingredientRow.pass).toBe(false);
    expect(ingredientRow.actual).toBe("null");
  });

  it("fails instead of reporting success when the case directory holds no cases", async () => {
    const { deps, caseDir } = await setup();
    await expect(runEval(deps, caseDir, { force: false })).rejects.toThrow(/no cases in .*cases/);
  });

  it("throws an error naming the offending file when a case is malformed", async () => {
    const { deps, caseDir } = await setup();
    await writeFile(path.join(caseDir, "broken.json"), "{ not valid json");

    await expect(runEval(deps, caseDir, { force: false })).rejects.toThrow(/^broken\.json:/);
  });

  it("throws an error naming the offending file when a case fails schema validation", async () => {
    const { deps, caseDir } = await setup();
    await writeFile(path.join(caseDir, "invalid-shape.json"), JSON.stringify({ videoId: "v9" }));

    await expect(runEval(deps, caseDir, { force: false })).rejects.toThrow(/^invalid-shape\.json:/);
  });
});

describe("renderEval", () => {
  it("renders a markdown table with a pass/fail summary line", () => {
    const rows: EvalRow[] = [
      { videoId: "v1", check: "dishCount", expected: "1", actual: "1", pass: true },
      { videoId: "v2", check: "dishCount", expected: "2", actual: "1", pass: false },
    ];

    const out = renderEval(rows);

    expect(out).toContain("| video | check | expected | actual | ok |");
    expect(out).toContain("| v1 | dishCount | 1 | 1 | ✓ |");
    expect(out).toContain("| v2 | dishCount | 2 | 1 | ✗ |");
    expect(out).toContain("1/2 checks passed");
  });
});
