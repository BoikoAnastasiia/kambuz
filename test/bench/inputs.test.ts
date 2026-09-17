import { describe, it, expect } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadBenchInputs } from "../../src/bench/inputs.js";
import { makeCache, lasagnaDraft, soupSegment } from "./fixtures.js";

describe("loadBenchInputs", () => {
  it("pairs every cached segment with its draft and names what it skipped", async () => {
    const root = await makeCache();
    try {
      const { segments, skipped } = await loadBenchInputs(root);
      expect(segments.map((s) => `${s.videoId}#${s.segmentIndex}`)).toEqual(["v1#0", "v1#1"]);
      expect(segments[0].draft).toEqual(lasagnaDraft);
      expect(segments[1].segment).toEqual(soupSegment);
      expect(segments.map((x) => x.category)).toEqual(["pasta", null]);
      expect(skipped).toEqual(["v2#0: no extract-0.json", "v3: no scout.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns nothing (and says so) for a missing cache directory", async () => {
    const { segments, skipped } = await loadBenchInputs(path.join(os.tmpdir(), "kambuz-no-such-cache-xyz"));
    expect(segments).toEqual([]);
    expect(skipped[0]).toMatch(/no cache directory/);
  });
});
