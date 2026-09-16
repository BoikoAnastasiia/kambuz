import type { IngestEvent } from "../orchestrator/events.js";
import type { VideoStatus } from "../orchestrator/report.js";

export type StageRunState = "running" | "cached" | "done" | "error";

export interface StageProgress {
  state: StageRunState;
  ms?: number;
  tokens?: number;
  workingName?: string;
  error?: string;
}

export interface VideoProgress {
  title: string;
  status?: VideoStatus;
  recipes?: number;
  stages: Map<string, StageProgress>;
}

export interface ProgressState {
  videos: Map<string, VideoProgress>;
  // Insertion order of videoIds, since Map iteration order already follows
  // insertion but callers shouldn't have to rely on that implicit guarantee.
  order: string[];
}

export function createProgressState(): ProgressState {
  return { videos: new Map(), order: [] };
}

/** The map key a stage's events share: "scout", "extract-0", "extract-1", ... */
export function stageKey(stage: string, segmentIndex?: number): string {
  return segmentIndex === undefined ? stage : `${stage}-${segmentIndex}`;
}

function ensureVideo(state: ProgressState, videoId: string): VideoProgress {
  let video = state.videos.get(videoId);
  if (!video) {
    video = { title: videoId, stages: new Map() };
    state.videos.set(videoId, video);
    state.order.push(videoId);
  }
  return video;
}

/**
 * Folds one IngestEvent into the progress state. Mutates and returns the same
 * state object (there is no benefit to structural sharing here — the caller
 * owns a single long-lived state per run) so callers can either use the
 * return value or just keep the object they passed in.
 */
export function reduceProgress(state: ProgressState, event: IngestEvent): ProgressState {
  switch (event.type) {
    case "videos": {
      for (const videoId of event.videoIds) ensureVideo(state, videoId);
      return state;
    }
    case "video:start": {
      ensureVideo(state, event.videoId);
      return state;
    }
    case "video:title": {
      ensureVideo(state, event.videoId).title = event.title;
      return state;
    }
    case "stage:start": {
      const video = ensureVideo(state, event.videoId);
      video.stages.set(stageKey(event.stage, event.segmentIndex), { state: "running", workingName: event.workingName });
      return state;
    }
    case "stage:cached": {
      const video = ensureVideo(state, event.videoId);
      video.stages.set(stageKey(event.stage, event.segmentIndex), { state: "cached" });
      return state;
    }
    case "stage:done": {
      const video = ensureVideo(state, event.videoId);
      const key = stageKey(event.stage, event.segmentIndex);
      const previous = video.stages.get(key);
      video.stages.set(key, { ...previous, state: "done", ms: event.ms });
      return state;
    }
    case "segment:error": {
      // The event doesn't say which named stage was in flight when the segment
      // failed, so mark whichever of this segment's stages was still running.
      const video = ensureVideo(state, event.videoId);
      for (const [key, info] of video.stages) {
        if (info.state === "running" && key.endsWith(`-${event.segmentIndex}`)) {
          video.stages.set(key, { ...info, state: "error", error: event.error });
        }
      }
      return state;
    }
    case "video:done": {
      const video = ensureVideo(state, event.videoId);
      video.status = event.status;
      video.recipes = event.recipes;
      return state;
    }
    // "placement" doesn't change the per-stage/per-video shape this state models;
    // a renderer that wants per-recipe placement detail reads the event directly.
    case "placement":
    default:
      return state;
  }
}
