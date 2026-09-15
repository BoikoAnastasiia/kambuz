import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { StageCache } from "../../src/orchestrator/cache.js";

describe("StageCache", () => {
  it("round-trips a stage value and reports presence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-"));
    try {
      const c = new StageCache(root);
      expect(await c.has("v1", "scout")).toBe(false);
      expect(await c.get("v1", "scout", z.object({ a: z.number() }))).toBeNull();
      await c.set("v1", "scout", { a: 1 });
      expect(await c.has("v1", "scout")).toBe(true);
      expect(await c.get("v1", "scout", z.object({ a: z.number() }))).toEqual({ a: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
