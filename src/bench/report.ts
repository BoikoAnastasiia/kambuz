import { formatCost } from "../llm/usage.js";
import { REPORT_CSS } from "../orchestrator/report-html-css.js";
import { escapeHtml } from "../orchestrator/report-html.js";
import { jaccard, type CategorizerCase } from "./categorizer.js";
import { segmentKey } from "./inputs.js";
import { PLANTED_KINDS } from "./mutations.js";
import type { BenchResult, PlannedSegment, VariantUsage } from "./run.js";
import { isDetected, type VerifierCase } from "./verifier.js";

export function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

function num(x: number | null, digits = 2): string {
  return x === null ? "—" : x.toFixed(digits);
}

function ms(x: number | null): string {
  return x === null ? "—" : `${(x / 1000).toFixed(1)}s`;
}

function totalCost(usage: Record<string, VariantUsage>): number | null {
  return Object.values(usage).reduce<number | null>((sum, u) => (sum === null || u.costUsd === null ? null : sum + u.costUsd), 0);
}

/** Header + rows of a table, one row per variant, shared by the console and HTML renderers. */
function variantTable(result: BenchResult): { head: string[]; rows: string[][] } {
  const usageCols = (id: string) => {
    const u = result.usage[id];
    return [String(u.calls), u.input.toLocaleString("en-US"), u.output.toLocaleString("en-US"), formatCost(u.costUsd)];
  };
  const usageHead = ["calls", "in", "out", "$", "latency"];
  if (result.agent === "categorizer") {
    return {
      head: ["variant", "ok/err", "cuisine", "category", "meals =", "meals J", "dishKey stable", ...usageHead],
      rows: result.scores.variants.map((s) => {
        const [calls, input, output, cost] = usageCols(s.variant);
        return [s.variant, `${s.cases - s.errors}/${s.errors}`, pct(s.cuisineAccuracy), pct(s.categoryAccuracy), pct(s.mealTypesExact), num(s.mealTypesJaccard), pct(s.dishKeyStability), calls, input, output, cost, ms(s.meanLatencyMs)];
      }),
    };
  }
  return {
    head: ["variant", "ok/err", ...PLANTED_KINDS, "detected", "clean flags", "noise", ...usageHead],
    rows: result.scores.map((s) => {
      const [calls, input, output, cost] = usageCols(s.variant);
      const kinds = PLANTED_KINDS.map((k) => `${pct(s.detection[k].rate)} (${s.detection[k].detected}/${s.detection[k].total})`);
      return [s.variant, `${s.cases - s.errors}/${s.errors}`, ...kinds, pct(s.overallDetection), num(s.cleanFlagsMean), num(s.noiseMean), calls, input, output, cost, ms(s.meanLatencyMs)];
    }),
  };
}

export function renderBenchConsole(result: BenchResult): string {
  const { head, rows } = variantTable(result);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const out = [line(head), ...rows.map(line), `total ${formatCost(totalCost(result.usage))}`];
  for (const v of result.variants) {
    const failed = (result.cases as Array<{ variant: string; ok: boolean; error?: string }>).filter((c) => c.variant === v.id && !c.ok);
    if (failed.length) out.push(`${v.id}: ${failed.length} failed, first error: ${failed[0].error}`);
  }
  if (result.agent === "categorizer" && result.scores.agreement.length) {
    out.push("dishKey agreement (first answer per segment):");
    for (const a of result.scores.agreement) out.push(`  ${a.a} vs ${a.b}: ${pct(a.rate)} of ${a.segments}`);
  }
  return out.join("\n");
}

const BENCH_CSS = `
  .miss { color: var(--red); font-weight: 600; }
  .hit { color: var(--green); }
  .err { color: var(--red); font-size: 12px; }
  .answers > div, .bench td:first-child, .bench th { white-space: nowrap; }
  .scroll { overflow-x: auto; }
  code { font-size: 12px; }
`;

function table(head: string[], rows: string[][], rawCells = false): string {
  const cell = (c: string) => (rawCells ? c : escapeHtml(c));
  return `<div class="scroll"><table class="bench"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function mark(text: string, ok: boolean): string {
  return ok ? escapeHtml(text) : `<span class="miss">${escapeHtml(text)}</span>`;
}

function segmentCell(s: PlannedSegment): string {
  return `${escapeHtml(segmentKey(s))}<div class="meta">${escapeHtml(s.label?.dish ?? s.workingName)}</div>`;
}

function categorizerSegments(result: Extract<BenchResult, { agent: "categorizer" }>): string {
  const head = ["segment", "truth", ...result.variants.map((v) => v.id)];
  const rows = result.segments.map((s) => {
    const t = s.label!;
    const cells = result.variants.map((v) => {
      const mine = result.cases.filter((c): c is CategorizerCase => c.variant === v.id && segmentKey(c) === segmentKey(s)).sort((a, b) => a.repeat - b.repeat);
      return `<div class="answers">${mine
        .map((c) => {
          if (!c.ok) return `<div class="err">error: ${escapeHtml(c.error)}</div>`;
          const o = c.output;
          return `<div>${mark(o.cuisine, o.cuisine === t.cuisine)} · ${mark(o.category, o.category === t.category)} · ${mark(o.mealTypes.join("+"), jaccard(o.mealTypes, t.mealTypes) === 1)} · <code>${escapeHtml(o.dishKey)}</code></div>`;
        })
        .join("")}</div>`;
    });
    return [segmentCell(s), escapeHtml(`${t.cuisine} · ${t.category} · ${t.mealTypes.join("+")}`), ...cells];
  });
  const agreement = result.scores.agreement.length
    ? `<h2>dishKey agreement between variants</h2><p class="meta">Informational: share of segments where both variants' first successful answer used the same dishKey.</p>${table(
        ["variant", "variant", "segments", "agreement"],
        result.scores.agreement.map((a) => [a.a, a.b, String(a.segments), pct(a.rate)]),
      )}`
    : "";
  return `${agreement}<h2>Per segment</h2><p class="meta">cuisine · category · meal types · dishKey, one line per repeat; mismatches with the label in red.</p>${table(head, rows, true)}`;
}

function verifierCases(result: Extract<BenchResult, { agent: "verifier" }>): string {
  const head = ["segment", "draft", "planted", ...result.variants.map((v) => v.id)];
  const rows = result.segments.flatMap((s) =>
    (s.mutations ?? []).map((m) => {
      const cells = result.variants.map((v) => {
        const mine = result.cases
          .filter((c): c is VerifierCase => c.variant === v.id && segmentKey(c) === segmentKey(s) && c.mutation === m.kind)
          .sort((a, b) => a.repeat - b.repeat);
        return mine
          .map((c) => {
            if (!c.ok) return `<div class="err">error: ${escapeHtml(c.error)}</div>`;
            const flags = c.flags.map((f) => `${f.kind} ${f.ref}`).join(", ");
            const title = escapeHtml(flags || "no flags");
            if (!c.target) return `<div title="${title}">${c.flags.length} flag${c.flags.length === 1 ? "" : "s"}</div>`;
            const found = isDetected(c.target, c.flags);
            const others = c.flags.length - (found ? 1 : 0);
            return `<div title="${title}">${found ? `<span class="hit">flagged</span>` : `<span class="miss">missed</span>`}${others ? ` <span class="meta">+${others} other</span>` : ""}</div>`;
          })
          .join("");
      });
      return [segmentCell(s), escapeHtml(m.kind), escapeHtml(m.detail), ...cells];
    }),
  );
  return `<h2>Per case</h2><p class="meta">One line per repeat. "+N other" counts every other flag on that draft, including ones the variant also raised on the clean draft; hover a cell for the flags.</p>${table(head, rows, true)}`;
}

export function renderBenchHtml(result: BenchResult): string {
  const { head, rows } = variantTable(result);
  const calls = Object.values(result.usage).reduce((n, u) => n + u.calls, 0);
  const lists = [
    result.truthErrors.length ? `<h2>Ignored ground-truth rows</h2><ul class="plain">${result.truthErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "",
    result.skipped.length ? `<h2>Skipped</h2><ul class="plain">${result.skipped.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "",
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kambuz bench ${escapeHtml(result.agent)} ${escapeHtml(result.startedAt)}</title>
<style>${REPORT_CSS}${BENCH_CSS}</style>
</head>
<body>
  <h1>Kambuz bench: ${escapeHtml(result.agent)}</h1>
  <p class="meta">Started ${escapeHtml(result.startedAt)} · finished ${escapeHtml(result.finishedAt)} · ${result.repeat} repeat${result.repeat === 1 ? "" : "s"}</p>
  <div class="tiles">
    <div class="tile"><div class="n">${result.variants.length}</div><div class="label">variants</div></div>
    <div class="tile"><div class="n">${result.segments.length}</div><div class="label">segments</div></div>
    <div class="tile"><div class="n">${result.cases.length}</div><div class="label">cases</div></div>
    <div class="tile"><div class="n">${calls}</div><div class="label">API calls</div></div>
    <div class="tile cost"><div class="n">${formatCost(totalCost(result.usage))}</div><div class="label">total cost</div></div>
  </div>
  <h2>Variants</h2>
  <p class="meta">Rates are over successful calls; ok/err counts cases. Latency is the mean wall time of a successful case, parse retries included.</p>
  ${table(head, rows)}
  ${result.agent === "categorizer" ? categorizerSegments(result) : verifierCases(result)}
  ${lists}
</body>
</html>`;
}
