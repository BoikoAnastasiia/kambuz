import type { RunReport, VideoStatus } from "./report.js";
import { totalCostUsd } from "./report.js";
import { formatCost, type UsageRow } from "../llm/usage.js";
import type { Recipe, DraftIngredient, Provenance } from "../schemas/recipe.js";
import { REPORT_CSS } from "./report-html-css.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** m:ss under an hour, h:mm:ss past it — used for both step timestamps and the run duration. */
export function formatTimestamp(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function durationLabel(startedAt: string, finishedAt: string): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return formatTimestamp(ms / 1000);
}

function statusInfo(status: VideoStatus): { label: string; cls: string } {
  if (status === "done") return { label: "done", cls: "status-done" };
  if (status === "error") return { label: "error", cls: "status-error" };
  return { label: status, cls: "status-skipped" };
}

function scoreBadge(score: number): string {
  const cls = score >= 0.7 ? "badge-green" : score >= 0.3 ? "badge-amber" : "badge-red";
  return `<span class="badge ${cls}">${score.toFixed(2)}</span>`;
}

function provenanceChip(p: Provenance): string {
  return `<span class="chip chip-${p}">${p}</span>`;
}

function listSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<h2>${escapeHtml(title)}</h2><ul class="plain">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

function idList(ids: string[]): string {
  return ids.length ? `<ul class="plain">${ids.map((id) => `<li>${escapeHtml(id)}</li>`).join("")}</ul>` : `<p class="meta">none</p>`;
}

function usageTable(rows: UsageRow[]): string {
  const total = totalCostUsd(rows);
  // With an unpriced agent the total is unknown; bars then split what is priced, and say so.
  const pricedTotal = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const shareBase = total ?? pricedTotal;
  const totalRow = rows.reduce((acc, r) => ({ calls: acc.calls + r.calls, input: acc.input + r.input, output: acc.output + r.output }), { calls: 0, input: 0, output: 0 });
  const body = rows
    .map((r) => {
      const share = r.costUsd !== null && shareBase > 0 ? (r.costUsd / shareBase) * 100 : 0;
      return `<tr>
        <td>${escapeHtml(r.agent)}</td>
        <td>${r.calls}</td>
        <td>${r.input.toLocaleString("en-US")}</td>
        <td>${r.output.toLocaleString("en-US")}</td>
        <td>${formatCost(r.costUsd)}</td>
        <td><div class="bar"><span style="width:${share.toFixed(1)}%"></span></div></td>
      </tr>`;
    })
    .join("");
  return `<h2>Cost &amp; tokens</h2>
  <table>
    <thead><tr><th>Agent</th><th>Calls</th><th>Input</th><th>Output</th><th>$</th><th>${total === null ? "Share of priced calls" : "Share of cost"}</th></tr></thead>
    <tbody>
      ${body}
      <tr class="total-row"><td>total</td><td>${totalRow.calls}</td><td>${totalRow.input.toLocaleString("en-US")}</td><td>${totalRow.output.toLocaleString("en-US")}</td><td>${formatCost(total)}</td><td></td></tr>
    </tbody>
  </table>`;
}

function videosTable(report: RunReport): string {
  const rows = report.videos
    .map((v) => {
      const { label, cls } = statusInfo(v.status);
      const statusText = v.error ? `${label} (${escapeHtml(v.error)})` : label;
      return `<tr>
        <td>${escapeHtml(v.videoId)}</td>
        <td>${escapeHtml(v.title)}</td>
        <td class="status ${cls}">${statusText}</td>
        <td>${v.recipes}</td>
      </tr>`;
    })
    .join("");
  return `<h2>Videos</h2>
  <table>
    <thead><tr><th>Video</th><th>Title</th><th>Status</th><th>Recipes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function catalogChanges(report: RunReport): string {
  return `<h2>Catalog changes</h2>
  <h3>Written (${report.written.length})</h3>${idList(report.written)}
  <h3>Replaced / archived (${report.archived.length})</h3>${idList(report.archived)}
  <h3>Kept existing (${report.keptExisting.length})</h3>${idList(report.keptExisting)}
  <h3>Superseded by a re-run (${report.superseded.length})</h3>${idList(report.superseded)}`;
}

function ingredientRow(i: DraftIngredient): string {
  const qty = i.quantity !== null ? `${i.quantity}${i.unit ? ` ${escapeHtml(i.unit)}` : ""}` : "—";
  return `<tr>
    <td>${escapeHtml(i.rawName)}</td>
    <td>${i.ingredient ? escapeHtml(i.ingredient) : `<span class="meta">unmapped</span>`}</td>
    <td>${qty}</td>
    <td>${provenanceChip(i.provenance)}</td>
  </tr>`;
}

function recipeCard(r: Recipe): string {
  const ingredientRows = r.ingredients.map(ingredientRow).join("");
  const steps = [...r.steps]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const href = `https://www.youtube.com/watch?v=${encodeURIComponent(r.source.videoId)}&t=${Math.round(s.timestamp)}s`;
      return `<li><a href="${href}">${formatTimestamp(s.timestamp)}</a> ${escapeHtml(s.text)}</li>`;
    })
    .join("");
  const flags = r.flags.length
    ? `<div class="flags">${r.flags.map((f) => `<div>${escapeHtml(f.kind)} "${escapeHtml(f.ref)}" — ${escapeHtml(f.reason)}</div>`).join("")}</div>`
    : "";
  return `<div class="card">
    <h3>${escapeHtml(r.nameRu)}</h3>
    <div class="sub">${escapeHtml(r.nameEn)}</div>
    <div class="sub">${escapeHtml(r.cuisine)} · ${r.mealTypes.map(escapeHtml).join(", ")} · ${escapeHtml(r.category)} ${scoreBadge(r.completeness)}</div>
    <table>
      <thead><tr><th>Ingredient</th><th>Vocab id</th><th>Qty</th><th>Provenance</th></tr></thead>
      <tbody>${ingredientRows}</tbody>
    </table>
    <ol class="steps">${steps}</ol>
    ${flags}
  </div>`;
}

export function renderReportHtml(report: RunReport, recipes: Recipe[], spentSoFar: number | null = null, unpricedRuns = 0): string {
  const runCost = totalCostUsd(report.usageRows);
  const tooThinCount = report.tooThin.length;
  const unmappedEntries = Object.entries(report.unmapped).sort((a, b) => b[1] - a[1]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kambuz run ${escapeHtml(report.startedAt)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
  <h1>Kambuz run</h1>
  <p class="meta">
    Started ${escapeHtml(report.startedAt)} · Duration ${durationLabel(report.startedAt, report.finishedAt)}<br>
    Source: <a href="${escapeHtml(report.url)}">${escapeHtml(report.url)}</a><br>
    ${spentSoFar !== null ? `Spent so far: ${formatCost(spentSoFar)}${unpricedRuns > 0 ? ` (${unpricedRuns} run${unpricedRuns === 1 ? "" : "s"} unpriced)` : ""}` : ""}
  </p>
  <div class="tiles">
    <div class="tile"><div class="n">${report.videos.length}</div><div class="label">videos</div></div>
    <div class="tile"><div class="n">${report.written.length}</div><div class="label">recipes written</div></div>
    <div class="tile"><div class="n">${tooThinCount}</div><div class="label">too thin</div></div>
    <div class="tile cost"><div class="n">${formatCost(runCost)}</div><div class="label">total cost</div></div>
  </div>

  ${usageTable(report.usageRows)}
  ${videosTable(report)}
  ${catalogChanges(report)}
  ${listSection(`Too thin to keep (score below ${report.minCompleteness})`, report.tooThin.map((t) => `${escapeHtml(t.recipeId)}: ${t.completeness.toFixed(2)} (${t.ingredients} ingredient${t.ingredients === 1 ? "" : "s"}, ${t.steps} step${t.steps === 1 ? "" : "s"})`))}
  ${listSection("Validation errors (recipe not written)", report.validationErrors.map((v) => `${escapeHtml(v.recipeId)}: ${escapeHtml(v.errors.join("; "))}`))}
  ${listSection("Failed segments (the rest of the video was kept)", report.segmentErrors.map((s) => `${escapeHtml(s.videoId)} segment ${s.segmentIndex} "${escapeHtml(s.workingName)}": ${escapeHtml(s.error)}`))}
  ${listSection("Unmapped ingredients", unmappedEntries.map(([name, n]) => `${escapeHtml(name)} (${n})`))}
  ${listSection("Verifier flags", report.flags.map((f) => `${escapeHtml(f.recipeId)}: ${escapeHtml(f.kind)} "${escapeHtml(f.ref)}" — ${escapeHtml(f.reason)}`))}

  ${recipes.length ? `<h2>Recipes written this run</h2>${recipes.map(recipeCard).join("")}` : ""}
</body>
</html>`;
}
