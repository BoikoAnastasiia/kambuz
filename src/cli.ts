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

export const USAGE =
  "usage: kambuz ingest <video-or-playlist-url> [--force] [--only-stage scout|extract|verify|categorize]\n" +
  "  --only-stage <stage>  re-run that stage and everything downstream of it (does not re-fetch captions)\n" +
  "  --force               re-run every agent stage (does not re-fetch captions)";

const STAGES = ["scout", "extract", "verify", "categorize"] as const;
type Stage = (typeof STAGES)[number];

export type ParsedArgs =
  | { ok: true; url: string; force: boolean; onlyStage?: Stage }
  | { ok: false; error: string };

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let positionals: string[];
  let values: { force?: boolean; "only-stage"?: string };
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        force: { type: "boolean", default: false },
        "only-stage": { type: "string" },
      },
    }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const [command, url] = positionals;
  if (command !== "ingest" || !url) {
    return { ok: false, error: "expected: kambuz ingest <url>" };
  }
  if (positionals.length > 2) {
    return { ok: false, error: `unexpected extra argument(s): ${positionals.slice(2).join(" ")}` };
  }
  const onlyStageRaw = values["only-stage"];
  if (onlyStageRaw !== undefined && !isStage(onlyStageRaw)) {
    return { ok: false, error: `--only-stage must be one of: ${STAGES.join(", ")} (got "${onlyStageRaw}")` };
  }
  return { ok: true, url, force: values.force ?? false, onlyStage: onlyStageRaw };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file — the API key may already be in the environment
  }

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
  const opts: IngestOptions = { force: parsed.force, onlyStage: parsed.onlyStage };

  const report = await ingest(parsed.url, deps, opts);
  await mkdir(config.paths.reports, { recursive: true });
  const file = path.join(config.paths.reports, `${report.startedAt.replace(/[:.]/g, "-")}.md`);
  const rendered = renderReport(report);
  await writeFile(file, rendered);
  console.log(rendered);
  console.log(`\nreport: ${file}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
