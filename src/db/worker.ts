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

/**
 * One line for the site's progress list (the site is in Russian), or null for events too
 * fine-grained to show. Recipes are named by the scout's working name, not by recipe id.
 */
export function describeEvent(e: IngestEvent): string | null {
  switch (e.type) {
    case "video:title":
      return `Видео: ${e.title}`;
    case "stage:start":
      if (e.stage === "source") return "Скачиваем субтитры";
      if (e.stage === "scout") return "Ищем блюда в видео";
      if (e.stage === "extract") return `Записываем рецепт: ${e.workingName ?? `блюдо ${(e.segmentIndex ?? 0) + 1}`}`;
      return null;
    case "segment:error":
      return `Одно блюдо не получилось: ${friendlyError(e.error)}`;
    case "placement":
      if (e.action === "written" || e.action === "replaced" || e.action === "kept-both") return "Рецепт сохранён";
      if (e.action === "kept-existing") return "Такое блюдо уже есть, и та версия полнее — оставили её";
      if (e.action === "too-thin") return "Одно блюдо пропущено: о нём сказано слишком мало для рецепта";
      if (e.action === "invalid") return "Одно блюдо пропущено: рецепт не прошёл проверку";
      return null;
    case "video:done":
      if (e.status === "skipped-no-captions") return "У этого видео нет русских субтитров";
      if (e.status === "not-recipe") return "Это не похоже на кулинарное видео";
      if (e.status === "error") return "Не удалось разобрать видео";
      return `Готово, рецептов: ${e.recipes}`;
    default:
      return null;
  }
}

/**
 * The site shows a job's error to whoever pasted the link, so the known yt-dlp failures
 * become a sentence in Russian; anything else is passed on, cut to a readable length.
 */
export function friendlyError(raw: string): string {
  if (/HTTP Error 429|Too Many Requests|confirm you.re not a bot/i.test(raw)) {
    return "YouTube временно блокирует загрузки с этого компьютера из-за слишком частых запросов. Попробуйте через час-другой.";
  }
  if (/Video unavailable|Private video|This video is not available/i.test(raw)) return "Видео недоступно — возможно, оно скрыто, удалено или заблокировано в этом регионе.";
  if (/yt-dlp not found/i.test(raw)) return "На компьютере с воркером не установлен yt-dlp (brew install yt-dlp).";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
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
          error: failed ? [...new Set(report.videos.map((v) => friendlyError(v.error ?? "failed")))].join("; ") : null,
          costUsd: totalCostUsd(report.usageRows),
        },
      },
    );
  } catch (e) {
    await writes.catch(() => undefined);
    await c.jobs.updateOne({ _id: job._id }, { $set: { status: "error", finishedAt: now(), error: friendlyError((e as Error).message) } });
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
