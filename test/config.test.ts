import { describe, it, expect } from "vitest";
import { config, AGENT_NAMES } from "../src/config.js";

describe("config", () => {
  it("has a model for every agent, defaulting to claude-sonnet-5", () => {
    for (const name of AGENT_NAMES) {
      expect(config.models[name]).toBe("claude-sonnet-5");
    }
  });
  it("lets KAMBUZ_MODEL_SCOUT override one agent", async () => {
    process.env.KAMBUZ_MODEL_SCOUT = "claude-opus-5";
    const { buildConfig } = await import("../src/config.js");
    expect(buildConfig().models.scout).toBe("claude-opus-5");
    delete process.env.KAMBUZ_MODEL_SCOUT;
  });
});
