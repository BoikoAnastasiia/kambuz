import { Listr, color, type ListrTask, type ListrRendererValue } from "listr2";
import type { AgentName } from "../config.js";
import type { UsageLedger } from "../llm/usage.js";
import type { IngestEvent } from "../orchestrator/events.js";
import { createProgressState, reduceProgress, stageKey, type ProgressState, type StageProgress } from "./progress-state.js";

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

// Exported for direct unit testing (see the token-overlap test in
// test/cli/progress.test.ts) — these are the same pure functions the
// renderer itself uses to build each listr task's title/output text.
export function stageLine(stage: string, info: StageProgress): string {
  const label = STAGE_LABEL[stage.split("-")[0]] ?? stage;
  const named = info.workingName ? `${label} [${info.workingName}]` : label;
  if (info.state === "running") return `${named}…`;
  if (info.state === "cached") return `${named}: cached`;
  if (info.state === "error") return `${named}: ${color.red(info.error ?? "error")}`;
  const tokenPart = info.tokensUncertain ? "— tok" : info.tokens ? `${formatTokens(info.tokens)} tok` : undefined;
  const parts = [info.ms !== undefined ? formatSeconds(info.ms) : undefined, tokenPart].filter(Boolean);
  return `${named}: ${parts.join(" · ") || "done"}`;
}

export function videoOutput(state: ProgressState, videoId: string): string {
  const video = state.videos.get(videoId);
  if (!video) return "";
  return [...video.stages.entries()].map(([key, info]) => stageLine(key, info)).join("  ·  ");
}

export function summaryLine(video: NonNullable<ReturnType<ProgressState["videos"]["get"]>>): string {
  if (video.status === "skipped-no-captions") return "skipped (no captions)";
  if (video.status === "not-recipe") return "not a recipe video";
  if (video.status === "error") return color.red("error");
  const totalMs = [...video.stages.values()].reduce((sum, s) => sum + (s.ms ?? 0), 0);
  const totalTokens = [...video.stages.values()].reduce((sum, s) => sum + (s.tokens ?? 0), 0);
  return `${video.recipes ?? 0} recipe${video.recipes === 1 ? "" : "s"} · ${formatSeconds(totalMs)} · ${formatTokens(totalTokens)} tokens`;
}

/**
 * Whether a token count from the ledger can be safely attributed to the
 * stage whose stage:done just fired. `inFlightBeforeDone` is how many calls
 * for that stage's agent were in flight (including this one) the instant
 * before it finished — UsageLedger.subscribe carries no videoId, so if more
 * than one call for the same agent was running at once (concurrent segments,
 * or two videos), the latest ledger entry could belong to either; attributing
 * it anyway would silently show the wrong number, so this reports "uncertain"
 * instead of guessing.
 */
export function attributeTokens(inFlightBeforeDone: number, usage?: { input_tokens: number; output_tokens: number }): { tokens?: number; uncertain: boolean } {
  if (!usage) return { uncertain: false };
  if (inFlightBeforeDone <= 1) return { tokens: usage.input_tokens + usage.output_tokens, uncertain: false };
  return { uncertain: true };
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
  /** Test-only hook: called with the underlying listr2 Listr instance once it's created, so a test can read a task's real .output/.title after feeding it events. */
  onListCreated?: (list: Listr<unknown, ListrRendererValue, ListrRendererValue>) => void;
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
  // UsageLedger.subscribe — so this is only trustworthy when a single call for
  // that agent is in flight; inFlight (below) is what tells attributeTokens()
  // whether that held.
  const lastUsage = new Map<AgentName, { input_tokens: number; output_tokens: number }>();
  const unsubscribeUsage = ledger.subscribe((agent, _model, usage) => lastUsage.set(agent, usage));
  // Count of currently-running LLM calls per agent, across every video and
  // segment: incremented on stage:start for a stage that maps to an agent,
  // decremented on stage:done. Read (before the decrement) by attributeTokens().
  const inFlight = new Map<AgentName, number>();

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
        // Without this listr2 only shows task.output while the task is
        // pending (see the isPending() || persistentOutput gate in
        // listr2's DefaultRenderer) — a finished video's stage breakdown
        // and summary line would vanish the instant its task completes.
        rendererOptions: { persistentOutput: true },
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
      options.onListCreated?.(list);
      runPromise = list.run().catch(() => undefined);
      return;
    }

    if (event.type === "stage:start") {
      const agent = STAGE_AGENT[event.stage];
      if (agent) inFlight.set(agent, (inFlight.get(agent) ?? 0) + 1);
    }

    if (event.type === "stage:done") {
      const agent = STAGE_AGENT[event.stage];
      if (agent) {
        const usage = lastUsage.get(agent);
        const { tokens, uncertain } = attributeTokens(inFlight.get(agent) ?? 0, usage);
        const video = state.videos.get(event.videoId);
        const info = video?.stages.get(stageKey(event.stage, event.segmentIndex));
        if (info) {
          if (tokens !== undefined) info.tokens = tokens;
          info.tokensUncertain = uncertain;
        }
        if (usage) lastUsage.delete(agent);
        inFlight.set(agent, Math.max(0, (inFlight.get(agent) ?? 0) - 1));
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
