import pLimit from "p-limit";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { Vocab } from "../vocab/load.js";
import { validateRecipe } from "../vocab/validate.js";
import { StageCache } from "./cache.js";
import { Catalog } from "./catalog.js";
import { assembleRecipe } from "./assemble.js";
import { emptyReport, type RunReport } from "./report.js";
import { fetchVideo as realFetch, expandUrl as realExpand, type FetchResult } from "../fetcher/ytdlp.js";
import { VideoSourceSchema, type VideoSource } from "../schemas/source.js";
import { ScoutResultSchema } from "../schemas/scout.js";
import { CategorizationSchema, DraftRecipeSchema, VerificationSchema, type Recipe } from "../schemas/recipe.js";
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

export interface IngestOptions {
  force?: boolean;
  onlyStage?: "scout" | "extract" | "verify" | "categorize";
}

const SkippedSchema = z.object({ videoId: z.string(), skipped: z.literal("no-captions") });

export async function ingest(url: string, deps: IngestDeps, opts: IngestOptions): Promise<RunReport> {
  const { config, llm, vocab, cache, catalog } = deps;
  const fetch = deps.fetch ?? realFetch;
  const expand = deps.expand ?? realExpand;
  const report = emptyReport(url);
  const promptsDir = config.paths.prompts;
  const forced = (stage: IngestOptions["onlyStage"]) => opts.force && (!opts.onlyStage || opts.onlyStage === stage);

  async function stage<T>(videoId: string, key: string, schema: z.ZodType<T>, force: boolean | undefined, run: () => Promise<T>): Promise<T> {
    if (!force) {
      const hit = await cache.get(videoId, key, schema);
      if (hit) return hit;
    }
    const value = await run();
    await cache.set(videoId, key, value);
    return value;
  }

  const videoIds = await expand(url);
  for (const videoId of videoIds) {
    let title = videoId;
    try {
      const fetched = await stage(videoId, "source", z.union([VideoSourceSchema, SkippedSchema]), false, () => fetch(videoId, path.join(cache.dir(videoId), "yt")));
      if ("skipped" in fetched) {
        report.videos.push({ videoId, title, status: "skipped-no-captions", recipes: 0 });
        continue;
      }
      const source: VideoSource = fetched;
      title = source.title;

      const scout = await stage(videoId, "scout", ScoutResultSchema, forced("scout"), () => runScout(source, llm, promptsDir));
      if (!scout.isRecipeVideo) {
        report.videos.push({ videoId, title, status: "not-recipe", recipes: 0 });
        continue;
      }

      const limit = pLimit(config.concurrency);
      const recipes = await Promise.all(
        scout.segments.map((segment, i) =>
          limit(async () => {
            const draft = await stage(videoId, `extract-${i}`, DraftRecipeSchema, forced("extract"), () => runExtractor(segment, vocab, llm, promptsDir));
            const verification = await stage(videoId, `verify-${i}`, VerificationSchema, forced("verify") || forced("extract"), () => runVerifier(segment, draft, llm, promptsDir));
            const categorization = await stage(videoId, `categorize-${i}`, CategorizationSchema, forced("categorize") || forced("extract"), () => runCategorizer(draft, vocab, llm, promptsDir));
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

      for (const recipe of recipes) {
        const errors = validateRecipe(recipe, vocab);
        if (errors.length) throw new Error(`invalid recipe ${recipe.id}: ${errors.join("; ")}`);
        for (const f of recipe.flags) report.flags.push({ recipeId: recipe.id, ...f });
        await placeInCatalog(recipe);
      }
      report.videos.push({ videoId, title, status: "done", recipes: recipes.length });
    } catch (e) {
      report.videos.push({ videoId, title, status: "error", recipes: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

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
