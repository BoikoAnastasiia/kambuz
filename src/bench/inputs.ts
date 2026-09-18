import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DraftRecipeSchema, type DraftRecipe } from "../schemas/recipe.js";
import { ScoutResultSchema, type ScoutSegment } from "../schemas/scout.js";

export interface BenchSegment {
  videoId: string;
  segmentIndex: number;
  segment: ScoutSegment;
  draft: DraftRecipe;
  /** The course from the cached categorize-<i>.json, when there is one; used to pick realistic planted ingredients. */
  course: string | null;
}

const CachedCourseSchema = z.object({ course: z.string() });

export function segmentKey(s: { videoId: string; segmentIndex: number }): string {
  return `${s.videoId}#${s.segmentIndex}`;
}

/**
 * sha256 of the sorted `videoId#segmentIndex:course` rows of the segments a verifier bench run
 * could draw a planted extra-ingredient donor from. Two reports plant comparable errors only when
 * this matches; it is stored so that can be checked by eye, not compared automatically.
 */
export function donorPoolHash(segments: readonly BenchSegment[]): string {
  const rows = segments.map((s) => `${segmentKey(s)}:${s.course ?? ""}`).sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

type Read<T> = { value: T } | { missing: true } | { error: string };

async function readStage<T>(file: string, schema: z.ZodType<T>): Promise<Read<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { missing: true };
  }
  try {
    return { value: schema.parse(JSON.parse(text)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/**
 * Every cached segment that has both its scout slice and its extractor draft. Read-only:
 * unlike StageCache, nothing here is ever re-run or rewritten — a gap is only reported.
 */
export async function loadBenchInputs(cacheRoot: string): Promise<{ segments: BenchSegment[]; skipped: string[] }> {
  const segments: BenchSegment[] = [];
  const skipped: string[] = [];
  let videoIds: string[];
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    videoIds = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return { segments, skipped: [`no cache directory at ${cacheRoot}`] };
  }
  for (const videoId of videoIds) {
    const dir = path.join(cacheRoot, videoId);
    const scout = await readStage(path.join(dir, "scout.json"), ScoutResultSchema);
    if ("missing" in scout) { skipped.push(`${videoId}: no scout.json`); continue; }
    if ("error" in scout) { skipped.push(`${videoId}: unusable scout.json (${scout.error})`); continue; }
    for (const [segmentIndex, segment] of scout.value.segments.entries()) {
      const key = segmentKey({ videoId, segmentIndex });
      const draft = await readStage(path.join(dir, `extract-${segmentIndex}.json`), DraftRecipeSchema);
      if ("missing" in draft) { skipped.push(`${key}: no extract-${segmentIndex}.json`); continue; }
      if ("error" in draft) { skipped.push(`${key}: unusable extract-${segmentIndex}.json (${draft.error})`); continue; }
      const categorized = await readStage(path.join(dir, `categorize-${segmentIndex}.json`), CachedCourseSchema);
      segments.push({ videoId, segmentIndex, segment, draft: draft.value, course: "value" in categorized ? categorized.value.course : null });
    }
  }
  return { segments, skipped };
}
