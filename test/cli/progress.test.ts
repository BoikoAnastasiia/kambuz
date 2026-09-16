import { describe, it, expect, afterEach } from "vitest";
import { createProgressRenderer, stageLine, summaryLine, attributeTokens } from "../../src/cli/progress.js";
import { UsageLedger } from "../../src/llm/usage.js";
import type { IngestEvent } from "../../src/orchestrator/events.js";
import type { StageProgress, VideoProgress } from "../../src/cli/progress-state.js";

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
      { type: "placement", videoId: "v1", recipeId: "meatballs-with-cheese--v1", action: "too-thin" } as const,
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

  it("wires persistentOutput on each task so a finished video's stage breakdown and summary stay on screen (fix round 1, #1)", () => {
    // rendererTaskOptions.persistentOutput is what listr2's DefaultRenderer checks (alongside
    // isPending()) before drawing task.output at all; without it, output disappears the
    // instant the task completes. There's no way to assert the actual terminal frame from
    // here, so this checks the task was configured with the option listr2 requires.
    let list: any;
    const renderer = createProgressRenderer(new UsageLedger(), { renderer: "silent", onListCreated: (l) => { list = l; } });
    renderer.onEvent({ type: "videos", videoIds: ["v1"] });
    expect(list.tasks[0].rendererTaskOptions.persistentOutput).toBe(true);
  });

  it("shows an exact token count for a solo call but an uncertain marker for two overlapping same-agent calls (fix round 1, #3)", async () => {
    const ledger = new UsageLedger();
    let list: any;
    const renderer = createProgressRenderer(ledger, { renderer: "silent", onListCreated: (l) => { list = l; } });

    renderer.onEvent({ type: "videos", videoIds: ["v1"] });
    renderer.onEvent({ type: "video:start", videoId: "v1" });

    // Two segments' extract calls run concurrently, the default under the shared pLimit for
    // a multi-segment video — the exact scenario the ledger's per-agent "last usage" can't
    // tell apart on its own.
    renderer.onEvent({ type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0, workingName: "лазанья" });
    renderer.onEvent({ type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 1, workingName: "суп" });

    // Segment 0's call resolves first, while segment 1's is still in flight.
    ledger.add("extractor", "claude-sonnet-5", { input_tokens: 100, output_tokens: 20 });
    renderer.onEvent({ type: "stage:done", videoId: "v1", stage: "extract", segmentIndex: 0, ms: 500 });

    // Segment 1's call resolves next; by now nothing else for "extractor" is in flight.
    ledger.add("extractor", "claude-sonnet-5", { input_tokens: 80, output_tokens: 0 });
    renderer.onEvent({ type: "stage:done", videoId: "v1", stage: "extract", segmentIndex: 1, ms: 400 });

    // listr2's own scheduler invokes each task's task() (and so registers its TaskHandle)
    // asynchronously; everything above ran before it necessarily had the chance to, so the
    // output up to now sat in the renderer's "pending" buffer. Give it a macrotask turn to
    // catch up — it flushes the latest buffered title/output the moment task() runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = list.tasks[0].output as string;
    expect(output).toContain("extract [лазанья]: 0.5s · — tok");
    expect(output).toContain("extract [суп]: 0.4s · 80 tok");
  });

  it("releases inFlight on stage:error, so a solo call for the same agent right after a failed one still gets its real token count (fix round 2, #3)", async () => {
    // Reviewer's repro: stage:start -> (the call throws) -> segment:error for v1's
    // extractor, with no stage:done ever firing for it, followed by a solo extractor
    // call for v2. Before this fix inFlight for "extractor" stayed stuck at 1 forever
    // (only stage:done decremented it), so v2's own solo call also read as "overlapping"
    // and showed "— tok" instead of its real count.
    const ledger = new UsageLedger();
    let list: any;
    const renderer = createProgressRenderer(ledger, { renderer: "silent", onListCreated: (l) => { list = l; } });

    renderer.onEvent({ type: "videos", videoIds: ["v1", "v2"] });
    renderer.onEvent({ type: "video:start", videoId: "v1" });
    renderer.onEvent({ type: "stage:start", videoId: "v1", stage: "extract", segmentIndex: 0, workingName: "лазанья" });
    renderer.onEvent({ type: "stage:error", videoId: "v1", stage: "extract", segmentIndex: 0, error: "extractor blew up on this segment" });
    renderer.onEvent({ type: "segment:error", videoId: "v1", segmentIndex: 0, error: "extractor blew up on this segment" });
    renderer.onEvent({ type: "video:done", videoId: "v1", status: "error", recipes: 0 });

    renderer.onEvent({ type: "video:start", videoId: "v2" });
    renderer.onEvent({ type: "stage:start", videoId: "v2", stage: "extract", segmentIndex: 0, workingName: "суп" });
    ledger.add("extractor", "claude-sonnet-5", { input_tokens: 50, output_tokens: 5 });
    renderer.onEvent({ type: "stage:done", videoId: "v2", stage: "extract", segmentIndex: 0, ms: 300 });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const v2Output = list.tasks[1].output as string;
    expect(v2Output).toContain("extract [суп]: 0.3s · 55 tok");
    expect(v2Output).not.toContain("— tok");
  });
});

describe("stageLine", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it("includes workingName so two concurrent segments of one video are distinguishable (fix round 1, #4)", () => {
    const running: StageProgress = { state: "running", workingName: "лазанья" };
    expect(stageLine("extract-0", running)).toBe("extract [лазанья]…");
    const done: StageProgress = { state: "done", ms: 1000, workingName: "суп" };
    expect(stageLine("extract-1", done)).toBe("extract [суп]: 1.0s");
  });

  it("omits the brackets when a stage has no workingName (scout, source)", () => {
    expect(stageLine("scout", { state: "running" })).toBe("scout…");
  });

  it("wraps an error message in red ANSI codes on a TTY, and leaves it plain otherwise (fix round 1, #2)", () => {
    const info: StageProgress = { state: "error", error: "boom" };
    process.stdout.isTTY = false;
    expect(stageLine("extract-0", info)).toBe("extract: boom");
    process.stdout.isTTY = true;
    expect(stageLine("extract-0", info)).toBe("extract: [31mboom[39m");
  });

  it("shows an em dash instead of a token count when attribution was uncertain (fix round 1, #3)", () => {
    const info: StageProgress = { state: "done", ms: 500, tokensUncertain: true };
    expect(stageLine("scout", info)).toBe("scout: 0.5s · — tok");
  });

  it("still shows an exact token count when attribution succeeded", () => {
    const info: StageProgress = { state: "done", ms: 500, tokens: 1500 };
    expect(stageLine("scout", info)).toBe("scout: 0.5s · 1.5k tok");
  });
});

describe("summaryLine", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it("colors the error summary red on a TTY, and leaves it plain otherwise (fix round 1, #2)", () => {
    const video: VideoProgress = { title: "v1", status: "error", stages: new Map() };
    process.stdout.isTTY = false;
    expect(summaryLine(video)).toBe("error");
    process.stdout.isTTY = true;
    expect(summaryLine(video)).toBe("[31merror[39m");
  });
});

describe("attributeTokens", () => {
  it("attributes tokens when exactly one call for the agent was in flight", () => {
    expect(attributeTokens(1, { input_tokens: 100, output_tokens: 20 })).toEqual({ tokens: 120, uncertain: false });
  });

  it("marks attribution uncertain, with no tokens, when more than one call for the agent overlapped (fix round 1, #3)", () => {
    expect(attributeTokens(2, { input_tokens: 100, output_tokens: 20 })).toEqual({ uncertain: true });
    expect(attributeTokens(3, { input_tokens: 100, output_tokens: 20 })).toEqual({ uncertain: true });
  });

  it("is not 'uncertain' when there's simply no usage to attribute", () => {
    expect(attributeTokens(1, undefined)).toEqual({ uncertain: false });
  });
});
