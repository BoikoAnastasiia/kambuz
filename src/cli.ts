import "./env.js"; // loads .env — must come before anything that reads process.env
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLlmClient } from "./llm/client.js";
import { UsageLedger } from "./llm/usage.js";
import { loadVocab } from "./vocab/load.js";
import { StageCache } from "./orchestrator/cache.js";
import { Catalog } from "./orchestrator/catalog.js";
import { ingest, type IngestOptions } from "./orchestrator/run.js";
import { renderReport } from "./orchestrator/report.js";
import { runEval, renderEval } from "./eval/run.js";

export const USAGE =
  "usage: kambuz ingest <video-or-playlist-url> [--force] [--only-stage scout|extract|verify|categorize]\n" +
  "       kambuz eval [--force] [--ingest] [--only-stage scout|extract|verify|categorize]\n" +
  "  --only-stage <stage>  re-run that stage and everything downstream of it (does not re-fetch captions)\n" +
  "                         (eval only: requires --ingest)\n" +
  "  --force               re-run every agent stage (does not re-fetch captions)\n" +
  "  --ingest              (eval only) runs the pipeline for each case's video first (calls the API for\n" +
  "                         uncached videos); without it, eval only reads the existing catalog.";

const STAGES = ["scout", "extract", "verify", "categorize"] as const;
type Stage = (typeof STAGES)[number];

export type ParsedArgs =
  | { ok: true; command: "ingest"; url: string; force: boolean; onlyStage?: Stage }
  | { ok: true; command: "eval"; force: boolean; ingest: boolean; onlyStage?: Stage }
  | { ok: false; error: string };

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let positionals: string[];
  let values: { force?: boolean; "only-stage"?: string; ingest?: boolean };
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        force: { type: "boolean", default: false },
        "only-stage": { type: "string" },
        ingest: { type: "boolean", default: false },
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
    return { ok: true, command: "ingest", url, force: values.force ?? false, onlyStage: onlyStageRaw };
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

  return { ok: false, error: "expected: kambuz ingest <url> | kambuz eval" };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const ledger = new UsageLedger();
  const deps = {
    config,
    llm: createLlmClient(config, ledger),
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(config.paths.cache),
    catalog: new Catalog(config.paths.catalog),
    usageText: () => ledger.toString(),
  };

  switch (parsed.command) {
    case "ingest": {
      const opts: IngestOptions = { force: parsed.force, onlyStage: parsed.onlyStage };
      const report = await ingest(parsed.url, deps, opts);
      await mkdir(config.paths.reports, { recursive: true });
      const file = path.join(config.paths.reports, `${report.startedAt.replace(/[:.]/g, "-")}.md`);
      const rendered = renderReport(report);
      await writeFile(file, rendered);
      console.log(rendered);
      console.log(`\nreport: ${file}`);
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
