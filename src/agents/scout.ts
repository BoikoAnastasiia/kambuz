import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { ScoutWireResultSchema, type ScoutResult } from "../schemas/scout.js";
import type { VideoSource } from "../schemas/source.js";
import { formatTimestamp, renderTranscript, sliceCues } from "../fetcher/vtt.js";

export const MIN_SEGMENT_SECONDS = 20;

const TRANSCRIPT_KIND: Record<VideoSource["captionKind"], string> = {
  spoken: "spoken auto-captions",
  author: "subtitles uploaded by the author",
  chapters: "the video's chapter titles (the video has no speech captions)",
  none: "empty — the video has no captions or chapters, only the description",
};

export function buildScoutUser(source: VideoSource): string {
  const lines = [
    `Title: ${source.title}`,
    `Tags: ${source.tags.join(", ") || "(none)"}`,
    `Duration: ${source.durationSec} seconds`,
    `Language: ${source.language}`,
  ];
  if (source.chapters.length && source.captionKind !== "chapters") {
    lines.push("", "Chapters:", ...source.chapters.map((c) => `[${formatTimestamp(c.start)}] ${c.title}`));
  }
  if (source.description.trim()) lines.push("", "Description (written by the author):", source.description.trim());
  lines.push("", `Transcript (${TRANSCRIPT_KIND[source.captionKind]}):`, renderTranscript(source.cues));
  return lines.join("\n");
}

export async function runScout(source: VideoSource, llm: LlmClient, promptsDir: string): Promise<ScoutResult> {
  const system = await loadPrompt("scout", promptsDir);
  const raw = await llm.callStructured({ agent: "scout", system, user: buildScoutUser(source), schema: ScoutWireResultSchema, maxTokens: 32000 });
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
