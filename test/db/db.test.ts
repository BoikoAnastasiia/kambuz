import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId, type MongoClient } from "mongodb";
import { connectDb, dbNameFrom, type Collections, type JobDoc } from "../../src/db/mongo.js";
import { MongoCatalog } from "../../src/db/mongoCatalog.js";
import { importCatalog, recordVideos, syncVocab } from "../../src/db/sync.js";
import { claimNextJob, describeEvent, requeueAbandoned, runJob } from "../../src/db/worker.js";
import { MirroredCatalog, type CatalogStore } from "../../src/orchestrator/catalog.js";
import type { Recipe } from "../../src/schemas/recipe.js";
import type { RunReport } from "../../src/orchestrator/report.js";

function recipe(id: string, over: Partial<Recipe> = {}): Recipe {
  return {
    id, nameRu: "Пирог", nameEn: "Pie", dishKey: id.split("--")[0], cuisine: "russian", mealTypes: ["dinner"], course: "main", method: "bake",
    richness: "hearty", servings: null, activeMinutes: 30, totalMinutes: 80,
    ingredients: [{ ingredient: "beef", rawName: "говядина", baseName: "говядина", quantity: null, unit: null, provenance: "unknown", note: null }],
    steps: [{ order: 1, text: "Испечь.", timestamp: 10 }], flags: [], completeness: 0.9,
    source: { videoId: id.split("--")[1] ?? "vid", url: "u", videoTitle: "Видео", channel: "c", channelId: "c", segmentStart: 0, segmentEnd: 60, language: "ru" },
    extractedAt: "2026-10-07T00:00:00.000Z", models: {},
    ...over,
  };
}

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    startedAt: "2026-10-08T10:00:00.000Z", finishedAt: "2026-10-08T10:02:00.000Z", url: "u", videos: [], segmentErrors: [], written: [], archived: [],
    keptExisting: [], superseded: [], unmapped: {}, flags: [], validationErrors: [], tooThin: [], minCompleteness: 0.3, usage: "", usageRows: [],
    ...over,
  } as RunReport;
}

let server: MongoMemoryServer;
let client: MongoClient;
let c: Collections;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  ({ client, c } = await connectDb(`${server.getUri()}kambuz-test`));
}, 120_000);
afterAll(async () => {
  await client?.close();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all([c.recipes.deleteMany({}), c.videos.deleteMany({}), c.jobs.deleteMany({}), c.vocab.deleteMany({})]);
});

describe("dbNameFrom", () => {
  it("reads the database from the URI path and falls back to kambuz", () => {
    expect(dbNameFrom("mongodb+srv://u:p@cluster0.abc.mongodb.net/recipes?retryWrites=true")).toBe("recipes");
    expect(dbNameFrom("mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true")).toBe("kambuz");
    expect(dbNameFrom("mongodb://127.0.0.1:27017")).toBe("kambuz");
  });
});

describe("MongoCatalog", () => {
  it("writes, loads and renames recipes", async () => {
    const cat = new MongoCatalog(c);
    await cat.write(recipe("beef-pie--v1"));
    await cat.rename(recipe("beef-pie--v1"), "Пирог с говядиной");
    const all = await cat.load();
    expect(all.map((r) => [r.id, r.nameRu])).toEqual([["beef-pie--v1", "Пирог с говядиной"]]);
  });

  it("keeps an archived version when the replacement reuses its id", async () => {
    const cat = new MongoCatalog(c);
    await cat.write(recipe("beef-pie--v1", { completeness: 0.5 }));
    await cat.archive(recipe("beef-pie--v1", { completeness: 0.5 }));
    await cat.write(recipe("beef-pie--v1", { completeness: 0.9 }));
    expect((await cat.load()).map((r) => r.completeness)).toEqual([0.9]);
    const archived = await c.recipes.find({ archived: true }).toArray();
    expect(archived).toHaveLength(1);
    expect(archived[0]._id).toMatch(/^beef-pie--v1--/);
    expect(archived[0].completeness).toBe(0.5);
  });
});

describe("MirroredCatalog", () => {
  it("reads from the primary and copies every change to the mirror", async () => {
    const calls: string[] = [];
    const primary: CatalogStore = {
      load: async () => [recipe("from-primary--v")],
      write: async (r) => void calls.push(`write ${r.id}`),
      rename: async (r, n) => void calls.push(`rename ${r.id} ${n}`),
      archive: async (r) => void calls.push(`archive ${r.id}`),
    };
    const mirror = new MongoCatalog(c);
    const cat = new MirroredCatalog(primary, mirror);
    await cat.write(recipe("a--v"));
    await cat.archive(recipe("a--v"));
    expect(calls).toEqual(["write a--v", "archive a--v"]);
    expect((await cat.load()).map((r) => r.id)).toEqual(["from-primary--v"]);
    expect(await c.recipes.countDocuments({ archived: true })).toBe(1);
  });
});

describe("importCatalog and syncVocab", () => {
  it("copies live and archived recipes and records each video once, and can run again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kambuz-catalog-"));
    await mkdir(path.join(root, "recipes"));
    await mkdir(path.join(root, "archive"));
    await writeFile(path.join(root, "recipes", "beef-pie--v1.json"), JSON.stringify(recipe("beef-pie--v1")));
    await writeFile(path.join(root, "recipes", "duck-rice--v1.json"), JSON.stringify(recipe("duck-rice--v1")));
    await writeFile(path.join(root, "archive", "beef-pie--v1--2026-10-01T00-00-00-000Z-ab12.json"), JSON.stringify(recipe("beef-pie--v1")));
    expect(await importCatalog(c, root)).toEqual({ recipes: 2, archived: 1, videos: 1 });
    expect(await importCatalog(c, root)).toEqual({ recipes: 2, archived: 1, videos: 0 });
    expect(await c.recipes.countDocuments({ archived: false })).toBe(2);
    expect(await c.recipes.countDocuments({ archived: true })).toBe(1);
    expect(await c.videos.findOne({ _id: "v1" })).toMatchObject({ title: "Видео", status: "done", recipes: 2 });
  });

  it("stores each vocab file as one document", async () => {
    await syncVocab(c, path.resolve("vocab"));
    const cuisines = await c.vocab.findOne({ _id: "cuisines" });
    expect(cuisines?.items.find((i) => i.id === "russian")).toEqual({ id: "russian", nameRu: "Русская", nameEn: "Russian" });
  });
});

describe("worker", () => {
  async function queue(url: string, createdAt: string): Promise<ObjectId> {
    const _id = new ObjectId();
    await c.jobs.insertOne({ _id, url, status: "queued", createdAt, startedAt: null, finishedAt: null, progress: [], recipes: [], error: null, costUsd: null } as JobDoc);
    return _id;
  }

  it("claims the oldest queued job and never the same one twice", async () => {
    await queue("second", "2026-10-08T10:00:02Z");
    await queue("first", "2026-10-08T10:00:01Z");
    const now = () => "2026-10-08T11:00:00Z";
    expect((await claimNextJob(c, now))?.url).toBe("first");
    expect((await claimNextJob(c, now))?.url).toBe("second");
    expect(await claimNextJob(c, now)).toBeNull();
  });

  it("records progress, the written recipes, the cost and the video, then marks the job done", async () => {
    await queue("https://youtu.be/v1", "2026-10-08T10:00:00Z");
    const job = (await claimNextJob(c, () => "t"))!;
    await runJob(job, {
      c,
      now: () => "2026-10-08T10:05:00Z",
      runIngest: async (_url, onEvent) => {
        onEvent({ type: "video:title", videoId: "v1", title: "Пирог" });
        onEvent({ type: "stage:cached", videoId: "v1", stage: "scout" });
        onEvent({ type: "placement", videoId: "v1", recipeId: "beef-pie--v1", action: "written" });
        return report({
          videos: [{ videoId: "v1", title: "Пирог", status: "done", recipes: 1 }],
          written: ["beef-pie--v1"],
          usageRows: [{ agent: "scout", calls: 1, input: 10, output: 5, costUsd: 0.02 }],
        });
      },
    });
    const done = await c.jobs.findOne({ _id: job._id });
    expect(done).toMatchObject({ status: "done", finishedAt: "2026-10-08T10:05:00Z", recipes: ["beef-pie--v1"], error: null, costUsd: 0.02 });
    expect(done?.progress).toEqual(["Video: Пирог", "Saved beef-pie--v1"]);
    expect(await c.videos.findOne({ _id: "v1" })).toMatchObject({ status: "done", recipes: 1 });
  });

  it("marks the job failed when the pipeline throws or every video errors", async () => {
    await queue("bad", "2026-10-08T10:00:00Z");
    const thrown = (await claimNextJob(c, () => "t"))!;
    await runJob(thrown, { c, runIngest: async () => { throw new Error("yt-dlp not found"); } });
    expect(await c.jobs.findOne({ _id: thrown._id })).toMatchObject({ status: "error", error: "yt-dlp not found" });

    await queue("blocked", "2026-10-08T10:00:01Z");
    const blocked = (await claimNextJob(c, () => "t"))!;
    await runJob(blocked, { c, runIngest: async () => report({ videos: [{ videoId: "v2", title: "v2", status: "error", recipes: 0, error: "Sign in to confirm you're not a bot" }] }) });
    expect(await c.jobs.findOne({ _id: blocked._id })).toMatchObject({ status: "error", error: "Sign in to confirm you're not a bot" });
  });

  it("puts jobs left running by a stopped worker back in the queue", async () => {
    await queue("x", "2026-10-08T10:00:00Z");
    await claimNextJob(c, () => "t");
    expect(await requeueAbandoned(c)).toBe(1);
    expect((await c.jobs.findOne({ url: "x" }))?.status).toBe("queued");
  });

  it("describes only the events worth showing on the site", () => {
    expect(describeEvent({ type: "stage:start", videoId: "v", stage: "extract", segmentIndex: 0, workingName: "Пирог" })).toBe("Writing up: Пирог");
    expect(describeEvent({ type: "stage:start", videoId: "v", stage: "verify", segmentIndex: 0 })).toBeNull();
    expect(describeEvent({ type: "video:done", videoId: "v", status: "done", recipes: 1 })).toBe("Finished: 1 recipe");
    expect(describeEvent({ type: "video:done", videoId: "v", status: "skipped-no-captions", recipes: 0 })).toBe("This video has no Russian captions");
  });
});

describe("recordVideos", () => {
  it("keeps the latest status for a video processed twice", async () => {
    await recordVideos(c, report({ videos: [{ videoId: "v", title: "t", status: "error", recipes: 0, error: "boom" }] }));
    await recordVideos(c, report({ videos: [{ videoId: "v", title: "t", status: "done", recipes: 3 }] }));
    expect(await c.videos.findOne({ _id: "v" })).toMatchObject({ status: "done", recipes: 3, error: null });
  });
});
