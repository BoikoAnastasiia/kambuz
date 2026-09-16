import { Listr, type ListrTask } from "listr2";
import type { AgentName } from "../config.js";
import type { UsageLedger } from "../llm/usage.js";
import type { IngestEvent } from "../orchestrator/events.js";
import { createProgressState, reduceProgress, stageKey, type ProgressState } from "./progress-state.js";

const STAGE_AGENT: Partial<Record<string, AgentName>> = {
  scout: "scout",
  extract: "extractor",
  verify: "verifier",
  categorize: "categorizer",
};

const STAGE_LABEL: Record<string, string> = {
  source: "fetch",
  scout: "scout",
  extract: "extract",
  verify: "verify",
  categorize: "categorize",
};

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function stageLine(stage: string, info: { state: string; ms?: number; tokens?: number; error?: string }): string {
  const label = STAGE_LABEL[stage.split("-")[0]] ?? stage;
  if (info.state === "running") return `${label}…`;
  if (info.state === "cached") return `${label}: cached`;
  if (info.state === "error") return `${label}: ${info.error ?? "error"}`;
  const parts = [info.ms !== undefined ? formatSeconds(info.ms) : undefined, info.tokens ? `${formatTokens(info.tokens)} tok` : undefined].filter(Boolean);
  return `${label}: ${parts.join(" · ") || "done"}`;
}

function videoOutput(state: ProgressState, videoId: string): string {
  const video = state.videos.get(videoId);
  if (!video) return "";
  return [...video.stages.entries()].map(([key, info]) => stageLine(key, info)).join("  ·  ");
}

function summaryLine(video: NonNullable<ReturnType<ProgressState["videos"]["get"]>>): string {
  if (video.status === "skipped-no-captions") return "skipped (no captions)";
  if (video.status === "not-recipe") return "not a recipe video";
  if (video.status === "error") return "error";
  const totalMs = [...video.stages.values()].reduce((sum, s) => sum + (s.ms ?? 0), 0);
  const totalTokens = [...video.stages.values()].reduce((sum, s) => sum + (s.tokens ?? 0), 0);
  return `${video.recipes ?? 0} recipe${video.recipes === 1 ? "" : "s"} · ${formatSeconds(totalMs)} · ${formatTokens(totalTokens)} tokens`;
}

interface TaskHandle {
  setTitle(title: string): void;
  setOutput(output: string): void;
}

export interface ProgressRenderer {
  onEvent: (e: IngestEvent) => void;
  finish(): Promise<void>;
}

export interface ProgressRendererOptions {
  /** Force a renderer (used by the smoke test to stay quiet under vitest). Omit to let listr2 auto-detect TTY. */
  renderer?: "default" | "simple" | "silent";
}

/**
 * Wires ingest()'s IngestEvent stream into a listr2 task list, one task per
 * video. The orchestrator drives (it decides what happened and when); this
 * only reflects that into task.title/task.output. Each video's listr task is
 * a deferred promise resolved by the matching video:done event, so listr
 * itself never has to know anything about yt-dlp or the agent pipeline.
 */
export function createProgressRenderer(ledger: UsageLedger, options: ProgressRendererOptions = {}): ProgressRenderer {
  const state = createProgressState();
  // Each video's listr task just awaits this deferred, resolved by that video's
  // video:done event. It is created up front, at the "videos" event, rather than
  // inside the listr task() callback — a fully-cached video can finish (and fire
  // video:done) within the same microtask turn that started the run, before
  // listr's own scheduler has gotten around to invoking task() for it, and a
  // resolve() with nowhere to land would hang that task (and finish()) forever.
  const deferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const handles = new Map<string, TaskHandle>();
  // title/output updates that arrive before listr has invoked this video's
  // task() (and so before a TaskHandle exists) are held here and flushed onto
  // the handle the moment it's registered.
  const pending = new Map<string, { title?: string; output?: string }>();
  // Last usage recorded per agent, consumed (and cleared) by the next stage:done
  // for that agent. IngestEvent carries no videoId for token usage — see
  // UsageLedger.subscribe — so under heavy cross-video concurrency this can
  // misattribute a call's tokens to a same-agent stage in another video. The
  // brief accepts this: "the renderer subscribes to show tokens ... the
  // orchestrator does not know about tokens."
  const lastUsage = new Map<AgentName, { input_tokens: number; output_tokens: number }>();
  const unsubscribeUsage = ledger.subscribe((agent, _model, usage) => lastUsage.set(agent, usage));

  let runPromise: Promise<unknown> = Promise.resolve();

  function setTitle(videoId: string, title: string): void {
    const handle = handles.get(videoId);
    if (handle) handle.setTitle(title);
    else pending.set(videoId, { ...pending.get(videoId), title });
  }

  function setOutput(videoId: string, output: string): void {
    const handle = handles.get(videoId);
    if (handle) handle.setOutput(output);
    else pending.set(videoId, { ...pending.get(videoId), output });
  }

  function refresh(videoId: string): void {
    const video = state.videos.get(videoId);
    if (!video) return;
    setTitle(videoId, video.title === videoId ? videoId : `${videoId} — ${video.title}`);
    setOutput(videoId, videoOutput(state, videoId));
  }

  function onEvent(event: IngestEvent): void {
    reduceProgress(state, event);

    if (event.type === "videos") {
      for (const videoId of event.videoIds) {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => { resolve = res; });
        deferreds.set(videoId, { promise, resolve });
      }
      const tasks: ListrTask<unknown>[] = event.videoIds.map((videoId) => ({
        title: videoId,
        task: (_ctx, task) => {
          const handle: TaskHandle = {
            setTitle: (title) => { task.title = title; },
            setOutput: (output) => { task.output = output; },
          };
          handles.set(videoId, handle);
          const held = pending.get(videoId);
          if (held?.title !== undefined) handle.setTitle(held.title);
          if (held?.output !== undefined) handle.setOutput(held.output);
          pending.delete(videoId);
          return deferreds.get(videoId)!.promise;
        },
      }));
      const list = new Listr(tasks, {
        concurrent: true,
        exitOnError: false,
        ...(options.renderer ? { renderer: options.renderer } : {}),
      });
      runPromise = list.run().catch(() => undefined);
      return;
    }

    if (event.type === "stage:done") {
      const agent = STAGE_AGENT[event.stage];
      const usage = agent ? lastUsage.get(agent) : undefined;
      if (agent && usage) {
        const video = state.videos.get(event.videoId);
        const info = video?.stages.get(stageKey(event.stage, event.segmentIndex));
        if (info) info.tokens = usage.input_tokens + usage.output_tokens;
        lastUsage.delete(agent);
      }
    }

    if ("videoId" in event) refresh(event.videoId);

    if (event.type === "video:done") {
      const video = state.videos.get(event.videoId);
      if (video) setOutput(event.videoId, [videoOutput(state, event.videoId), summaryLine(video)].filter(Boolean).join("\n"));
      deferreds.get(event.videoId)?.resolve();
    }
  }

  async function finish(): Promise<void> {
    await runPromise;
    unsubscribeUsage();
  }

  return { onEvent, finish };
}
