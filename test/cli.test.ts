import { describe, it, expect } from "vitest";
import { parseCliArgs, apiKeyError } from "../src/cli.js";

describe("apiKeyError", () => {
  it("explains how to set a missing key instead of letting the SDK throw", () => {
    // literal envs only — the test never reads the real ANTHROPIC_API_KEY
    expect(apiKeyError({})).toMatch(/ANTHROPIC_API_KEY is not set.*\.env\.example/s);
    expect(apiKeyError({ ANTHROPIC_API_KEY: "  " })).not.toBeNull();
  });

  it("returns null when a key is present", () => {
    expect(apiKeyError({ ANTHROPIC_API_KEY: "sk-test" })).toBeNull();
  });
});

describe("parseCliArgs", () => {
  it("parses a bare ingest command", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz"]);
    expect(result).toEqual({ ok: true, command: "ingest", url: "https://youtu.be/xyz", force: false, onlyStage: undefined, quiet: false });
  });

  it("parses --force and --only-stage", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "--force", "--only-stage", "extract"]);
    expect(result).toEqual({ ok: true, command: "ingest", url: "https://youtu.be/xyz", force: true, onlyStage: "extract", quiet: false });
  });

  it("parses --quiet", () => {
    const result = parseCliArgs(["ingest", "https://youtu.be/xyz", "--quiet"]);
    expect(result).toEqual({ ok: true, command: "ingest", url: "https://youtu.be/xyz", force: false, onlyStage: undefined, quiet: true });
  });

  it("parses a bare eval command (no ingestion by default)", () => {
    const result = parseCliArgs(["eval"]);
    expect(result).toEqual({ ok: true, command: "eval", force: false, ingest: false, onlyStage: undefined });
  });

  it("parses eval --force --ingest", () => {
    const result = parseCliArgs(["eval", "--force", "--ingest"]);
    expect(result).toEqual({ ok: true, command: "eval", force: true, ingest: true, onlyStage: undefined });
  });

  it("ignores a bare -- separator, which npm forwards on `npm run eval -- --ingest`", () => {
    // Without this the flag lands in positionals and the run dies with the usage text.
    expect(parseCliArgs(["eval", "--", "--ingest"])).toEqual({ ok: true, command: "eval", force: false, ingest: true, onlyStage: undefined });
    expect(parseCliArgs(["--", "ingest", "https://youtu.be/xyz"])).toEqual({ ok: true, command: "ingest", url: "https://youtu.be/xyz", force: false, onlyStage: undefined, quiet: false });
  });

  it("rejects eval with an extra positional argument", () => {
    const result = parseCliArgs(["eval", "extra"]);
    expect(result.ok).toBe(false);
  });

  it("rejects eval --only-stage without --ingest", () => {
    const result = parseCliArgs(["eval", "--only-stage", "extract"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--ingest/);
  });

  it("parses eval --ingest --only-stage together", () => {
    const result = parseCliArgs(["eval", "--ingest", "--only-stage", "extract"]);
    expect(result).toEqual({ ok: true, command: "eval", force: false, ingest: true, onlyStage: "extract" });
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
