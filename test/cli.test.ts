import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("parses a bare ingest command", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz"]);
    expect(result).toEqual({ ok: true, url: "https://youtu.be/xyz", force: false, onlyStage: undefined });
  });

  it("parses --force and --only-stage", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "--force", "--only-stage", "extract"]);
    expect(result).toEqual({ ok: true, url: "https://youtu.be/xyz", force: true, onlyStage: "extract" });
  });

  it("rejects no arguments", () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown command", () => {
    const result = parseCliArgs(["bogus", "https://youtu.be/xyz"]);
    expect(result.ok).toBe(false);
  });

  it("rejects ingest with no url", () => {
    const result = parseCliArgs(["ingest"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "--bogus"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid --only-stage value", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "--only-stage", "fetch"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only-stage/);
  });

  it("rejects extra positional arguments", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "extra"]);
    expect(result.ok).toBe(false);
  });
});
