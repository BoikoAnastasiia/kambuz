import { describe, it, expect } from "vitest";
import { config, buildConfig, AGENT_NAMES } from "../src/config.js";

describe("config", () => {
  it("has a model for every agent, defaulting to claude-sonnet-5", () => {
    for (const name of AGENT_NAMES) {
      expect(config.models[name]).toBe("claude-sonnet-5");
    }
  });
  it("falls back to concurrency 4 for an empty, non-numeric or out-of-range KAMBUZ_CONCURRENCY", () => {
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "" }).concurrency).toBe(4);
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "lots" }).concurrency).toBe(4);
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "0" }).concurrency).toBe(4);
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "-3" }).concurrency).toBe(4);
    expect(buildConfig({}).concurrency).toBe(4);
  });

  it("uses a valid KAMBUZ_CONCURRENCY as a whole number", () => {
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "8" }).concurrency).toBe(8);
    expect(buildConfig({ KAMBUZ_CONCURRENCY: "2.7" }).concurrency).toBe(2);
  });

  it("falls back to minCompleteness 0.3 for an empty, non-numeric or out-of-range KAMBUZ_MIN_COMPLETENESS", () => {
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "" }).minCompleteness).toBe(0.3);
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "lots" }).minCompleteness).toBe(0.3);
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "-0.1" }).minCompleteness).toBe(0.3);
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "1.1" }).minCompleteness).toBe(0.3);
    expect(buildConfig({}).minCompleteness).toBe(0.3);
  });

  it("uses a valid KAMBUZ_MIN_COMPLETENESS in [0, 1]", () => {
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "0.5" }).minCompleteness).toBe(0.5);
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "0" }).minCompleteness).toBe(0);
    expect(buildConfig({ KAMBUZ_MIN_COMPLETENESS: "1" }).minCompleteness).toBe(1);
  });

  it("lets KAMBUZ_MODEL_SCOUT override one agent", async () => {
    process.env.KAMBUZ_MODEL_SCOUT = "claude-opus-5";
    const { buildConfig } = await import("../src/config.js");
    expect(buildConfig().models.scout).toBe("claude-opus-5");
    delete process.env.KAMBUZ_MODEL_SCOUT;
  });
});

describe("config effort", () => {
  it("is empty by default", () => {
    expect(buildConfig({}).effort).toEqual({});
  });
  it("reads KAMBUZ_EFFORT_<AGENT> for valid levels and ignores invalid ones", () => {
    const c = buildConfig({ KAMBUZ_EFFORT_VERIFIER: "low", KAMBUZ_EFFORT_JUDGE: "HIGH ", KAMBUZ_EFFORT_SCOUT: "turbo", KAMBUZ_EFFORT_EXTRACTOR: "" });
    expect(c.effort).toEqual({ verifier: "low", judge: "high" });
  });
});
