import { appendFile, readFile } from "node:fs/promises";
import type { UsageRow } from "../llm/usage.js";
import { totalCostUsd } from "../orchestrator/report.js";

export interface SpendEntry {
  at: string;
  source: string;
  costUsd: number | null;
  calls: number;
  input: number;
  output: number;
}

export interface SpendSummary {
  totalUsd: number;
  runs: number;
  unknownRuns: number;
}

/**
 * Pure: sums cost across the lines of a spend.jsonl file's content (one JSON object per
 * line — see spendEntry() below). A run whose cost is unknown (an unpriced model) counts
 * as 0 toward the total but is tallied separately in unknownRuns, so it can be flagged
 * rather than silently treated as a free run. Blank or unparsable lines are skipped.
 */
export function sumSpend(raw: string): SpendSummary {
  let totalUsd = 0;
  let runs = 0;
  let unknownRuns = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Partial<SpendEntry>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    runs++;
    if (entry.costUsd === null || entry.costUsd === undefined) unknownRuns++;
    else totalUsd += entry.costUsd;
  }
  return { totalUsd, runs, unknownRuns };
}

export function spendEntry(at: string, source: string, rows: UsageRow[]): SpendEntry {
  const totals = rows.reduce(
    (acc, r) => ({ calls: acc.calls + r.calls, input: acc.input + r.input, output: acc.output + r.output }),
    { calls: 0, input: 0, output: 0 },
  );
  return { at, source, costUsd: totalCostUsd(rows), ...totals };
}

export async function appendSpend(filePath: string, entry: SpendEntry): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

/** Reads and sums spend.jsonl; a missing file (no runs yet) summarizes as zero spend. */
export async function readSpendTotal(filePath: string): Promise<SpendSummary> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // no spend.jsonl yet — treat as empty
  }
  return sumSpend(raw);
}
