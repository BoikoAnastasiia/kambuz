import pLimit from "p-limit";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { Vocab } from "../vocab/load.js";
import { validateRecipe } from "../vocab/validate.js";
import { StageCache } from "./cache.js";
import { Catalog } from "./catalog.js";
import { assembleRecipe } from "./assemble.js";
import { emptyReport, type RunReport, type VideoStatus } from "./report.js";
import type { IngestEvent, StageName } from "./events.js";
import { fetchVideo as realFetch, expandUrl as realExpand, type FetchResult } from "../fetcher/ytdlp.js";
import { renderTranscript, sliceCues } from "../fetcher/vtt.js";
import { VideoSourceSchema, type VideoSource } from "../schemas/source.js";
import { ScoutResultSchema } from "../schemas/scout.js";
import { CategorizationSchema, DraftRecipeSchema, RecipeSchema, VerificationSchema, type Recipe } from "../schemas/recipe.js";
import { runScout } from "../agents/scout.js";
import { runExtractor } from "../agents/extractor.js";
import { runVerifier } from "../agents/verifier.js";
import { runCategorizer } from "../agents/categorizer.js";
import { findCandidates, runJudge, decide } from "../agents/judge.js";
import path from "node:path";
import { z } from "zod";

export interface IngestDeps {
  config: Config;
  llm: LlmClient;
  vocab: Vocab;
  cache: StageCache;
  catalog: Catalog;
  fetch?: (videoId: string, workDir: string) => Promise<FetchResult>;
  expand?: (url: string) => Promise<string[]>;
  usageText?: () => string;
  onEvent?: (e: IngestEvent) => void;
}

const STAGE_ORDER = ["scout", "extract", "verify", "categorize"] as const;
type Stage = (typeof STAGE_ORDER)[number];

// Cache keys are either a bare stage name ("source", "scout") or a stage name
// plus the segment it belongs to ("extract-0"); this recovers the two parts
// so stage() can report them separately on IngestEvent.
function parseStageKey(key: string): { stage: StageName; segmentIndex?: number } {
  const m = /^([a-z]+)-(\d+)$/.exec(key);
  if (m) return { stage: m[1] as StageName, segmentIndex: Number(m[2]) };
  return { stage: key as StageName };
}

export interface IngestOptions {
  force?: boolean;
  onlyStage?: Stage;
}

const SkippedSchema = z.object({ videoId: z.string(), skipped: z.literal("no-captions") });

type VideoRow = { videoId: string; title: string; status: VideoStatus; recipes: number; error?: string };

export async function ingest(url: string, deps: IngestDeps, opts: IngestOptions): Promise<RunReport> {
  const { config, llm, vocab, cache, catalog } = deps;
  const fetch = deps.fetch ?? realFetch;
  const expand = deps.expand ?? realExpand;
  const report = emptyReport(url, config.minCompleteness);
  const promptsDir = config.paths.prompts;

  // --only-stage X (with or without --force) re-runs X and every stage downstream of it.
  // --force alone (no --only-stage) re-runs every agent stage. The source (yt-dlp) stage
  // is never forced by either flag.
  const shouldForce = (stage: Stage): boolean => {
    if (opts.onlyStage) return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(opts.onlyStage);
    return !!opts.force;
  };

  // Emitting a progress event must never break the pipeline: onEvent is owned
  // by a renderer that has no business taking down a run if it throws.
  function emit(e: IngestEvent): void {
    try {
      deps.onEvent?.(e);
    } catch {
      // ignored — see comment above
    }
  }

  async function stage<T>(videoId: string, key: string, schema: z.ZodType<T>, force: boolean | undefined, run: () => Promise<T>, workingName?: string): Promise<T> {
    const { stage: stageName, segmentIndex } = parseStageKey(key);
    if (!force) {
      const hit = await cache.get(videoId, key, schema);
      if (hit) {
        emit({ type: "stage:cached", videoId, stage: stageName, segmentIndex });
        return hit;
      }
    }
    emit({ type: "stage:start", videoId, stage: stageName, segmentIndex, workingName });
    const startedAt = Date.now();
    let value: T;
    try {
      value = await run();
    } catch (e) {
      // Not cached, not swallowed: a listener sees the stage ended (so it can, say,
      // stop counting this call as in-flight), and the failure still propagates to
      // whatever awaits this segment/video exactly as before this event existed.
      emit({ type: "stage:error", videoId, stage: stageName, segmentIndex, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    await cache.set(videoId, key, value);
    emit({ type: "stage:done", videoId, stage: stageName, segmentIndex, ms: Date.now() - startedAt });
    return value;
  }

  // Serializes catalog placement (load -> judge -> write/archive/rename) across videos
  // running concurrently, so two videos never interleave a catalog.load() with each
  // other's write — same promise-chain mutex pattern as Catalog's internal queue.
  let catalogQueue: Promise<void> = Promise.resolve();
  function withCatalogLock<T>(task: () => Promise<T>): Promise<T> {
    const result = catalogQueue.then(task, task);
    catalogQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // yt-dlp failures here (bad URL, private playlist, no network) are the first thing a
  // run hits; report them as a message instead of an unhandled subprocess rejection.
  let videoIds: string[];
  try {
    videoIds = await expand(url);
  } catch (e) {
    throw new Error(`could not expand ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  emit({ type: "videos", videoIds });
  const rows: VideoRow[] = new Array(videoIds.length);
  function finishVideo(index: number, row: VideoRow): void {
    rows[index] = row;
    emit({ type: "video:done", videoId: row.videoId, status: row.status, recipes: row.recipes });
  }
  // One ceiling for every LLM call in the run. A per-segment limit nested inside a
  // per-video one let concurrency² calls run at once; yt-dlp, which is rate-limited by
  // YouTube rather than by us, gets its own small limit.
  const llmLimit = pLimit(config.concurrency);
  const fetchLimit = pLimit(2);

  await Promise.all(
    videoIds.map((videoId, index) =>
      (async () => {
        let title = videoId;
        emit({ type: "video:start", videoId });
        try {
          const fetched = await stage(videoId, "source", z.union([VideoSourceSchema, SkippedSchema]), false, () => fetchLimit(() => fetch(videoId, path.join(cache.dir(videoId), "yt"))));
          if ("skipped" in fetched) {
            finishVideo(index, { videoId, title, status: "skipped-no-captions", recipes: 0 });
            return;
          }
          const source: VideoSource = fetched;
          title = source.title;
          emit({ type: "video:title", videoId, title });

          const scout = await stage(videoId, "scout", ScoutResultSchema, shouldForce("scout"), () => llmLimit(() => runScout(source, llm, promptsDir)));
          if (!scout.isRecipeVideo) {
            finishVideo(index, { videoId, title, status: "not-recipe", recipes: 0 });
            return;
          }

          // One bad segment (a refusal, a truncated answer, a schema miss) must not throw
          // away the dishes that did come out of the same video.
          const settled = await Promise.allSettled(
            scout.segments.map(async (segment, i) => {
              const timedTranscript = renderTranscript(sliceCues(source.cues, segment.start, segment.end));
              const draft = await stage(videoId, `extract-${i}`, DraftRecipeSchema, shouldForce("extract"), () => llmLimit(() => runExtractor(segment, vocab, llm, promptsDir, timedTranscript)), segment.workingName);
              const verification = await stage(videoId, `verify-${i}`, VerificationSchema, shouldForce("verify"), () => llmLimit(() => runVerifier(segment, draft, llm, promptsDir)), segment.workingName);
              const categorization = await stage(videoId, `categorize-${i}`, CategorizationSchema, shouldForce("categorize"), () => llmLimit(() => runCategorizer(draft, vocab, llm, promptsDir)), segment.workingName);
              for (const name of draft.unmappedIngredients) report.unmapped[name] = (report.unmapped[name] ?? 0) + 1;
              return assembleRecipe({ source, segment, draft, verification, categorization, models: config.models });
            }),
          );

          const recipes: Recipe[] = [];
          settled.forEach((outcome, i) => {
            if (outcome.status === "fulfilled") {
              recipes.push(outcome.value);
              return;
            }
            const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            report.segmentErrors.push({ videoId, segmentIndex: i, workingName: scout.segments[i].workingName, error });
            emit({ type: "segment:error", videoId, segmentIndex: i, error });
          });

          if (recipes.length === 0 && settled.length > 0) {
            const first = settled.find((o) => o.status === "rejected") as PromiseRejectedResult | undefined;
            const error = first ? (first.reason instanceof Error ? first.reason.message : String(first.reason)) : "no segments produced a recipe";
            finishVideo(index, { videoId, title, status: "error", recipes: 0, error });
            return;
          }

          // de-duplicate ids within one video (same dishKey twice)
          const seen = new Map<string, number>();
          for (const r of recipes) {
            const n = (seen.get(r.id) ?? 0) + 1;
            seen.set(r.id, n);
            if (n > 1) r.id = `${r.id}-${n}`;
          }

          let placed = 0;
          for (const recipe of recipes) {
            // The agents' wire schemas are deliberately loose (structured outputs can't
            // enforce a pattern or a range), so the strict shape is checked here, once,
            // before anything is written.
            const shape = RecipeSchema.safeParse(recipe);
            const errors = [
              ...(shape.success ? [] : shape.error.issues.map((i) => `invalid ${i.path.join(".") || "recipe"}: ${i.message}`)),
              ...validateRecipe(recipe, vocab),
            ];
            if (errors.length) {
              report.validationErrors.push({ recipeId: recipe.id, errors });
              emit({ type: "placement", videoId, recipeId: recipe.id, action: "invalid" });
              continue;
            }
            // Below the write threshold: not enough ingredients/steps to be cookable. The
            // stage cache is untouched, so a prompt fix can rescue it with --only-stage extract.
            if (recipe.completeness < config.minCompleteness) {
              report.tooThin.push({ recipeId: recipe.id, completeness: recipe.completeness, ingredients: recipe.ingredients.length, steps: recipe.steps.length });
              emit({ type: "placement", videoId, recipeId: recipe.id, action: "too-thin" });
              // This segment's earlier catalog entry (if any) is obsolete either way — a
              // too-thin re-processing must not leave a stale version of the same segment behind.
              await withCatalogLock(() => supersedeSegment(recipe.source, videoId));
              continue;
            }
            for (const f of recipe.flags) report.flags.push({ recipeId: recipe.id, ...f });
            await withCatalogLock(() => placeInCatalog(recipe));
            placed++;
          }
          finishVideo(index, { videoId, title, status: "done", recipes: placed });
        } catch (e) {
          finishVideo(index, { videoId, title, status: "error", recipes: 0, error: e instanceof Error ? e.message : String(e) });
        }
      })(),
    ),
  );

  report.videos = rows;
  report.usage = deps.usageText?.() ?? "";
  return report;

  // A recipe's identity for re-processing is its segment (same videoId + segmentStart),
  // regardless of id — the categorizer's dishKey can drift between runs. Archives every
  // catalog recipe for that segment except `keepId` (the id this placement just wrote, or
  // undefined when nothing from this segment was written this time — e.g. keep-existing or
  // too-thin). The newest processing of a segment is authoritative, so this never compares
  // completeness. Must run inside withCatalogLock — callers either already hold it
  // (placeInCatalog) or must take it themselves (the too-thin path in the main loop).
  async function supersedeSegment(source: Recipe["source"], videoId: string, keepId?: string): Promise<void> {
    const all = await catalog.load();
    const previous = all.filter((r) => r.source.videoId === source.videoId && r.source.segmentStart === source.segmentStart && r.id !== keepId);
    for (const p of previous) {
      await catalog.archive(p);
      report.superseded.push(p.id);
      emit({ type: "placement", videoId, recipeId: p.id, action: "superseded" });
    }
  }

  async function placeInCatalog(incoming: Recipe): Promise<void> {
    const videoId = incoming.source.videoId;
    const all = await catalog.load();
    // Earlier catalog entries for this exact segment (any id) are not candidates for the
    // judge/completeness comparison below — that comparison is only meaningful across
    // DIFFERENT segments. Re-processing the same segment always wins outright.
    const previousIds = new Set(
      all.filter((r) => r.source.videoId === incoming.source.videoId && r.source.segmentStart === incoming.source.segmentStart).map((r) => r.id),
    );
    const existingAll = all.filter((r) => r.id !== incoming.id && !previousIds.has(r.id));
    const candidates = findCandidates(incoming, existingAll);
    if (candidates.length === 0) {
      await catalog.write(incoming);
      report.written.push(incoming.id);
      emit({ type: "placement", videoId, recipeId: incoming.id, action: "written" });
      await supersedeSegment(incoming.source, videoId, incoming.id);
      return;
    }
    const existing = candidates[0];
    const decision = await llmLimit(() => runJudge(existing, incoming, llm, promptsDir));
    const result = decide(existing, incoming, decision);
    if (result.action === "replace") {
      await catalog.archive(existing);
      report.archived.push(existing.id);
      await catalog.write(result.incoming);
      report.written.push(result.incoming.id);
      emit({ type: "placement", videoId, recipeId: result.incoming.id, action: "replaced" });
      await supersedeSegment(incoming.source, videoId, result.incoming.id);
    } else if (result.action === "keep-existing") {
      report.keptExisting.push(existing.id);
      emit({ type: "placement", videoId, recipeId: existing.id, action: "kept-existing" });
      // Another segment's recipe won the comparison, but this segment's own previous
      // output is still obsolete now that it has been re-processed.
      await supersedeSegment(incoming.source, videoId);
    } else {
      if (result.existing.nameRu !== existing.nameRu) await catalog.rename(existing, result.existing.nameRu);
      await catalog.write(result.incoming);
      emit({ type: "placement", videoId, recipeId: result.incoming.id, action: "kept-both" });
      report.written.push(result.incoming.id);
      await supersedeSegment(incoming.source, videoId, result.incoming.id);
    }
  }
}
