import pLimit from "p-limit";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { Vocab } from "../vocab/load.js";
import { validateRecipe } from "../vocab/validate.js";
import { StageCache } from "./cache.js";
import { Catalog } from "./catalog.js";
import { assembleRecipe } from "./assemble.js";
import { emptyReport, type RunReport, type VideoStatus } from "./report.js";
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
}

const STAGE_ORDER = ["scout", "extract", "verify", "categorize"] as const;
type Stage = (typeof STAGE_ORDER)[number];

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
  const report = emptyReport(url);
  const promptsDir = config.paths.prompts;

  // --only-stage X (with or without --force) re-runs X and every stage downstream of it.
  // --force alone (no --only-stage) re-runs every agent stage. The source (yt-dlp) stage
  // is never forced by either flag.
  const shouldForce = (stage: Stage): boolean => {
    if (opts.onlyStage) return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(opts.onlyStage);
    return !!opts.force;
  };

  async function stage<T>(videoId: string, key: string, schema: z.ZodType<T>, force: boolean | undefined, run: () => Promise<T>): Promise<T> {
    if (!force) {
      const hit = await cache.get(videoId, key, schema);
      if (hit) return hit;
    }
    const value = await run();
    await cache.set(videoId, key, value);
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
  const rows: VideoRow[] = new Array(videoIds.length);
  const videoLimit = pLimit(config.concurrency);

  await Promise.all(
    videoIds.map((videoId, index) =>
      videoLimit(async () => {
        let title = videoId;
        try {
          const fetched = await stage(videoId, "source", z.union([VideoSourceSchema, SkippedSchema]), false, () => fetch(videoId, path.join(cache.dir(videoId), "yt")));
          if ("skipped" in fetched) {
            rows[index] = { videoId, title, status: "skipped-no-captions", recipes: 0 };
            return;
          }
          const source: VideoSource = fetched;
          title = source.title;

          const scout = await stage(videoId, "scout", ScoutResultSchema, shouldForce("scout"), () => runScout(source, llm, promptsDir));
          if (!scout.isRecipeVideo) {
            rows[index] = { videoId, title, status: "not-recipe", recipes: 0 };
            return;
          }

          const segmentLimit = pLimit(config.concurrency);
          const recipes = await Promise.all(
            scout.segments.map((segment, i) =>
              segmentLimit(async () => {
                const timedTranscript = renderTranscript(sliceCues(source.cues, segment.start, segment.end));
                const draft = await stage(videoId, `extract-${i}`, DraftRecipeSchema, shouldForce("extract"), () => runExtractor(segment, vocab, llm, promptsDir, timedTranscript));
                const verification = await stage(videoId, `verify-${i}`, VerificationSchema, shouldForce("verify"), () => runVerifier(segment, draft, llm, promptsDir));
                const categorization = await stage(videoId, `categorize-${i}`, CategorizationSchema, shouldForce("categorize"), () => runCategorizer(draft, vocab, llm, promptsDir));
                for (const name of draft.unmappedIngredients) report.unmapped[name] = (report.unmapped[name] ?? 0) + 1;
                return assembleRecipe({ source, segment, draft, verification, categorization, models: config.models });
              }),
            ),
          );

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
              continue;
            }
            for (const f of recipe.flags) report.flags.push({ recipeId: recipe.id, ...f });
            await withCatalogLock(() => placeInCatalog(recipe));
            placed++;
          }
          rows[index] = { videoId, title, status: "done", recipes: placed };
        } catch (e) {
          rows[index] = { videoId, title, status: "error", recipes: 0, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  );

  report.videos = rows;
  report.usage = deps.usageText?.() ?? "";
  return report;

  async function placeInCatalog(incoming: Recipe): Promise<void> {
    const existingAll = (await catalog.load()).filter((r) => r.id !== incoming.id);
    const candidates = findCandidates(incoming, existingAll);
    const self = (await catalog.load()).find((r) => r.id === incoming.id);
    if (candidates.length === 0) {
      if (self && self.completeness >= incoming.completeness) { report.keptExisting.push(self.id); return; }
      await catalog.write(incoming);
      report.written.push(incoming.id);
      return;
    }
    const existing = candidates[0];
    const decision = await runJudge(existing, incoming, llm, promptsDir);
    const result = decide(existing, incoming, decision);
    if (result.action === "replace") {
      await catalog.archive(existing);
      report.archived.push(existing.id);
      await catalog.write(result.incoming);
      report.written.push(result.incoming.id);
    } else if (result.action === "keep-existing") {
      report.keptExisting.push(existing.id);
    } else {
      if (result.existing.nameRu !== existing.nameRu) await catalog.rename(existing, result.existing.nameRu);
      await catalog.write(result.incoming);
      report.written.push(result.incoming.id);
    }
  }
}
