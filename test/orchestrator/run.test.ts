import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingest } from "../../src/orchestrator/run.js";
import type { IngestEvent } from "../../src/orchestrator/events.js";
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

// 3 quantified/supported ingredients + 3 supported steps, reused by every fixture below
// that needs a recipe clearing the default KAMBUZ_MIN_COMPLETENESS (0.3):
// 0.9 * (3/5 * 3/6) + 0.1 * (3/3) = 0.37. A single ingredient/step (the old fixture size)
// now scores below the threshold and would be reported as too-thin instead of written.
function richIngredients() {
  return [
    { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred" as const, note: null },
    { ingredient: "garlic", rawName: "чеснок", quantity: 2, unit: "pc", provenance: "inferred" as const, note: null },
    { ingredient: "carrot", rawName: "морковь", quantity: 1, unit: "pc", provenance: "inferred" as const, note: null },
  ];
}
function richSteps(base: number) {
  return [
    { order: 1, text: "Нарезать лук.", timestamp: base },
    { order: 2, text: "Нарезать чеснок.", timestamp: base + 10 },
    { order: 3, text: "Нарезать морковь.", timestamp: base + 20 },
  ];
}
function richVerification() {
  return {
    ingredients: [
      { rawName: "лук", quote: "нарежем лук", supported: true },
      { rawName: "чеснок", quote: "нарежем лук", supported: true },
      { rawName: "морковь", quote: "нарежем лук", supported: true },
    ],
    steps: [
      { order: 1, quote: "нарежем лук", supported: true },
      { order: 2, quote: "нарежем лук", supported: true },
      { order: 3, quote: "нарежем лук", supported: true },
    ],
    confidence: 0.9,
  };
}

function fakeLlm() {
  return {
    callStructured: vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
        case "extractor": return { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: ["хамон"],
          ingredients: richIngredients(), steps: richSteps(100) };
        case "verifier": return richVerification();
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
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

  it("uses the cache on a second run and overwrites the same-segment entry without calling the judge", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, {});
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual([]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.superseded).toEqual([]);
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

  function twoSegmentLlm(failOn: (user: string) => boolean) {
    return {
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
            if (failOn(user as string)) throw new Error("extractor blew up on this segment");
            const isSoup = (user as string).includes("Dish (working name): суп");
            return { nameRu: isSoup ? "Суп" : "Лазанья с соусом болоньезе", nameEn: isSoup ? "Soup" : "Lasagna", servings: null, unmappedIngredients: [],
              ingredients: richIngredients(), steps: richSteps(isSoup ? 150 : 0) };
          }
          case "verifier": return richVerification();
          case "categorizer": {
            const isSoup = (user as string).includes("Суп");
            return isSoup
              ? { cuisine: "russian", mealTypes: ["lunch"], course: "soup", method: null, activeMinutes: 20, totalMinutes: 40, richness: "light", dishKey: "soup" }
              : { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
          }
          case "judge": return { relation: "same", reason: "r", newNameRu: null, existingNameRu: null };
          default: throw new Error(agent);
        }
      }),
    };
  }

  it("keeps the recipes of a video's good segments when one segment fails", async () => {
    const deps = await setup();
    deps.llm = twoSegmentLlm((user) => user.includes("Dish (working name): суп"));

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.videos[0].status).toBe("done");
    expect(report.videos[0].recipes).toBe(1);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.segmentErrors).toEqual([
      { videoId: "v1", segmentIndex: 1, workingName: "суп", error: "extractor blew up on this segment" },
    ]);
  });

  it("marks the video as an error only when every segment failed", async () => {
    const deps = await setup();
    deps.llm = twoSegmentLlm(() => true);

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.videos[0].status).toBe("error");
    expect(report.videos[0].recipes).toBe(0);
    expect(report.segmentErrors).toHaveLength(2);
    expect(report.written).toEqual([]);
  });

  it("reports a recipe that fails the strict persisted schema instead of writing it", async () => {
    // The categorizer's wire schema can't enforce the dishKey pattern, so a model answer
    // of "!!!" slugifies to "" — caught by RecipeSchema before the file is written.
    const deps = await setup();
    deps.llm.callStructured = vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
        case "extractor": return { nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
          ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
          steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }] };
        case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "!!!" };
        default: throw new Error(agent);
      }
    });

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.written).toEqual([]);
    expect(report.validationErrors).toHaveLength(1);
    expect(report.validationErrors[0].errors.join(" ")).toMatch(/dishKey/);
    expect(await deps.catalog.load()).toHaveLength(0);
  });

  it("does not write a recipe below the completeness threshold, and records it in tooThin instead", async () => {
    // Default KAMBUZ_MIN_COMPLETENESS (0.3). One ingredient with no quantity (so its
    // provenance is forced to unknown) + 5 steps scores 0.9 * (0.2 * 0.8333) = 0.15 —
    // the owner's "Тефтели с сыром" case: too thin to be worth keeping in the catalog.
    const deps = await setup();
    deps.llm.callStructured = vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "scout": return { isRecipeVideo: true, segments: [{ workingName: "тефтели с сыром", start: 0, end: 300, rawText: "", cleanText: "Лепим тефтели." }] };
        case "extractor": return { nameRu: "Тефтели с сыром", nameEn: "Meatballs with cheese", servings: null, unmappedIngredients: [],
          ingredients: [{ ingredient: "cheese-hard", rawName: "сыр", quantity: null, unit: null, provenance: "stated", note: null }],
          steps: [1, 2, 3, 4, 5].map((n) => ({ order: n, text: `Шаг ${n}.`, timestamp: n * 10 })) };
        case "verifier": return {
          ingredients: [{ rawName: "сыр", quote: null, supported: true }],
          steps: [1, 2, 3, 4, 5].map((n) => ({ order: n, quote: null, supported: true })),
          confidence: 0.9,
        };
        case "categorizer": return { cuisine: "other", mealTypes: ["dinner"], course: "main", method: "grill", activeMinutes: 20, totalMinutes: 30, richness: "medium", dishKey: "meatballs-with-cheese" };
        default: throw new Error(agent);
      }
    });

    const report = await ingest("https://youtu.be/v1", deps, {});

    expect(report.written).toEqual([]);
    expect(report.tooThin).toEqual([{ recipeId: "meatballs-with-cheese--v1", completeness: expect.closeTo(0.15, 4), ingredients: 1, steps: 5 }]);
    expect(await deps.catalog.load()).toHaveLength(0);
  });

  it("turns a playlist-expansion failure into a plain message, not a raw yt-dlp stack", async () => {
    const deps = await setup();
    deps.expand = vi.fn(async () => { throw new Error("ERROR: Unable to download API page"); });
    await expect(ingest("https://www.youtube.com/playlist?list=PL1", deps, {})).rejects.toThrow(
      /could not expand https:\/\/www\.youtube\.com\/playlist\?list=PL1: ERROR: Unable to download API page/,
    );
  });

  // --- fix round 1 ---

  it("re-running with --only-stage scout re-runs scout and every downstream stage", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "scout" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    // scout, extract, verify, categorize all re-run (ordinal downstream force); the
    // recipe is unchanged and re-processing a segment always overwrites its own entry
    // directly, with no self-completeness comparison and no judge call.
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage extract without --force re-runs extract, verify, categorize but not scout", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "extract" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["extractor", "verifier", "categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage categorize alone re-runs only categorize", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "categorize" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--only-stage and --force together behave exactly like --only-stage alone", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { force: true, onlyStage: "extract" });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["extractor", "verifier", "categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
  });

  it("--force alone (no --only-stage) re-runs every agent stage but keeps the cached source", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, { force: true });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
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
              ingredients: richIngredients(),
              steps: richSteps(isSecond ? 150 : 0),
            };
          }
          case "verifier": return richVerification();
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
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
            ingredients: richIngredients(), steps: richSteps(100) };
          case "verifier": return richVerification();
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
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
            ingredients: richIngredients(), steps: richSteps(100) };
          case "verifier": return richVerification();
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
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
    // validateRecipe, so an ingredient cannot get there invalid. Cuisine is another field that
    // slips through: runCategorizer only coerces an unmapped cuisine to "other", it
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
              // Needs enough ingredients/steps to clear the completeness threshold: this is the
              // sibling the test expects to still be written despite the soup failing validation.
              : { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
                  ingredients: richIngredients(), steps: richSteps(0) };
          }
          case "verifier": return richVerification();
          case "categorizer": {
            const isSoup = (user as string).includes("Загадочный суп");
            // "russian" is absent from the trimmed vocab, so runCategorizer's own fallback
            // coerces it to "other" — which, unlike the real vocab, is also absent here.
            return isSoup
              ? { cuisine: "russian", mealTypes: ["lunch"], course: "soup", method: null, activeMinutes: 20, totalMinutes: 40, richness: "light", dishKey: "mystery-soup" }
              : { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
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

  it("never runs more than `concurrency` LLM calls at once, across videos and segments together", async () => {
    // Before the fix a per-video limit wrapped a per-segment limit, so the real ceiling
    // was concurrency² — 4 calls in flight for a configured concurrency of 2.
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
    const config = { ...buildConfig({}), concurrency: 2 };
    let inFlight = 0;
    let peak = 0;
    const llm = {
      callStructured: vi.fn(async ({ agent, user }: any): Promise<any> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        switch (agent) {
          case "scout": return {
            isRecipeVideo: true,
            segments: [0, 1, 2].map((i) => ({ workingName: `dish${i}`, start: i * 100, end: i * 100 + 100, rawText: "", cleanText: `Нарежем лук ${i}.` })),
          };
          case "extractor": return { nameRu: `Блюдо ${user.length}`, nameEn: "Dish", servings: null, unmappedIngredients: [],
            ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
            steps: [{ order: 1, text: "Нарезать лук.", timestamp: 0 }] };
          case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
          case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: `dish-${user.length}` };
          case "judge": return { relation: "variant", reason: "r", newNameRu: null, existingNameRu: null };
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
      fetch: vi.fn(async (videoId: string): Promise<FetchResult> => ({ ...source, videoId })),
      expand: vi.fn(async () => ["v1", "v2"]),
    };

    await ingest("https://youtu.be/playlist", deps, {});

    expect(llm.callStructured.mock.calls.length).toBeGreaterThan(6);
    expect(peak).toBeLessThanOrEqual(2);
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

  // --- progress events ---

  it("emits a stage:cached progress event for every stage on a cached re-run of one video", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});

    const events: IngestEvent[] = [];
    const report = await ingest("https://youtu.be/v1", { ...deps, onEvent: (e) => events.push(e) }, {});

    expect(report.videos[0].status).toBe("done");
    expect(events.map((e) => e.type)).toEqual([
      "videos",
      "video:start",
      "stage:cached",
      "video:title",
      "stage:cached",
      "stage:cached",
      "stage:cached",
      "stage:cached",
      "placement",
      "video:done",
    ]);
    expect(events[0]).toEqual({ type: "videos", videoIds: ["v1"] });
    expect(events[1]).toEqual({ type: "video:start", videoId: "v1" });
    expect(events[2]).toEqual({ type: "stage:cached", videoId: "v1", stage: "source" });
    expect(events[3]).toEqual({ type: "video:title", videoId: "v1", title: "Лазанья" });
    expect(events[4]).toEqual({ type: "stage:cached", videoId: "v1", stage: "scout" });
    expect(events[5]).toEqual({ type: "stage:cached", videoId: "v1", stage: "extract", segmentIndex: 0 });
    expect(events[6]).toEqual({ type: "stage:cached", videoId: "v1", stage: "verify", segmentIndex: 0 });
    expect(events[7]).toEqual({ type: "stage:cached", videoId: "v1", stage: "categorize", segmentIndex: 0 });
    expect(events[8]).toEqual({ type: "placement", videoId: "v1", recipeId: "lasagna-bolognese--v1", action: "written" });
    expect(events[9]).toEqual({ type: "video:done", videoId: "v1", status: "done", recipes: 1 });
  });

  it("emits ordered stage:start/stage:done events per segment for a live two-segment video, ending in two placements and video:done", async () => {
    const deps = await setup();
    deps.llm = twoSegmentLlm(() => false);
    // Both segments' fake extractor output the same single ingredient, so the two
    // recipes look like candidates of each other (jaccard match) even though their
    // dishKeys differ; force the judge to treat them as distinct dishes so both land
    // in the catalog, one via "written" and the other via the keep-both path.
    const baseCallStructured = deps.llm.callStructured;
    deps.llm.callStructured = vi.fn(async (args: any): Promise<any> =>
      args.agent === "judge" ? { relation: "variant", reason: "two different dishes", newNameRu: null, existingNameRu: null } : baseCallStructured(args),
    );

    const events: IngestEvent[] = [];
    const report = await ingest("https://youtu.be/v1", { ...deps, onEvent: (e) => events.push(e) }, {});

    expect(report.videos[0].status).toBe("done");
    expect(report.videos[0].recipes).toBe(2);
    expect(events[0]).toEqual({ type: "videos", videoIds: ["v1"] });
    expect(events[1]).toEqual({ type: "video:start", videoId: "v1" });
    expect(events.at(-1)).toEqual({ type: "video:done", videoId: "v1", status: "done", recipes: 2 });

    const sourceStartIdx = events.findIndex((e) => e.type === "stage:start" && e.stage === "source");
    const sourceDoneIdx = events.findIndex((e) => e.type === "stage:done" && e.stage === "source");
    const scoutStartIdx = events.findIndex((e) => e.type === "stage:start" && e.stage === "scout");
    expect(sourceStartIdx).toBeGreaterThanOrEqual(0);
    expect(sourceDoneIdx).toBeGreaterThan(sourceStartIdx);
    expect(scoutStartIdx).toBeGreaterThan(sourceDoneIdx);

    // Each segment runs extract -> verify -> categorize in order; the two segments
    // run concurrently with each other, so only the per-segment order is asserted.
    for (const segmentIndex of [0, 1]) {
      const seq = events
        .filter((e): e is Extract<IngestEvent, { type: "stage:start" | "stage:done" }> => (e.type === "stage:start" || e.type === "stage:done") && e.segmentIndex === segmentIndex)
        .map((e) => `${e.type}:${e.stage}`);
      expect(seq).toEqual(["stage:start:extract", "stage:done:extract", "stage:start:verify", "stage:done:verify", "stage:start:categorize", "stage:done:categorize"]);
    }

    const placements = events.filter((e): e is Extract<IngestEvent, { type: "placement" }> => e.type === "placement");
    expect(placements).toHaveLength(2);
    expect(placements.map((p) => p.recipeId).sort()).toEqual(["lasagna-bolognese--v1", "soup--v1"]);
    expect(placements.map((p) => p.action).sort()).toEqual(["kept-both", "written"]);
  });

  it("emits stage:error (then segment:error) when an agent call throws, without a stage:done for that stage (fix round 2, #3)", async () => {
    const deps = await setup();
    deps.llm = twoSegmentLlm((user) => user.includes("Dish (working name): суп"));

    const events: IngestEvent[] = [];
    const report = await ingest("https://youtu.be/v1", { ...deps, onEvent: (e) => events.push(e) }, {});

    expect(report.videos[0].status).toBe("done");
    expect(report.videos[0].recipes).toBe(1);

    // The failing segment (index 1, "суп") gets stage:start -> stage:error for extract,
    // and nothing else for that stage — no stage:done, no stage:cached, no verify/categorize
    // (the segment's own async chain never gets there).
    const segment1 = events.filter((e): e is Extract<IngestEvent, { type: "stage:start" | "stage:done" | "stage:error" }> => (e.type === "stage:start" || e.type === "stage:done" || e.type === "stage:error") && e.segmentIndex === 1);
    expect(segment1.map((e) => e.type)).toEqual(["stage:start", "stage:error"]);
    expect(segment1[1]).toMatchObject({ type: "stage:error", videoId: "v1", stage: "extract", segmentIndex: 1, error: "extractor blew up on this segment" });

    // stage:error for that stage comes before the segment-level segment:error.
    const stageErrorIdx = events.findIndex((e) => e.type === "stage:error");
    const segmentErrorIdx = events.findIndex((e) => e.type === "segment:error");
    expect(stageErrorIdx).toBeGreaterThanOrEqual(0);
    expect(segmentErrorIdx).toBeGreaterThan(stageErrorIdx);
    expect(events[segmentErrorIdx]).toEqual({ type: "segment:error", videoId: "v1", segmentIndex: 1, error: "extractor blew up on this segment" });

    // The healthy segment (index 0) is unaffected: full start/done chain, no stage:error.
    const segment0Types = events.filter((e): e is Extract<IngestEvent, { type: "stage:start" | "stage:done" | "stage:error" }> => (e.type === "stage:start" || e.type === "stage:done" || e.type === "stage:error") && e.segmentIndex === 0).map((e) => e.type);
    expect(segment0Types).toEqual(["stage:start", "stage:done", "stage:start", "stage:done", "stage:start", "stage:done"]);
  });

  // --- re-processing a segment supersedes its old catalog entry ---

  it("re-running the same segment with a lower-scoring extraction overwrites the catalog with the new, lower score and calls no judge", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    const before = (await deps.catalog.load())[0];
    expect(before.completeness).toBeCloseTo(0.37, 2);

    deps.llm.callStructured.mockClear();
    deps.llm.callStructured = vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "extractor": return {
          nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
          ingredients: richIngredients().slice(0, 2),
          steps: [
            { order: 1, text: "Нарезать лук.", timestamp: 100 },
            { order: 2, text: "Нарезать чеснок.", timestamp: 110 },
            { order: 3, text: "Обжарить.", timestamp: 120 },
            { order: 4, text: "Подать.", timestamp: 130 },
          ],
        };
        case "verifier": return {
          ingredients: [
            { rawName: "лук", quote: "нарежем лук", supported: true },
            { rawName: "чеснок", quote: "нарежем лук", supported: true },
          ],
          steps: [1, 2, 3, 4].map((n) => ({ order: n, quote: "нарежем лук", supported: true })),
          confidence: 0.9,
        };
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
        default: throw new Error(agent);
      }
    });

    const report = await ingest("https://youtu.be/v1", deps, { onlyStage: "extract" });

    const agents = deps.llm.callStructured.mock.calls.map((c: any) => c[0].agent);
    expect(agents).toEqual(["extractor", "verifier", "categorizer"]);
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.superseded).toEqual([]);
    const recipes = await deps.catalog.load();
    expect(recipes).toHaveLength(1);
    expect(recipes[0].completeness).toBeCloseTo(0.34, 2);
    expect(recipes[0].completeness).toBeLessThan(before.completeness);
  });

  it("re-running with a drifted dishKey archives the old id under superseded and writes the new id, with no judge call", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});

    deps.llm.callStructured.mockClear();
    deps.llm.callStructured = vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "zharkoye" };
        default: throw new Error(agent);
      }
    });

    const events: IngestEvent[] = [];
    const report = await ingest("https://youtu.be/v1", { ...deps, onEvent: (e) => events.push(e) }, { onlyStage: "categorize" });

    const agents = deps.llm.callStructured.mock.calls.map((c: any) => c[0].agent);
    expect(agents).toEqual(["categorizer"]);
    expect(report.written).toEqual(["zharkoye--v1"]);
    expect(report.superseded).toEqual(["lasagna-bolognese--v1"]);
    const recipes = await deps.catalog.load();
    expect(recipes.map((r) => r.id)).toEqual(["zharkoye--v1"]);
    const placements = events.filter((e): e is Extract<IngestEvent, { type: "placement" }> => e.type === "placement");
    expect(placements.map((p) => p.action).sort()).toEqual(["superseded", "written"]);
  });

  it("re-running a segment that is now too thin archives its old catalog entry and records it in tooThin", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});

    deps.llm.callStructured.mockClear();
    deps.llm.callStructured = vi.fn(async ({ agent }: any): Promise<any> => {
      switch (agent) {
        case "extractor": return {
          nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: [],
          ingredients: [{ ingredient: "onion", rawName: "лук", quantity: null, unit: null, provenance: "stated", note: null }],
          steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }],
        };
        case "verifier": return {
          ingredients: [{ rawName: "лук", quote: null, supported: true }],
          steps: [{ order: 1, quote: null, supported: true }],
          confidence: 0.9,
        };
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], course: "main", method: null, activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
        default: throw new Error(agent);
      }
    });

    const events: IngestEvent[] = [];
    const report = await ingest("https://youtu.be/v1", { ...deps, onEvent: (e) => events.push(e) }, { onlyStage: "extract" });

    expect(report.tooThin).toHaveLength(1);
    expect(report.tooThin[0].recipeId).toBe("lasagna-bolognese--v1");
    expect(report.written).toEqual([]);
    expect(report.superseded).toEqual(["lasagna-bolognese--v1"]);
    expect(await deps.catalog.load()).toHaveLength(0);
    const placements = events.filter((e): e is Extract<IngestEvent, { type: "placement" }> => e.type === "placement");
    expect(placements.map((p) => p.action).sort()).toEqual(["superseded", "too-thin"]);
  });
});
