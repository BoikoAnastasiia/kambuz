import { describe, it, expect, vi } from "vitest";
import { runScout, buildScoutUser } from "../../src/agents/scout.js";
import type { VideoSource } from "../../src/schemas/source.js";
import { config } from "../../src/config.js";

const source: VideoSource = {
  videoId: "v1", url: "u", title: "Судовой рецепт | Лазанья", tags: ["лазанья"], channel: "C", channelId: "UC", durationSec: 120, uploadDate: null, language: "ru",
  cues: [
    { start: 0, end: 5, text: "Всем привет сегодня лазанья" },
    { start: 30, end: 35, text: "нарежем кубиком лук" },
    { start: 100, end: 105, text: "приятного аппетита" },
  ],
};

describe("buildScoutUser", () => {
  it("includes title, tags and timestamped transcript", () => {
    const u = buildScoutUser(source);
    expect(u).toContain("Судовой рецепт | Лазанья");
    expect(u).toContain("лазанья");
    expect(u).toContain("[00:30] нарежем кубиком лук");
  });
});

describe("runScout", () => {
  it("fills rawText from the cue slice and clamps end", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({
      isRecipeVideo: true,
      segments: [{ workingName: "лазанья", start: 25, end: 999, cleanText: "Нарежем кубиком лук." }],
    })) };
    const r = await runScout(source, llm as any, config.paths.prompts);
    expect(r.segments[0].rawText).toBe("нарежем кубиком лук\nприятного аппетита");
    expect(r.segments[0].end).toBe(120);
    expect(llm.callStructured.mock.calls[0][0].agent).toBe("scout");
  });

  it("does not ask the model for rawText — the orchestrator has the cues already", async () => {
    const llm = { callStructured: vi.fn(async (_opts: any) => ({ isRecipeVideo: false, segments: [] })) };
    await runScout(source, llm as any, config.paths.prompts);
    const schema = llm.callStructured.mock.calls[0][0].schema;
    const withoutRawText = { isRecipeVideo: true, segments: [{ workingName: "x", start: 0, end: 60, cleanText: "y" }] };
    expect(schema.safeParse(withoutRawText).success).toBe(true);
    expect(Object.keys(schema.parse(withoutRawText).segments[0])).not.toContain("rawText");
  });
  it("drops segments shorter than 20 seconds", async () => {
    const llm = { callStructured: vi.fn(async () => ({
      isRecipeVideo: true,
      segments: [{ workingName: "x", start: 30, end: 40, cleanText: "" }],
    })) };
    const r = await runScout(source, llm as any, config.paths.prompts);
    expect(r.segments).toHaveLength(0);
  });
  it("empties segments when the model itself says isRecipeVideo is false", async () => {
    const llm = { callStructured: vi.fn(async () => ({
      isRecipeVideo: false,
      segments: [{ workingName: "лазанья", start: 20, end: 80, cleanText: "Нарежем кубиком лук." }],
    })) };
    const r = await runScout(source, llm as any, config.paths.prompts);
    expect(r.isRecipeVideo).toBe(false);
    expect(r.segments).toHaveLength(0);
  });
});
