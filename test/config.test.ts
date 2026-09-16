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

  it("lets KAMBUZ_MODEL_SCOUT override one agent", async () => {
    process.env.KAMBUZ_MODEL_SCOUT = "claude-opus-5";
    const { buildConfig } = await import("../src/config.js");
    expect(buildConfig().models.scout).toBe("claude-opus-5");
    delete process.env.KAMBUZ_MODEL_SCOUT;
  });
});
