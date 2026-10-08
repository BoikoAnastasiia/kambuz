import "./env.js"; // loads .env — must come before anything that reads process.env
import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { createLlmClient } from "./llm/client.js";
import { UsageLedger, formatCost } from "./llm/usage.js";
import { loadVocab } from "./vocab/load.js";
import { StageCache } from "./orchestrator/cache.js";
import { Catalog, MirroredCatalog, type CatalogStore } from "./orchestrator/catalog.js";
import { connectDb } from "./db/mongo.js";
import { MongoCatalog } from "./db/mongoCatalog.js";
import { importCatalog, recordVideos, syncVocab } from "./db/sync.js";
import { requeueAbandoned, workLoop } from "./db/worker.js";
import { ingest, type IngestOptions } from "./orchestrator/run.js";
import { renderReport, totalCostUsd } from "./orchestrator/report.js";
import { renderReportHtml } from "./orchestrator/report-html.js";
import { spendEntry, appendSpend, readSpendTotal, spendSuffix } from "./cli/spend.js";
import { runEval, renderEval } from "./eval/run.js";
import { createProgressRenderer } from "./cli/progress.js";
import { BENCH_AGENTS, benchCommand, rescoreCommand, type BenchAgent } from "./bench/run.js";
import { parseVariants, type Variant } from "./bench/variants.js";

export const USAGE =
  "usage: kambuz ingest <video-or-playlist-url> [--force] [--only-stage scout|extract|verify|categorize] [--quiet] [--open]\n" +
  "       kambuz eval [--force] [--ingest] [--only-stage scout|extract|verify|categorize]\n" +
  "       kambuz bench <categorizer|verifier> --models <model[:effort],...> [--repeat N] [--yes] [--open]\n" +
  "       kambuz bench rescore <bench-report.json> [--open]\n" +
  "       kambuz db-import   copy the JSON catalog and vocab into MongoDB (needs MONGODB_URI)\n" +
  "       kambuz worker      run the site's queued add-video jobs until stopped (needs MONGODB_URI)\n" +
  "  --only-stage <stage>  re-run that stage and everything downstream of it (does not re-fetch captions)\n" +
  "                         (eval only: requires --ingest)\n" +
  "  --force               re-run every agent stage (does not re-fetch captions)\n" +
  "  --quiet               (ingest only) don't draw the live per-video progress tree, just print the final report\n" +
  "  --open                (ingest, bench) open the HTML report when the run finishes\n" +
  "  --ingest              (eval only) runs the pipeline for each case's video first (calls the API for\n" +
  "                         uncached videos); without it, eval only reads the existing catalog.\n" +
  "  --models <list>       (bench) comma-separated variants, e.g. claude-sonnet-5,claude-sonnet-5:low\n" +
  "  --repeat <n>          (bench) run every case n times (default 1)\n" +
  "  --yes                 (bench) actually make the calls; without it bench only prints the plan";

/** Best-effort: opening the report is a convenience, never a reason to fail the run. */
function openInBrowser(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [filePath], (err) => {
      if (err) console.error(`warning: could not open ${filePath}: ${err.message}`);
      resolve();
    });
  });
}

export const MISSING_MONGODB_URI =
  "MONGODB_URI is not set. Add your MongoDB Atlas connection string to .env, e.g. MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/kambuz";

export const MISSING_API_KEY =
  "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.";

/** Checked before any client is constructed, so a first run says what to do instead of throwing. */
export function apiKeyError(env: NodeJS.ProcessEnv): string | null {
  return env.ANTHROPIC_API_KEY?.trim() ? null : MISSING_API_KEY;
}

const STAGES = ["scout", "extract", "verify", "categorize"] as const;
type Stage = (typeof STAGES)[number];

export type ParsedArgs =
  | { ok: true; command: "ingest"; url: string; force: boolean; onlyStage?: Stage; quiet: boolean; open: boolean }
  | { ok: true; command: "eval"; force: boolean; ingest: boolean; onlyStage?: Stage }
  | { ok: true; command: "bench"; agent: BenchAgent; variants: Variant[]; repeat: number; yes: boolean; open: boolean }
  | { ok: true; command: "bench-rescore"; file: string; open: boolean }
  | { ok: true; command: "db-import" | "worker" }
  | { ok: false; error: string };

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let positionals: string[];
  let values: { force?: boolean; "only-stage"?: string; ingest?: boolean; quiet?: boolean; open?: boolean; models?: string; repeat?: string; yes?: boolean };
  // npm forwards the "--" of `npm run eval -- --ingest` in some setups; left in place it
  // turns every later flag into a positional and the run dies with the usage text.
  const args = argv.filter((a) => a !== "--");
  try {
    ({ positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        force: { type: "boolean", default: false },
        "only-stage": { type: "string" },
        ingest: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        models: { type: "string" },
        repeat: { type: "string" },
        yes: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const [command, url] = positionals;

  if (command === "ingest") {
    if (!url) {
      return { ok: false, error: "expected: kambuz ingest <url>" };
    }
    if (positionals.length > 2) {
      return { ok: false, error: `unexpected extra argument(s): ${positionals.slice(2).join(" ")}` };
    }
    const onlyStageRaw = values["only-stage"];
    if (onlyStageRaw !== undefined && !isStage(onlyStageRaw)) {
      return { ok: false, error: `--only-stage must be one of: ${STAGES.join(", ")} (got "${onlyStageRaw}")` };
    }
    return { ok: true, command: "ingest", url, force: values.force ?? false, onlyStage: onlyStageRaw, quiet: values.quiet ?? false, open: values.open ?? false };
  }

  if (command === "eval") {
    if (positionals.length > 1) {
      return { ok: false, error: `unexpected extra argument(s): ${positionals.slice(1).join(" ")}` };
    }
    const ingestFlag = values.ingest ?? false;
    const onlyStageRaw = values["only-stage"];
    let onlyStage: Stage | undefined;
    if (onlyStageRaw !== undefined) {
      if (!isStage(onlyStageRaw)) {
        return { ok: false, error: `--only-stage must be one of: ${STAGES.join(", ")} (got "${onlyStageRaw}")` };
      }
      if (!ingestFlag) {
        return { ok: false, error: "--only-stage requires --ingest for the eval command" };
      }
      onlyStage = onlyStageRaw;
    }
    return { ok: true, command: "eval", force: values.force ?? false, ingest: ingestFlag, onlyStage };
  }

  if (command === "bench" && positionals[1] === "rescore") {
    if (positionals.length !== 3) return { ok: false, error: "expected: kambuz bench rescore <bench-report.json>" };
    return { ok: true, command: "bench-rescore", file: positionals[2], open: values.open ?? false };
  }

  if (command === "bench") {
    const agent = positionals[1];
    if (!agent || !(BENCH_AGENTS as readonly string[]).includes(agent)) {
      return { ok: false, error: `expected: kambuz bench <${BENCH_AGENTS.join("|")}> --models <model[:effort],...>` };
    }
    if (positionals.length > 2) {
      return { ok: false, error: `unexpected extra argument(s): ${positionals.slice(2).join(" ")}` };
    }
    if (values.models === undefined) return { ok: false, error: "bench needs --models, e.g. --models claude-sonnet-5,claude-sonnet-5:low" };
    const variants = parseVariants(values.models);
    if (!variants.ok) return { ok: false, error: variants.error };
    const repeatRaw = values.repeat ?? "1";
    if (!/^\d+$/.test(repeatRaw.trim()) || Number(repeatRaw) < 1) {
      return { ok: false, error: `--repeat must be a whole number of at least 1 (got "${repeatRaw}")` };
    }
    return { ok: true, command: "bench", agent: agent as BenchAgent, variants: variants.variants, repeat: Number(repeatRaw), yes: values.yes ?? false, open: values.open ?? false };
  }

  if (command === "db-import" || command === "worker") {
    if (positionals.length > 1) return { ok: false, error: `unexpected extra argument(s): ${positionals.slice(1).join(" ")}` };
    return { ok: true, command };
  }

  return { ok: false, error: "expected: kambuz ingest <url> | kambuz eval | kambuz bench <agent> | kambuz db-import | kambuz worker" };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (parsed.command === "bench-rescore") {
    // Reads the saved JSON only: no key, no client, no call.
    const { html } = await rescoreCommand(parsed.file, (line) => console.log(line));
    if (parsed.open) await openInBrowser(html);
    return;
  }

  if (parsed.command === "db-import") {
    // Reads files and writes MongoDB: no API key, no model call.
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) {
      console.error(MISSING_MONGODB_URI);
      process.exit(1);
      return;
    }
    const { client, c } = await connectDb(uri);
    try {
      await syncVocab(c, config.paths.vocab);
      const n = await importCatalog(c, config.paths.catalog);
      console.log(`imported ${n.recipes} recipes, ${n.archived} archived versions; ${n.videos} new videos recorded; vocab synced`);
    } finally {
      await client.close();
    }
    return;
  }

  if (parsed.command === "bench") {
    // A dry run needs no key: it builds no client and makes no call.
    const keyError = parsed.yes ? apiKeyError(process.env) : null;
    if (keyError) {
      console.error(keyError);
      process.exit(1);
      return;
    }
    // The bench sets effort per variant; a KAMBUZ_EFFORT_* from .env must not leak into
    // a variant written without one.
    const benchConfig = { ...config, effort: {} };
    let anthropic: Anthropic | undefined;
    const { result, files } = await benchCommand(
      { agent: parsed.agent, variants: parsed.variants, repeat: parsed.repeat, yes: parsed.yes },
      {
        config: benchConfig,
        vocab: await loadVocab(config.paths.vocab),
        // One SDK client shared by every case (each case still gets its own ledger); built on
        // first use, so a dry run never constructs it.
        makeLlm: (ledger) => createLlmClient(benchConfig, ledger, (anthropic ??= new Anthropic())),
      },
      (line) => console.log(line),
      process.stderr.isTTY ? (done, total) => process.stderr.write(`\r${done}/${total} calls${done === total ? "\n" : ""}`) : undefined,
    );
    if (parsed.yes && !result) process.exit(1);
    if (files && parsed.open) await openInBrowser(files.html);
    return;
  }

  const keyError = apiKeyError(process.env);
  if (keyError) {
    console.error(keyError);
    process.exit(1);
    return;
  }

  const mongoUri = process.env.MONGODB_URI?.trim();
  if (parsed.command === "worker" && !mongoUri) {
    console.error(MISSING_MONGODB_URI);
    process.exit(1);
    return;
  }
  // With a database configured, every recipe the pipeline writes to the JSON catalog is
  // copied to MongoDB too, which is what the site reads.
  const mongo = mongoUri && (parsed.command === "ingest" || parsed.command === "worker") ? await connectDb(mongoUri) : null;
  const jsonCatalog = new Catalog(config.paths.catalog);
  const catalog: CatalogStore = mongo ? new MirroredCatalog(jsonCatalog, new MongoCatalog(mongo.c)) : jsonCatalog;

  const ledger = new UsageLedger();
  const deps = {
    config,
    llm: createLlmClient(config, ledger),
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(config.paths.cache),
    catalog,
    usageText: () => ledger.toString(),
    usageRows: () => ledger.rows(),
  };

  switch (parsed.command) {
    case "ingest": {
      const opts: IngestOptions = { force: parsed.force, onlyStage: parsed.onlyStage };
      const renderer = parsed.quiet ? null : createProgressRenderer(ledger);
      const ingestDeps = renderer ? { ...deps, onEvent: renderer.onEvent } : deps;
      // Runs side by side rather than one after the other: the renderer's finish()
      // only resolves once every video's listr task has been resolved by a
      // video:done event from ingest() itself, so the tree is fully drawn (and
      // torn down) before the report prints below.
      const [report] = await Promise.all([ingest(parsed.url, ingestDeps, opts), renderer?.finish() ?? Promise.resolve()]);
      if (mongo) {
        await recordVideos(mongo.c, report);
        await mongo.client.close();
      }
      await mkdir(config.paths.reports, { recursive: true });
      const stamp = report.startedAt.replace(/[:.]/g, "-");
      const mdFile = path.join(config.paths.reports, `${stamp}.md`);
      const htmlFile = path.join(config.paths.reports, `${stamp}.html`);
      const rendered = renderReport(report);
      await writeFile(mdFile, rendered);

      const spendFile = path.join(config.paths.reports, "spend.jsonl");
      const entry = spendEntry(report.finishedAt || report.startedAt, parsed.url, report.usageRows);
      await appendSpend(spendFile, entry);
      const spendSoFar = await readSpendTotal(spendFile);

      const allRecipes = await deps.catalog.load();
      const writtenRecipes = allRecipes.filter((r) => report.written.includes(r.id));
      const html = renderReportHtml(report, writtenRecipes, spendSoFar.totalUsd, spendSoFar.unknownRuns);
      await writeFile(htmlFile, html);

      console.log(rendered);
      console.log(`\nreport: ${mdFile}`);
      console.log(`html report: ${htmlFile}`);
      const runCost = totalCostUsd(report.usageRows);
      const runCalls = report.usageRows.reduce((n, r) => n + r.calls, 0);
      console.log(`cost ${formatCost(runCost)} · ${runCalls} calls · spent so far ${formatCost(spendSoFar.totalUsd)}${spendSuffix(spendSoFar)}`);

      if (parsed.open) await openInBrowser(htmlFile);
      return;
    }
    case "worker": {
      const { c, client } = mongo!;
      await syncVocab(c, config.paths.vocab);
      const requeued = await requeueAbandoned(c);
      if (requeued) console.log(`worker: put ${requeued} interrupted job(s) back in the queue`);
      const stop = new AbortController();
      const onSignal = () => {
        console.log("worker: stopping after the current job (Ctrl+C again to quit now)");
        stop.abort();
        process.once("SIGINT", () => process.exit(130));
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      console.log("worker: waiting for jobs (Ctrl+C to stop)");
      const spendFile = path.join(config.paths.reports, "spend.jsonl");
      await workLoop(
        {
          c,
          // Each job gets its own ledger, so a job's cost is its own and not a running total.
          runIngest: async (url, onEvent) => {
            const jobLedger = new UsageLedger();
            const report = await ingest(url, { ...deps, llm: createLlmClient(config, jobLedger), usageText: () => jobLedger.toString(), usageRows: () => jobLedger.rows(), onEvent }, {});
            await mkdir(config.paths.reports, { recursive: true });
            await appendSpend(spendFile, spendEntry(report.finishedAt || report.startedAt, url, report.usageRows));
            console.log(`worker: ${url} → ${report.written.length} recipe(s), ${formatCost(totalCostUsd(report.usageRows))}`);
            return report;
          },
        },
        { pollMs: 3000, signal: stop.signal, onJob: (job) => console.log(`worker: starting ${job.url}`) },
      );
      await client.close();
      return;
    }
    case "eval": {
      const rows = await runEval(deps, path.join(config.paths.eval, "cases"), { force: parsed.force, ingest: parsed.ingest, onlyStage: parsed.onlyStage });
      console.log(renderEval(rows));
      process.exit(rows.some((r) => !r.pass) ? 1 : 0);
      return;
    }
    default: {
      console.error(USAGE);
      process.exit(1);
      return;
    }
  }
}

// pathToFileURL, not a `file://` template: it escapes spaces and non-ASCII in the path.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
