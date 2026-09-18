import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateCategoryDocument } from "./categoryToCourseMethod.js";

export interface MigrationPaths {
  recipesDir: string;
  archiveDir: string;
  indexFile: string;
  benchTruthFile: string;
}

export interface MigrationLine {
  file: string;
  detail: string;
}

export interface MigrationResult {
  filesScanned: number;
  filesChanged: number;
  lines: MigrationLine[];
  errors: MigrationLine[];
}

function rowLabel(obj: Record<string, unknown>): string {
  if (typeof obj.id === "string") return obj.id;
  if (typeof obj.videoId === "string") {
    const seg = typeof obj.segmentIndex === "number" ? `#${obj.segmentIndex}` : "";
    return `${obj.videoId}${seg}`;
  }
  return "(row)";
}

async function migrateFile(file: string, result: MigrationResult): Promise<void> {
  result.filesScanned++;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    result.errors.push({ file, detail: `cannot read/parse: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
    return;
  }
  let migrated: ReturnType<typeof migrateCategoryDocument>;
  try {
    migrated = migrateCategoryDocument(raw);
  } catch (e) {
    result.errors.push({ file, detail: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (migrated.changes.length === 0) return;
  await writeFile(file, JSON.stringify(migrated.value, null, 2));
  result.filesChanged++;
  for (const c of migrated.changes) {
    result.lines.push({ file: path.basename(file), detail: `${rowLabel(c.obj)}: ${c.from} -> course=${c.obj.course} method=${c.obj.method ?? "null"}` });
  }
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites every `catalog/recipes/*.json` and `catalog/archive/*.json` recipe, `catalog/index.json`,
 * and the bench ground truth file: old `category` -> `course` + `method` (see
 * CATEGORY_TO_COURSE_METHOD). Idempotent — a second run touches nothing, since a migrated object
 * no longer has a `category` field. Read-only I/O errors and unmapped legacy category values are
 * collected per file rather than aborting the whole run.
 */
export async function runMigration(paths: MigrationPaths): Promise<MigrationResult> {
  const result: MigrationResult = { filesScanned: 0, filesChanged: 0, lines: [], errors: [] };
  const recipeFiles = await jsonFilesIn(paths.recipesDir);
  const archiveFiles = await jsonFilesIn(paths.archiveDir);
  for (const f of [...recipeFiles, ...archiveFiles]) await migrateFile(f, result);
  for (const f of [paths.indexFile, paths.benchTruthFile]) {
    if (await exists(f)) await migrateFile(f, result);
  }
  return result;
}

export function renderMigrationTable(result: MigrationResult): string {
  const out = [`scanned ${result.filesScanned} file(s), changed ${result.filesChanged}`];
  if (result.lines.length) out.push("", ...result.lines.map((l) => `  ${l.file}: ${l.detail}`));
  else out.push("(nothing to migrate — already up to date)");
  if (result.errors.length) out.push("", "errors:", ...result.errors.map((e) => `  ${e.file}: ${e.detail}`));
  return out.join("\n");
}
