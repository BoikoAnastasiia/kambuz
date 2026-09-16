import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("treats an unparsable or off-schema stage file as a miss, with a warning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const c = new StageCache(root);
      const schema = z.object({ a: z.number() });

      await c.set("v1", "scout", { a: 1 });
      await writeFile(path.join(root, "v1", "scout.json"), "{ half-written garbage");
      expect(await c.get("v1", "scout", schema)).toBeNull();

      // a file that parses as JSON but no longer fits the schema is a miss too
      await writeFile(path.join(root, "v1", "scout.json"), JSON.stringify({ a: "not a number" }));
      expect(await c.get("v1", "scout", schema)).toBeNull();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toMatch(/scout/);
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
