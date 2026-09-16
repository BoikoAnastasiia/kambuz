import { describe, it, expect } from "vitest";
import { createProgressRenderer } from "../../src/cli/progress.js";
import { UsageLedger } from "../../src/llm/usage.js";
import type { IngestEvent } from "../../src/orchestrator/events.js";

// Smoke test only, per the brief — this constructs the renderer against listr2's
// "silent" renderer (so it doesn't try to draw ANSI frames under vitest) and
// feeds it a realistic event sequence, checking only that nothing throws and
// that the run resolves. The event ordering and state derivation themselves
// are covered by test/orchestrator/run.test.ts and test/cli/progress-state.test.ts.
describe("createProgressRenderer", () => {
  it("consumes a full event sequence (including tokens from the ledger and an error video) without throwing, and finish() resolves", async () => {
    const ledger = new UsageLedger();
    const renderer = createProgressRenderer(ledger, { renderer: "silent" });

    const events: IngestEvent[] = [
      { type: "videos", videoIds: ["v1", "v2"] },
      { type: "video:start", videoId: "v1" },
      { type: "video:start", videoId: "v2" },
      { type: "stage:start", videoId: "v1", stage: "source" },
      { type: "stage:done", videoId: "v1", stage: "source", ms: 300 },
      { type: "video:title", videoId: "v1", title: "Лазанья" },
      { type: "stage:cached", videoId: "v2", stage: "source" },
      { type: "video:title", videoId: "v2", title: "Суп" },
      { type: "stage:start", videoId: "v1", stage: "scout" },
    ];
    for (const e of events) renderer.onEvent(e);

    // A token usage report lands between stage:start and stage:done for scout, the
    // way it does in the real pipeline (runScout awaits callStructured, which calls
    // ledger.add, before stage() emits stage:done).
    ledger.add("scout", "claude-sonnet-5", { input_tokens: 1200, output_tokens: 300 });

    for (const e of [
      { type: "stage:done", videoId: "v1", stage: "scout", ms: 900 } as const,
      { type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0, workingName: "лазанья" } as const,
      { type: "segment:error", videoId: "v1", segmentIndex: 0, error: "extractor blew up" } as const,
      { type: "placement", videoId: "v2", recipeId: "soup--v2", action: "written" } as const,
      { type: "video:done", videoId: "v1", status: "error", recipes: 0 } as const,
      { type: "video:done", videoId: "v2", status: "done", recipes: 1 } as const,
    ]) {
      expect(() => renderer.onEvent(e)).not.toThrow();
    }

    await expect(renderer.finish()).resolves.toBeUndefined();
  });

  it("tolerates being finished with no videos event at all (e.g. url expansion failed before the run started)", async () => {
    const renderer = createProgressRenderer(new UsageLedger(), { renderer: "silent" });
    await expect(renderer.finish()).resolves.toBeUndefined();
  });
});
