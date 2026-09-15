import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { ScoutResultSchema, type ScoutResult } from "../schemas/scout.js";
import type { VideoSource } from "../schemas/source.js";
import { renderTranscript, sliceCues } from "../fetcher/vtt.js";

export const MIN_SEGMENT_SECONDS = 20;

export function buildScoutUser(source: VideoSource): string {
  return [
    `Title: ${source.title}`,
    `Tags: ${source.tags.join(", ") || "(none)"}`,
    `Duration: ${source.durationSec} seconds`,
    "",
    "Transcript:",
    renderTranscript(source.cues),
  ].join("\n");
}

export async function runScout(source: VideoSource, llm: LlmClient, promptsDir: string): Promise<ScoutResult> {
  const system = await loadPrompt("scout", promptsDir);
  const raw = await llm.callStructured({ agent: "scout", system, user: buildScoutUser(source), schema: ScoutResultSchema, maxTokens: 32000 });
  const segments = raw.isRecipeVideo
    ? raw.segments
        .map((s) => {
          const start = Math.max(0, s.start);
          const end = Math.min(source.durationSec, s.end);
          return { ...s, start, end, rawText: sliceCues(source.cues, start, end).map((c) => c.text).join("\n") };
        })
        .filter((s) => s.end - s.start >= MIN_SEGMENT_SECONDS)
    : [];
  return { isRecipeVideo: raw.isRecipeVideo && segments.length > 0, segments };
}
