import { describe, it, expect } from "vitest";
import { createProgressState, reduceProgress } from "../../src/cli/progress-state.js";
import type { IngestEvent } from "../../src/orchestrator/events.js";

function apply(events: IngestEvent[]) {
  let state = createProgressState();
  for (const e of events) state = reduceProgress(state, e);
  return state;
}

describe("reduceProgress", () => {
  it("registers every video from the videos event, in order, keyed by videoId", () => {
    const state = apply([{ type: "videos", videoIds: ["v1", "v2"] }]);
    expect(state.order).toEqual(["v1", "v2"]);
    expect(state.videos.get("v1")).toEqual({ title: "v1", stages: new Map() });
    expect(state.videos.get("v2")).toEqual({ title: "v2", stages: new Map() });
  });

  it("adopts the video's title once known, keeping videoId as the fallback until then", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "video:start", videoId: "v1" },
      { type: "video:title", videoId: "v1", title: "Лазанья" },
    ]);
    expect(state.videos.get("v1")?.title).toBe("Лазанья");
  });

  it("tracks a stage through running -> done with its elapsed time", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "stage:start", videoId: "v1", stage: "scout" },
      { type: "stage:done", videoId: "v1", stage: "scout", ms: 1234 },
    ]);
    expect(state.videos.get("v1")?.stages.get("scout")).toEqual({ state: "done", ms: 1234 });
  });

  it("records a per-segment stage as cached without ever touching 'running'", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "stage:cached", videoId: "v1", stage: "extract", segmentIndex: 0 },
    ]);
    expect(state.videos.get("v1")?.stages.get("extract-0")).toEqual({ state: "cached" });
  });

  it("keeps segment-0 and segment-1 stages of the same name as separate entries", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0, workingName: "лазанья" },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 1, workingName: "суп" },
      { type: "stage:done", videoId: "v1", stage: "extract", segmentIndex: 0, ms: 500 },
    ]);
    expect(state.videos.get("v1")?.stages.get("extract-0")).toEqual({ state: "done", ms: 500, workingName: "лазанья" });
    expect(state.videos.get("v1")?.stages.get("extract-1")).toEqual({ state: "running", workingName: "суп" });
  });

  it("marks the segment's still-running stage as an error, leaving other segments untouched", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0 },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 1 },
      { type: "segment:error", videoId: "v1", segmentIndex: 1, error: "extractor blew up" },
    ]);
    expect(state.videos.get("v1")?.stages.get("extract-1")).toEqual({ state: "error", error: "extractor blew up" });
    expect(state.videos.get("v1")?.stages.get("extract-0")).toEqual({ state: "running" });
  });

  it("does not overwrite an already-finished stage when a later segment error names the same key by coincidence", () => {
    // stage() never emits stage:done then a later error for the same key, but the
    // reducer's own rule (only touch a stage that is still "running") should hold
    // regardless of what produced the sequence.
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0 },
      { type: "stage:done", videoId: "v1", stage: "extract", segmentIndex: 0, ms: 10 },
      { type: "segment:error", videoId: "v1", segmentIndex: 0, error: "too late" },
    ]);
    expect(state.videos.get("v1")?.stages.get("extract-0")).toEqual({ state: "done", ms: 10 });
  });

  it("records the final status and recipe count on video:done", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "video:done", videoId: "v1", status: "done", recipes: 3 },
    ]);
    expect(state.videos.get("v1")).toMatchObject({ status: "done", recipes: 3 });
  });

  it("ignores a placement event: it doesn't change the video/stage shape this state models", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "placement", videoId: "v1", recipeId: "lasagna--v1", action: "written" },
    ]);
    expect(state.videos.get("v1")).toEqual({ title: "v1", stages: new Map() });
  });

  it("folds a full one-video, one-segment run into the expected final shape", () => {
    const state = apply([
      { type: "videos", videoIds: ["v1"] },
      { type: "video:start", videoId: "v1" },
      { type: "stage:start", videoId: "v1", stage: "source" },
      { type: "stage:done", videoId: "v1", stage: "source", ms: 800 },
      { type: "video:title", videoId: "v1", title: "Лазанья" },
      { type: "stage:start", videoId: "v1", stage: "scout" },
      { type: "stage:done", videoId: "v1", stage: "scout", ms: 900 },
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0, workingName: "лазанья" },
      { type: "stage:done", videoId: "v1", stage: "extract", segmentIndex: 0, ms: 1000 },
      { type: "stage:start", videoId: "v1", stage: "verify", segmentIndex: 0 },
      { type: "stage:done", videoId: "v1", stage: "verify", segmentIndex: 0, ms: 400 },
      { type: "stage:start", videoId: "v1", stage: "categorize", segmentIndex: 0 },
      { type: "stage:done", videoId: "v1", stage: "categorize", segmentIndex: 0, ms: 300 },
      { type: "placement", videoId: "v1", recipeId: "lasagna--v1", action: "written" },
      { type: "video:done", videoId: "v1", status: "done", recipes: 1 },
    ]);

    const video = state.videos.get("v1");
    expect(video?.title).toBe("Лазанья");
    expect(video?.status).toBe("done");
    expect(video?.recipes).toBe(1);
    expect([...video!.stages.entries()]).toEqual([
      ["source", { state: "done", ms: 800 }],
      ["scout", { state: "done", ms: 900 }],
      ["extract-0", { state: "done", ms: 1000, workingName: "лазанья" }],
      ["verify-0", { state: "done", ms: 400 }],
      ["categorize-0", { state: "done", ms: 300 }],
    ]);
  });
});
