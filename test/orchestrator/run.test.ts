import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingest } from "../../src/orchestrator/run.js";
import { StageCache } from "../../src/orchestrator/cache.js";
import { Catalog } from "../../src/orchestrator/catalog.js";
import { buildConfig } from "../../src/config.js";
import { loadVocab } from "../../src/vocab/load.js";
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
});
