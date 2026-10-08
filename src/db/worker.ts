import type { IngestEvent } from "../orchestrator/events.js";
import { totalCostUsd, type RunReport } from "../orchestrator/report.js";
import type { Collections, JobDoc } from "./mongo.js";
import { recordVideos } from "./sync.js";

export interface WorkerDeps {
  c: Collections;
  /** Runs the pipeline on one URL, reporting progress through onEvent. */
  runIngest: (url: string, onEvent: (e: IngestEvent) => void) => Promise<RunReport>;
  now?: () => string;
}

/** One line for the site's progress list, or null for events too fine-grained to show. */
export function describeEvent(e: IngestEvent): string | null {
  switch (e.type) {
    case "video:title":
      return `Video: ${e.title}`;
    case "stage:start":
      if (e.stage === "source") return "Downloading captions";
      if (e.stage === "scout") return "Finding the dishes in the video";
      if (e.stage === "extract") return `Writing up: ${e.workingName ?? `dish ${(e.segmentIndex ?? 0) + 1}`}`;
      return null;
    case "segment:error":
      return `A dish failed: ${e.error}`;
    case "placement":
      if (e.action === "written" || e.action === "replaced" || e.action === "kept-both") return `Saved ${e.recipeId}`;
      if (e.action === "kept-existing") return `Kept the existing, more complete ${e.recipeId}`;
      if (e.action === "too-thin") return `Skipped ${e.recipeId}: too little was said to make a recipe`;
      if (e.action === "invalid") return `Skipped ${e.recipeId}: failed validation`;
      return null;
    case "video:done":
      if (e.status === "skipped-no-captions") return "This video has no Russian captions";
      if (e.status === "not-recipe") return "This doesn't look like a cooking video";
      if (e.status === "error") return "The video failed";
      return `Finished: ${e.recipes} recipe${e.recipes === 1 ? "" : "s"}`;
    default:
      return null;
  }
}

/** Atomically takes the oldest queued job, so two workers never run the same one. */
export async function claimNextJob(c: Collections, now: () => string): Promise<JobDoc | null> {
  return c.jobs.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "running", startedAt: now() } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

export async function runJob(job: JobDoc, deps: WorkerDeps): Promise<void> {
  const { c } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  // Progress writes are chained so they land in order and all finish before the job is closed.
  let writes = Promise.resolve();
  const onEvent = (e: IngestEvent) => {
    const line = describeEvent(e);
    if (line) writes = writes.then(() => c.jobs.updateOne({ _id: job._id }, { $push: { progress: line } })).then(() => undefined);
  };
  try {
    const report = await deps.runIngest(job.url, onEvent);
    await writes;
    await recordVideos(c, report);
    const failed = report.videos.length > 0 && report.videos.every((v) => v.status === "error");
    await c.jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          status: failed ? "error" : "done",
          finishedAt: now(),
          recipes: report.written,
          error: failed ? report.videos.map((v) => v.error ?? "failed").join("; ") : null,
          costUsd: totalCostUsd(report.usageRows),
        },
      },
    );
  } catch (e) {
    await writes.catch(() => undefined);
    await c.jobs.updateOne({ _id: job._id }, { $set: { status: "error", finishedAt: now(), error: (e as Error).message } });
  }
}

/**
 * A job left "running" when the worker stopped will never finish; it is put back in the
 * queue on the next start so its URL still gets processed.
 */
export async function requeueAbandoned(c: Collections): Promise<number> {
  const res = await c.jobs.updateMany({ status: "running" }, { $set: { status: "queued", startedAt: null, progress: [] } });
  return res.modifiedCount;
}

/** Runs queued jobs one at a time until the signal aborts. */
export async function workLoop(deps: WorkerDeps, opts: { pollMs: number; signal: AbortSignal; onJob?: (job: JobDoc) => void }): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  while (!opts.signal.aborted) {
    const job = await claimNextJob(deps.c, now);
    if (job) {
      opts.onJob?.(job);
      await runJob(job, deps);
      continue;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.pollMs);
      opts.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
