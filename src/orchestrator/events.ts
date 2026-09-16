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
 *
 * A cache hit emits stage:cached and nothing else for that stage; a cache
 * miss emits stage:start followed by exactly one of stage:done (the run
 * succeeded) or stage:error (it threw — see stage() in run.ts, which
 * rethrows after emitting so the failure still propagates normally). A
 * consumer that tracks per-agent in-flight calls (e.g. to gate token
 * attribution when two calls for the same agent overlap) must decrement on
 * stage:error too, not just stage:done, or a failed call leaves the count
 * stuck.
 */
export type IngestEvent =
  | { type: "videos"; videoIds: string[] }
  | { type: "video:start"; videoId: string }
  | { type: "video:title"; videoId: string; title: string }
  | { type: "stage:start"; videoId: string; stage: StageName; segmentIndex?: number; workingName?: string }
  | { type: "stage:cached"; videoId: string; stage: StageName; segmentIndex?: number }
  | { type: "stage:done"; videoId: string; stage: StageName; segmentIndex?: number; ms: number }
  | { type: "stage:error"; videoId: string; stage: StageName; segmentIndex?: number; error: string }
  | { type: "segment:error"; videoId: string; segmentIndex: number; error: string }
  | { type: "placement"; videoId: string; recipeId: string; action: PlacementAction }
  | { type: "video:done"; videoId: string; status: VideoStatus; recipes: number };
