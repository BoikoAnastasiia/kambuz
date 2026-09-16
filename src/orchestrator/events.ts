import type { VideoStatus } from "./report.js";

// The stage names an event can report on. "source" is the yt-dlp/caption
// fetch; the rest are the LLM agent stages from STAGE_ORDER in run.ts.
export type StageName = "source" | "scout" | "extract" | "verify" | "categorize";

export type PlacementAction = "written" | "replaced" | "kept-existing" | "kept-both" | "invalid";

/**
 * Progress events emitted by ingest() as a run proceeds. Consumers (the CLI's
 * progress renderer, tests) subscribe via IngestDeps.onEvent; the orchestrator
 * itself never reads them back, so this file has no behavioural weight of its
 * own — it only shapes what run.ts reports and what the renderer draws.
 */
export type IngestEvent =
  | { type: "videos"; videoIds: string[] }
  | { type: "video:start"; videoId: string }
  | { type: "video:title"; videoId: string; title: string }
  | { type: "stage:start"; videoId: string; stage: StageName; segmentIndex?: number; workingName?: string }
  | { type: "stage:cached"; videoId: string; stage: StageName; segmentIndex?: number }
  | { type: "stage:done"; videoId: string; stage: StageName; segmentIndex?: number; ms: number }
  | { type: "segment:error"; videoId: string; segmentIndex: number; error: string }
  | { type: "placement"; videoId: string; recipeId: string; action: PlacementAction }
  | { type: "video:done"; videoId: string; status: VideoStatus; recipes: number };
