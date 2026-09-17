import { flagsFromVerification } from "../agents/verifier.js";
import { formatCost } from "../llm/usage.js";
import { REPORT_CSS } from "../orchestrator/report-html-css.js";
import { escapeHtml } from "../orchestrator/report-html.js";
import { jaccard, type CategorizerCase } from "./categorizer.js";
import { segmentKey } from "./inputs.js";
import { MODIFIES_EXISTING, PLANTED_KINDS } from "./mutations.js";
import type { BenchResult, PlannedSegment, VariantUsage } from "./run.js";
import { formatProportion as prop } from "./stats.js";
import { targetStatus, type KindScore, type VerifierCase } from "./verifier.js";

type CategorizerResult = Extract<BenchResult, { agent: "categorizer" }>;
type VerifierResult = Extract<BenchResult, { agent: "verifier" }>;

function num(x: number | null, digits = 2): string {
  return x === null ? "—" : x.toFixed(digits);
}

function ms(x: number | null): string {
  return x === null ? "—" : `${(x / 1000).toFixed(1)}s`;
}

function totalCost(usage: Record<string, VariantUsage>): number | null {
  return Object.values(usage).reduce<number | null>((sum, u) => (sum === null || u.costUsd === null ? null : sum + u.costUsd), 0);
}

interface VariantSummary {
  variant: string;
  cases: number;
  errors: number;
  meanLatencyMs: number | null;
}

function summaries(result: BenchResult): VariantSummary[] {
  return result.agent === "categorizer" ? result.scores.variants : result.scores;
}

function firstErrors(result: BenchResult): Map<string, { count: number; first: string }> {
  const out = new Map<string, { count: number; first: string }>();
  for (const c of result.cases as Array<{ variant: string; ok: boolean; error?: string }>) {
    if (c.ok) continue;
    const e = out.get(c.variant);
    out.set(c.variant, e ? { ...e, count: e.count + 1 } : { count: 1, first: c.error ?? "" });
  }
  return out;
}

function usageLine(result: BenchResult, s: VariantSummary): string {
  const u = result.usage[s.variant];
  return `ok ${s.cases - s.errors} · err ${s.errors}${s.errors ? " (!)" : ""} · ${u.calls} calls · ${u.input.toLocaleString("en-US")} in / ${u.output.toLocaleString("en-US")} out · ${formatCost(u.costUsd)} · latency ${ms(s.meanLatencyMs)}`;
}

function kindLine(k: KindScore): string {
  return `${prop(k.detection)}  missing ${k.missing} · vouched ${k.supported} · errors ${k.errors} · excluded ${k.excluded}`;
}

export function renderBenchConsole(result: BenchResult): string {
  const out: string[] = [];
  const errors = firstErrors(result);
  const row = (label: string, value: string) => `  ${label.padEnd(22)} ${value}`;
  for (const s of summaries(result)) {
    out.push(`${s.variant}  ${usageLine(result, s)}`);
    if (result.agent === "categorizer") {
      const c = result.scores.variants.find((x) => x.variant === s.variant)!;
      out.push(row("cuisine", prop(c.cuisine)), row("category", prop(c.category)), row("meal types exact", prop(c.mealTypesExact)), row("meal types jaccard", num(c.mealTypesJaccard)), row("dishKey stable", c.dishKeyStability ? prop(c.dishKeyStability) : "— (needs --repeat 2+)"));
    } else {
      const v = result.scores.find((x) => x.variant === s.variant)!;
      out.push(row("detected (all kinds)", kindLine(v.overall)));
      for (const kind of PLANTED_KINDS) out.push(row(`  ${kind}`, kindLine(v.detection[kind])));
      out.push(row("false positives", `ingredients ${prop(v.falsePositives.ingredients)} · steps ${prop(v.falsePositives.steps)}`));
      out.push(row("clean flags / noise", `${num(v.cleanFlagsMean)} per clean draft · ${num(v.noiseMean)} extra per mutated draft`));
    }
    const e = errors.get(s.variant);
    if (e) out.push(`  !! ${e.count} failed (counted as misses), first error: ${e.first}`);
  }
  out.push(`total ${formatCost(totalCost(result.usage))}`);
  if (result.agent === "categorizer" && result.scores.agreement.length) {
    out.push("dishKey agreement (first answer per segment):");
    for (const a of result.scores.agreement) out.push(`  ${a.a} vs ${a.b}: ${prop(a.agreement)}`);
  }
  return out.join("\n");
}

const BENCH_CSS = `
  .miss { color: var(--red); font-weight: 600; }
  .hit { color: var(--green); }
  .warn { color: var(--amber); font-weight: 600; }
  .err { color: var(--red); font-size: 12px; }
  tr.has-errors td:nth-child(2) { color: var(--red); font-weight: 700; }
  .answers > div, .bench td:first-child, .bench th { white-space: nowrap; }
  .scroll { overflow-x: auto; }
  code { font-size: 12px; }
`;

/** Cells are HTML: callers escape text themselves. */
function table(head: string[], rows: Array<{ cells: string[]; cls?: string }>): string {
  return `<div class="scroll"><table class="bench"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const e = escapeHtml;

function mark(text: string, ok: boolean): string {
  return ok ? e(text) : `<span class="miss">${e(text)}</span>`;
}

function segmentCell(s: PlannedSegment): string {
  return `${e(segmentKey(s))}<div class="meta">${e(s.label?.dish ?? s.workingName)}</div>`;
}

function usageCells(result: BenchResult, s: VariantSummary): string[] {
  const u = result.usage[s.variant];
  return [String(u.calls), u.input.toLocaleString("en-US"), u.output.toLocaleString("en-US"), e(formatCost(u.costUsd)), ms(s.meanLatencyMs)];
}
const USAGE_HEAD = ["calls", "in", "out", "$", "latency"];

function categorizerSections(result: CategorizerResult): string {
  const variants = table(
    ["variant", "ok/err", "cuisine", "category", "meals exact", "meals J", "dishKey stable", ...USAGE_HEAD],
    result.scores.variants.map((s) => ({
      cls: s.errors ? "has-errors" : undefined,
      cells: [e(s.variant), `${s.cases - s.errors}/${s.errors}`, prop(s.cuisine), prop(s.category), prop(s.mealTypesExact), num(s.mealTypesJaccard), s.dishKeyStability ? prop(s.dishKeyStability) : "—", ...usageCells(result, s)],
    })),
  );
  const agreement = result.scores.agreement.length
    ? `<h2>dishKey agreement between variants</h2><p class="meta">Informational: share of segments where both variants' first successful answer used the same dishKey.</p>${table(
        ["variant", "variant", "agreement"],
        result.scores.agreement.map((a) => ({ cells: [e(a.a), e(a.b), prop(a.agreement)] })),
      )}`
    : "";
  const rows = result.segments.map((s) => {
    const t = s.label!;
    const cells = result.variants.map((v) => {
      const mine = result.cases.filter((c): c is CategorizerCase => c.variant === v.id && segmentKey(c) === segmentKey(s)).sort((a, b) => a.repeat - b.repeat);
      return `<div class="answers">${mine
        .map((c) => {
          if (!c.ok) return `<div class="err">error: ${e(c.error)}</div>`;
          const o = c.output;
          const cuisine = c.rawCuisine === o.cuisine ? c.rawCuisine : `${c.rawCuisine}→${o.cuisine}`;
          return `<div>${mark(cuisine, c.rawCuisine === t.cuisine)} · ${mark(o.category, o.category === t.category)} · ${mark(o.mealTypes.join("+"), jaccard(o.mealTypes, t.mealTypes) === 1)} · <code>${e(o.dishKey)}</code></div>`;
        })
        .join("")}</div>`;
    });
    return { cells: [segmentCell(s), e(`${t.cuisine} · ${t.category} · ${t.mealTypes.join("+")}`), ...cells] };
  });
  return `<h2>Variants</h2>
  <p class="meta">Every rate counts a failed call as a miss and shows hits/total with a 95% Wilson interval. Cuisine is scored on the model's raw answer, before an unknown cuisine becomes "other".</p>
  ${variants}${agreement}
  <h2>Per segment</h2><p class="meta">cuisine · category · meal types · dishKey, one line per repeat; mismatches with the label in red.</p>
  ${table(["segment", "truth", ...result.variants.map((v) => v.id)], rows)}`;
}

function verifierSections(result: VerifierResult): string {
  const variants = table(
    ["variant", "ok/err", "detected", "omitted", "false pos. ingredients", "false pos. steps", "clean flags", "noise", ...USAGE_HEAD],
    result.scores.map((s) => ({
      cls: s.errors ? "has-errors" : undefined,
      cells: [e(s.variant), `${s.cases - s.errors}/${s.errors}`, prop(s.overall.detection), String(s.overall.missing), prop(s.falsePositives.ingredients), prop(s.falsePositives.steps), num(s.cleanFlagsMean), num(s.noiseMean), ...usageCells(result, s)],
    })),
  );
  const byKind = table(
    ["variant", "kind", "detected (rejected)", "omitted", "vouched for", "errors", "excluded"],
    result.scores.flatMap((s) =>
      PLANTED_KINDS.map((kind) => {
        const k = s.detection[kind];
        return { cells: [e(s.variant), e(kind), prop(k.detection), String(k.missing), String(k.supported), String(k.errors), String(k.excluded)] };
      }),
    ),
  );

  const rows = result.segments.flatMap((s) =>
    (s.mutations ?? []).map((m) => {
      const cells = result.variants.map((v) => {
        const all = result.cases.filter((c): c is VerifierCase => c.variant === v.id && segmentKey(c) === segmentKey(s));
        const clean = new Map(all.filter((c) => c.mutation === "clean" && c.ok).map((c) => [c.repeat, c]));
        return all
          .filter((c) => c.mutation === m.kind)
          .sort((a, b) => a.repeat - b.repeat)
          .map((c) => {
            if (!c.ok) return `<div class="err">error: ${e(c.error)}</div>`;
            const flags = flagsFromVerification(c.draft, c.verification);
            const title = e(flags.map((f) => `${f.kind} ${f.ref}`).join(", ") || "no flags");
            if (!c.target) return `<div title="${title}">${flags.length} flag${flags.length === 1 ? "" : "s"}</div>`;
            const cleanRun = clean.get(c.repeat);
            const cleanKeys = new Set(cleanRun && cleanRun.ok ? flagsFromVerification(cleanRun.draft, cleanRun.verification).map((f) => `${f.kind}:${f.ref}`) : []);
            const targetKey = `${c.target.kind}:${c.target.ref}`;
            let label: string;
            if (MODIFIES_EXISTING.has(c.mutation) && cleanKeys.has(targetKey)) label = `<span class="meta">pre-flagged (excluded)</span>`;
            else {
              const st = targetStatus(c.target, c.verification);
              label = st === "rejected" ? `<span class="hit">rejected</span>` : st === "missing" ? `<span class="warn">omitted</span>` : `<span class="miss">vouched for</span>`;
            }
            const noise = flags.filter((f) => `${f.kind}:${f.ref}` !== targetKey && !cleanKeys.has(`${f.kind}:${f.ref}`)).length;
            return `<div title="${title}">${label}${noise ? ` <span class="meta">+${noise} noise</span>` : ""}</div>`;
          })
          .join("");
      });
      return { cells: [segmentCell(s), e(m.kind), e(m.detail), ...cells] };
    }),
  );
  return `<h2>Variants</h2>
  <p class="meta">Detected means the verifier returned the planted item with supported:false; an omitted entry is shown apart and does not count. Failed calls count as misses. Changed items already flagged on the same repeat's clean draft are excluded. Rates show hits/total and a 95% Wilson interval.</p>
  ${variants}
  <h2>Detection by kind</h2>${byKind}
  <h2>Per case</h2><p class="meta">One line per repeat. "+N noise" counts flags on untouched items not raised on the same repeat's clean draft; hover a cell for all flags.</p>
  ${table(["segment", "draft", "planted", ...result.variants.map((v) => v.id)], rows)}`;
}

export function renderBenchHtml(result: BenchResult): string {
  const calls = Object.values(result.usage).reduce((n, u) => n + u.calls, 0);
  const lists = [
    result.truthErrors.length ? `<h2>Ignored ground-truth rows</h2><ul class="plain">${result.truthErrors.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : "",
    result.skipped.length ? `<h2>Skipped</h2><ul class="plain">${result.skipped.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : "",
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kambuz bench ${e(result.agent)} ${e(result.startedAt)}</title>
<style>${REPORT_CSS}${BENCH_CSS}</style>
</head>
<body>
  <h1>Kambuz bench: ${e(result.agent)}</h1>
  <p class="meta">Started ${e(result.startedAt)} · finished ${e(result.finishedAt)} · ${result.repeat} repeat${result.repeat === 1 ? "" : "s"}</p>
  <div class="tiles">
    <div class="tile"><div class="n">${result.variants.length}</div><div class="label">variants</div></div>
    <div class="tile"><div class="n">${result.segments.length}</div><div class="label">segments</div></div>
    <div class="tile"><div class="n">${result.cases.length}</div><div class="label">cases</div></div>
    <div class="tile"><div class="n">${calls}</div><div class="label">API calls</div></div>
    <div class="tile cost"><div class="n">${formatCost(totalCost(result.usage))}</div><div class="label">total cost</div></div>
  </div>
  ${result.agent === "categorizer" ? categorizerSections(result) : verifierSections(result)}
  ${lists}
</body>
</html>`;
}
