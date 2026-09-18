import { access, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { migrateCategoryDocument } from "./categoryToCourseMethod.js";
import { RecipeSchema } from "../schemas/recipe.js";
import { validateCategorizerTruth } from "../bench/categorizer.js";
import type { Vocab } from "../vocab/load.js";

export interface MigrationPaths {
  recipesDir: string;
  archiveDir: string;
  indexFile: string;
  benchTruthFile: string;
}

export interface RunMigrationOptions {
  vocab: Vocab;
  /** Computes and reports everything a real run would do, but writes nothing. */
  dryRun?: boolean;
}

export interface MigrationLine {
  file: string;
  detail: string;
}

export interface MigrationResult {
  filesScanned: number;
  filesChanged: number;
  /** Scanned but had no `category` field left to migrate — already migrated, or not this kind of object. */
  skipped: number;
  lines: MigrationLine[];
  /** Read/write/list failures and unmigratable rows — one entry per file, never aborts the rest. */
  errors: MigrationLine[];
  /** Migrated successfully but the result fails a post-migration shape check — written (or would be, in dry-run) anyway. */
  warnings: MigrationLine[];
  /** Set only when the bench truth file was found and processed (migrated or already up to date). */
  benchNullMethods: { total: number; withNullMethod: number } | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

function rowLabel(obj: Record<string, unknown>): string {
  if (typeof obj.id === "string") return obj.id;
  if (typeof obj.videoId === "string") {
    const seg = typeof obj.segmentIndex === "number" ? `#${obj.segmentIndex}` : "";
    return `${obj.videoId}${seg}`;
  }
  return "(row)";
}

function summarizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const shown = issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return shown.join("; ") + (issues.length > shown.length ? "; …" : "");
}

/** Records how many rows of an already-migrated bench truth array have `method: null`, for the README caveat. */
function recordBenchNullMethods(value: unknown, result: MigrationResult): void {
  if (!Array.isArray(value)) return;
  const rows = value.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  result.benchNullMethods = { total: rows.length, withNullMethod: rows.filter((r) => r.method === null).length };
}

type FileKind = "recipe" | "index" | "benchTruth";

async function migrateFile(file: string, kind: FileKind, result: MigrationResult, opts: RunMigrationOptions): Promise<void> {
  result.filesScanned++;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    result.errors.push({ file, detail: `cannot read/parse: ${errMsg(e)}` });
    return;
  }

  let migrated: ReturnType<typeof migrateCategoryDocument>;
  try {
    migrated = migrateCategoryDocument(raw);
  } catch (e) {
    result.errors.push({ file, detail: errMsg(e) });
    return;
  }

  if (migrated.changes.length === 0) {
    result.skipped++;
    if (kind === "benchTruth") recordBenchNullMethods(migrated.value, result);
    return;
  }

  if (kind === "recipe") {
    const parsed = RecipeSchema.safeParse(migrated.value);
    if (!parsed.success) result.warnings.push({ file, detail: `post-migration schema check failed: ${summarizeIssues(parsed.error.issues)}` });
  } else if (kind === "benchTruth") {
    const { errors: truthErrors } = validateCategorizerTruth(migrated.value, opts.vocab);
    if (truthErrors.length) result.warnings.push({ file, detail: `post-migration truth check: ${truthErrors.length} row(s) failed (${truthErrors.slice(0, 3).join("; ")}${truthErrors.length > 3 ? "; …" : ""})` });
  }

  if (!opts.dryRun) {
    // Write to a sibling temp file and rename over the original: a crash or a failed write
    // (e.g. EACCES) never truncates a file git — and the owner — has never seen the new content
    // of. A caught write/rename failure cleans up its own tmp file (see below); only a hard
    // process kill mid-write could leave one behind, and jsonFilesIn only picks up `*.json`, so
    // even that stray `.tmp` is harmless and ignored by the next pass.
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(migrated.value, null, 2));
      await rename(tmp, file);
    } catch (e) {
      // Best-effort cleanup: writeFile may have succeeded even though rename then failed (e.g.
      // the target is immutable/unwritable), which would otherwise leave `<file>.tmp` behind
      // forever. If the tmp file never got created, unlink just fails too — ignored either way.
      await unlink(tmp).catch(() => {});
      result.errors.push({ file, detail: `cannot write: ${errMsg(e)}` });
      return;
    }
  }

  result.filesChanged++;
  for (const c of migrated.changes) {
    result.lines.push({ file: path.basename(file), detail: `${rowLabel(c.obj)}: ${c.from} -> course=${c.obj.course} method=${c.obj.method ?? "null"}` });
  }
  if (kind === "benchTruth") recordBenchNullMethods(migrated.value, result);
}

/** Lists the `*.json` files directly in `dir`. A missing directory is empty, not an error; an
 *  existing-but-unreadable directory (e.g. permissions) is reported in `result.errors` instead
 *  of being silently treated as "nothing here". */
async function jsonFilesIn(dir: string, result: MigrationResult): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    result.errors.push({ file: dir, detail: `cannot list directory: ${errMsg(e)}` });
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

type Accessible = "yes" | "no" | { error: string };

/** Existence check via access() (no file content is read). Only ENOENT means "absent" — any
 *  other error (permissions, a symlink loop, ...) is surfaced rather than treated as "nothing
 *  to migrate here". */
async function checkAccessible(file: string): Promise<Accessible> {
  try {
    await access(file);
    return "yes";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "no";
    return { error: errMsg(e) };
  }
}

async function migrateOptionalFile(file: string, kind: "index" | "benchTruth", result: MigrationResult, opts: RunMigrationOptions): Promise<void> {
  const check = await checkAccessible(file);
  if (check === "yes") {
    await migrateFile(file, kind, result, opts);
  } else if (check !== "no") {
    result.filesScanned++;
    result.errors.push({ file, detail: `cannot access: ${check.error}` });
  }
}

/**
 * Rewrites every `catalog/recipes/*.json` and `catalog/archive/*.json` recipe, `catalog/index.json`,
 * and the bench ground truth file: old `category` -> `course` + `method` (see
 * CATEGORY_TO_COURSE_METHOD). Idempotent — a second run finds nothing left to change, since a
 * migrated object no longer has a `category` field.
 *
 * Every file is written atomically (temp file + rename in the same directory), and every
 * failure — unreadable JSON, an unmapped legacy category, a write that fails partway, an
 * unreadable directory — is collected per file in `errors` rather than aborting the run or
 * leaving a truncated file behind. A migrated object that fails a post-migration shape check
 * (RecipeSchema for recipes/archive, validateCategorizerTruth for the bench file) is still
 * written and reported as a `warning`, not an `error`.
 *
 * `opts.dryRun` computes and reports everything (including what `lines` would say) without
 * writing anything.
 */
export async function runMigration(paths: MigrationPaths, opts: RunMigrationOptions): Promise<MigrationResult> {
  const result: MigrationResult = { filesScanned: 0, filesChanged: 0, skipped: 0, lines: [], errors: [], warnings: [], benchNullMethods: null };
  const recipeFiles = await jsonFilesIn(paths.recipesDir, result);
  const archiveFiles = await jsonFilesIn(paths.archiveDir, result);
  for (const f of [...recipeFiles, ...archiveFiles]) await migrateFile(f, "recipe", result, opts);
  await migrateOptionalFile(paths.indexFile, "index", result, opts);
  await migrateOptionalFile(paths.benchTruthFile, "benchTruth", result, opts);
  return result;
}

export function renderMigrationTable(result: MigrationResult): string {
  const out = [`scanned ${result.filesScanned} file(s), changed ${result.filesChanged}, skipped ${result.skipped} (already migrated / no category field)`];
  if (result.lines.length) out.push("", ...result.lines.map((l) => `  ${l.file}: ${l.detail}`));
  else out.push("(nothing to migrate — already up to date)");
  if (result.benchNullMethods) {
    const { total, withNullMethod } = result.benchNullMethods;
    out.push(
      "",
      `bench truth: ${withNullMethod}/${total} row(s) have method: null — the old category value never named a cooking method for` +
        " these, so they need to be re-labelled by hand before the categorizer bench's method rate means anything.",
    );
  }
  if (result.warnings.length) out.push("", "warnings:", ...result.warnings.map((w) => `  ${w.file}: ${w.detail}`));
  if (result.errors.length) out.push("", "errors:", ...result.errors.map((e) => `  ${e.file}: ${e.detail}`));
  return out.join("\n");
}
