import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingest } from "../../src/orchestrator/run.js";
import { StageCache } from "../../src/orchestrator/cache.js";
import { Catalog } from "../../src/orchestrator/catalog.js";
import { buildConfig } from "../../src/config.js";
import { loadVocab, type Vocab } from "../../src/vocab/load.js";
import type { VideoSource } from "../../src/schemas/source.js";
import type { FetchResult } from "../../src/fetcher/ytdlp.js";

const source: VideoSource = {
  videoId: "v1", url: "u", title: "Лазанья", tags: [], channel: "C", channelId: "UC", durationSec: 300, uploadDate: null, language: "ru",
  cues: [{ start: 0, end: 5, text: "лазанья" }, { start: 100, end: 105, text: "нарежем лук" }],
};

function fakeLlm() {
  return {
    callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
        case "extractor": return { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: ["хамон"],
          ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
          steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }] };
        case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
        case "judge": return { relation: "same", reason: "r", newNameRu: null, existingNameRu: null };
        default: throw new Error(agent);
      }
    }),
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
  const config = buildConfig({});
  return {
    config,
    llm: fakeLlm(),
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(path.join(root, "cache")),
    catalog: new Catalog(path.join(root, "catalog")),
    fetch: vi.fn(async (): Promise<FetchResult> => source),
    expand: vi.fn(async () => ["v1"]),
  };
}

describe("ingest", () => {
  it("runs every stage once, writes the recipe and reports unmapped names", async () => {
    const deps = await setup();
    const report = await ingest("https://youtu.be/v1", deps, {});
    expect(report.videos[0].status).toBe("done");
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.unmapped).toEqual({ "хамон": 1 });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect((await deps.catalog.load())[0].nameRu).toBe("Лазанья с соусом болоньезе");
  });

  it("uses the cache on a second run and keeps the existing recipe without calling the judge", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, {});
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual([]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
    expect(await deps.catalog.load()).toHaveLength(1);
  });

  it("calls the judge when another video yields the same dish and keeps the more complete one", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.expand = vi.fn(async () => ["v2"]);
    deps.fetch = vi.fn(async () => ({ ...source, videoId: "v2" }));
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v2", deps, {});
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer", "judge"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
    expect(await deps.catalog.load()).toHaveLength(1);
  });

  it("records a skipped video when there are no captions", async () => {
    const deps = await setup();
    deps.fetch = vi.fn(async () => ({ videoId: "v1", skipped: "no-captions" as const }));
    const report = await ingest("https://youtu.be/v1", deps, {});
    expect(report.videos[0].status).toBe("skipped-no-captions");
    expect(deps.llm.callStructured).not.toHaveBeenCalled();
  });

  // --- fix round 1 ---

  it("re-running with --only-stage scout re-runs scout and every downstream stage", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "scout" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    // scout, extract, verify, categorize all re-run (ordinal downstream force); the
    // recipe is unchanged so it lands back on the self-completeness early-return, no judge call.
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage extract without --force re-runs extract, verify, categorize but not scout", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "extract" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["extractor", "verifier", "categorizer"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage categorize alone re-runs only categorize", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "categorize" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["categorizer"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage and --force together behave exactly like --only-stage alone", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { force: true, onlyStage: "extract" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["extractor", "verifier", "categorizer"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--force alone (no --only-stage) re-runs every agent stage but keeps the cached source", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { force: true });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
    // fetch is never re-invoked past the first run: the source stage stays cached under both flags.
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("assigns a -2 id and separate cache keys to two same-dishKey segments from one video, and keeps both via keep-both", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
    const config = buildConfig({});
    const twoSegSource: VideoSource = { ...source, videoId: "v1" };
    const llm = {
      callStructured: vi.fn(async ({ agent, user }: any): Promise<any> => {
        switch (agent) {
          case "scout": return {
            isRecipeVideo: true,
            segments: [
              { workingName: "лазанья", start: 0, end: 150, rawText: "a".repeat(50), cleanText: "Нарежем лук." },
              { workingName: "лазанья добавка", start: 150, end: 300, rawText: "b".repeat(50), cleanText: "Нарежем ещё лука." },
            ],
          };
          case "extractor": {
            const isSecond = (user as string).includes("лазанья добавка");
            return {
              nameRu: isSecond ? "Лазанья добавка" : "Лазанья с соусом болоньезе",
              nameEn: isSecond ? "Lasagna extra" : "Lasagna with bolognese",
              servings: null, unmappedIngredients: [],
              ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
              steps: [{ order: 1, text: "Нарезать лук.", timestamp: isSecond ? 150 : 0 }],
            };
          }
          case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
          case "judge": return { relation: "variant", reason: "two portions of the same dish", newNameRu: null, existingNameRu: null };
          default: throw new Error(agent);
        }
      }),
    };
    const deps = {
      config,
      llm,
      vocab: await loadVocab(config.paths.vocab),
      cache: new StageCache(path.join(root, "cache")),
      catalog: new Catalog(path.join(root, "catalog")),
      fetch: vi.fn(async (): Promise<FetchResult> => twoSegSource),
      expand: vi.fn(async () => ["v1"]),
    };

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.written.sort()).toEqual(["lasagna-bolognese--v1", "lasagna-bolognese--v1-2"]);
    expect(await deps.cache.has("v1", "extract-0")).toBe(true);
    expect(await deps.cache.has("v1", "extract-1")).toBe(true);
    expect(await deps.cache.has("v1", "verify-0")).toBe(true);
    expect(await deps.cache.has("v1", "verify-1")).toBe(true);
    const ids = (await deps.catalog.load()).map((r) => r.id).sort();
    expect(ids).toEqual(["lasagna-bolognese--v1", "lasagna-bolognese--v1-2"]);
  });

  it("keeps both recipes and applies the judge-provided renames for a variant relation across two videos", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});

    deps.expand = vi.fn(async () => ["v2"]);
    deps.fetch = vi.fn(async () => ({ ...source, videoId: "v2" }));
    deps.llm = {
      callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
        switch (agent) {
          case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
          case "extractor": return { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
            ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
            steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }] };
          case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
          case "judge": return { relation: "variant", reason: "a meat and a veggie version", newNameRu: "Лазанья с соусом болоньезе (v2)", existingNameRu: "Лазанья с соусом болоньезе (v1)" };
          default: throw new Error(agent);
        }
      }),
    };

    const report = await ingest("https://youtu.be/v2", deps, {});

    expect(report.written).toEqual(["lasagna-bolognese--v2"]);
    const recipes = await deps.catalog.load();
    expect(recipes).toHaveLength(2);
    expect(recipes.find((r) => r.id === "lasagna-bolognese--v1")?.nameRu).toBe("Лазанья с соусом болоньезе (v1)");
    expect(recipes.find((r) => r.id === "lasagna-bolognese--v2")?.nameRu).toBe("Лазанья с соусом болоньезе (v2)");
  });

  it("serializes catalog placement across videos processed concurrently, so the judge sees the first video's write before deciding the second", async () => {
    // Without the promise-chain mutex around placeInCatalog, both videos could race
    // catalog.load() before either had written, each seeing zero candidates and writing
    // directly — the judge never called, and both recipes left with the same unrenamed
    // name (judgeCalls would be 0, and the two nameRu values would collide).
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
    const config = buildConfig({});
    const llm = {
      callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
        switch (agent) {
          case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
          case "extractor": return { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
            ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
            steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }] };
          case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
          case "judge": return { relation: "variant", reason: "a meat and a veggie version", newNameRu: "Лазанья с соусом болоньезе (new)", existingNameRu: "Лазанья с соусом болоньезе (existing)" };
          default: throw new Error(agent);
        }
      }),
    };
    const deps = {
      config,
      llm,
      vocab: await loadVocab(config.paths.vocab),
      cache: new StageCache(path.join(root, "cache")),
      catalog: new Catalog(path.join(root, "catalog")),
      fetch: vi.fn(async (videoId: string): Promise<FetchResult> => ({ ...source, videoId, title: `Лазанья ${videoId}` })),
      expand: vi.fn(async () => ["v1", "v2"]),
    };

    const report = await ingest("https://youtu.be/playlist", deps, {});

    expect(report.videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
    const judgeCalls = llm.callStructured.mock.calls.filter((c: any) => c[0].agent === "judge").length;
    expect(judgeCalls).toBe(1);
    // both videos' own recipes get written (one straight off, one via the keep-both branch);
    // only the pre-existing one gets renamed in place, which report.written doesn't count.
    expect(report.written).toHaveLength(2);
    const recipes = await deps.catalog.load();
    expect(recipes).toHaveLength(2);
    expect(recipes.map((r) => r.id).sort()).toEqual(["lasagna-bolognese--v1", "lasagna-bolognese--v2"]);
    expect(new Set(recipes.map((r) => r.nameRu)).size).toBe(2);
  });

  it("skips an invalid recipe (unmapped cuisine) but still writes its sibling from the same video", async () => {
    // runExtractor already sanitizes unknown ingredient ids to null before a draft can reach
    // validateRecipe, and runCategorizer already throws on an unknown *category* before returning
    // — so neither ingredient nor category can reach validateRecipe invalid. Cuisine is the one
    // field that slips through: runCategorizer only coerces an unmapped cuisine to "other", it
    // doesn't verify "other" itself is in the vocab. A vocab whose cuisines list has a real entry
    // ("italian") but no "other" catch-all fails validateRecipe only for the recipe whose
    // categorizer output falls back to "other" (cuisine "russian", not in this trimmed list) —
    // its sibling, categorized "italian" directly, still validates and is written.
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
    const config = buildConfig({});
    const fullVocab: Vocab = await loadVocab(config.paths.vocab);
    const vocab: Vocab = { ...fullVocab, cuisines: [{ id: "italian", nameRu: "Итальянская", nameEn: "Italian" }] };
    const llm = {
      callStructured: vi.fn(async ({ agent, user }: any): Promise<any> => {
        switch (agent) {
          case "scout": return {
            isRecipeVideo: true,
            segments: [
              { workingName: "лазанья", start: 0, end: 150, rawText: "a".repeat(50), cleanText: "Нарежем лук." },
              { workingName: "суп", start: 150, end: 300, rawText: "b".repeat(50), cleanText: "Сварим суп." },
            ],
          };
          case "extractor": {
            const isSoup = (user as string).includes("Dish (working name): суп");
            return isSoup
              ? { nameRu: "Загадочный суп", nameEn: "Mystery soup", servings: null, unmappedIngredients: [],
                  ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
                  steps: [{ order: 1, text: "Сварить.", timestamp: 150 }] }
              : { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
                  ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
                  steps: [{ order: 1, text: "Нарезать лук.", timestamp: 0 }] };
          }
          case "verifier": return { ingredients: [], steps: [], confidence: 0.9 };
          case "categorizer": {
            const isSoup = (user as string).includes("Загадочный суп");
            // "russian" is absent from the trimmed vocab, so runCategorizer's own fallback
            // coerces it to "other" — which, unlike the real vocab, is also absent here.
            return isSoup
              ? { cuisine: "russian", mealTypes: ["lunch"], category: "soup", activeMinutes: 20, totalMinutes: 40, richness: "light", dishKey: "mystery-soup" }
              : { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
          }
          case "judge": return { relation: "same", reason: "r", newNameRu: null, existingNameRu: null };
          default: throw new Error(agent);
        }
      }),
    };
    const deps = {
      config,
      llm,
      vocab,
      cache: new StageCache(path.join(root, "cache")),
      catalog: new Catalog(path.join(root, "catalog")),
      fetch: vi.fn(async (): Promise<FetchResult> => ({ ...source, videoId: "v1" })),
      expand: vi.fn(async () => ["v1"]),
    };

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.videos[0].status).toBe("done");
    expect(report.videos[0].recipes).toBe(1);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.validationErrors).toHaveLength(1);
    expect(report.validationErrors[0].recipeId).toBe("mystery-soup--v1");
    expect(report.validationErrors[0].errors[0]).toContain("unknown cuisine: other");
    const recipes = await deps.catalog.load();
    expect(recipes).toHaveLength(1);
    expect(recipes[0].id).toBe("lasagna-bolognese--v1");
  });

  it("processes videos concurrently but keeps report rows in videoIds order regardless of completion order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
    const config = buildConfig({});
    const llm = {
      callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
        switch (agent) {
          case "scout": return { isRecipeVideo: false, segments: [] };
          default: throw new Error(agent);
        }
      }),
    };
    const deps = {
      config,
      llm,
      vocab: await loadVocab(config.paths.vocab),
      cache: new StageCache(path.join(root, "cache")),
      catalog: new Catalog(path.join(root, "catalog")),
      // v1 resolves its fetch slower than v2 so, if rows were ordered by completion,
      // v2 would land first; the fix must still report v1 before v2.
      fetch: vi.fn(async (videoId: string): Promise<FetchResult> => {
        if (videoId === "v1") await new Promise((r) => setTimeout(r, 20));
        return { ...source, videoId };
      }),
      expand: vi.fn(async () => ["v1", "v2"]),
    };

    const report = await ingest("https://youtu.be/playlist", deps, {});

    expect(report.videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
    expect(report.videos.every((v) => v.status === "not-recipe")).toBe(true);
  });
});
