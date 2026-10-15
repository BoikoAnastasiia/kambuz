import { describe, it, expect } from "vitest";
import path from "node:path";
import { readTranslationEvalIds, renderTranslationEval } from "../../src/eval/translation.js";
import { config } from "../../src/config.js";

describe("translation eval", () => {
  it("reads the 20 recipe ids from eval/translation.json", async () => {
    const ids = await readTranslationEvalIds(path.join(config.paths.eval, "translation.json"));
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("counts clean recipes and issues by kind", () => {
    const md = renderTranslationEval(
      {
        rows: [
          { recipeId: "a", nameRu: "А", checks: [], issues: [] },
          { recipeId: "b", nameRu: "Б", checks: ["step 1: the number 2 is missing"], issues: [{ item: "step 2", kind: "added", russian: "р", english: "e", explanation: "x" }] },
        ],
        missing: ["gone"],
      },
      { translator: "t", proofreader: "p" },
      "$0.10",
    );
    expect(md).toContain("| 1/2 | 0 | 1 | 0 | 0 | 0 | 1 |");
    expect(md).toContain("Not in the catalog any more: gone");
    expect(md).toContain("- check: step 1: the number 2 is missing");
  });
});
