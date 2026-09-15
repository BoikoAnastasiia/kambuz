export type VideoStatus = "done" | "skipped-no-captions" | "not-recipe" | "error";

export interface RunReport {
  startedAt: string;
  url: string;
  videos: { videoId: string; title: string; status: VideoStatus; recipes: number; error?: string }[];
  written: string[];
  archived: string[];
  keptExisting: string[];
  unmapped: Record<string, number>;
  flags: { recipeId: string; kind: string; ref: string; reason: string }[];
  usage: string;
}

export function emptyReport(url: string): RunReport {
  return { startedAt: new Date().toISOString(), url, videos: [], written: [], archived: [], keptExisting: [], unmapped: {}, flags: [], usage: "" };
}

export function renderReport(r: RunReport): string {
  const counts = r.videos.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.status]: (acc[v.status] ?? 0) + 1 }), {});
  const lines = [
    `# Kambuz run ${r.startedAt}`,
    "",
    `Source: ${r.url}`,
    "",
    "## Videos",
    "",
    ...Object.entries(counts).map(([s, n]) => `- ${s}: ${n}`),
    "",
    "| video | title | status | recipes |",
    "|---|---|---|---|",
    ...r.videos.map((v) => `| ${v.videoId} | ${v.title.replace(/\|/g, "/")} | ${v.status}${v.error ? ` (${v.error})` : ""} | ${v.recipes} |`),
    "",
    "## Catalog changes",
    "",
    `- written: ${r.written.length}`, ...r.written.map((id) => `  - ${id}`),
    `- archived (replaced by a more complete version): ${r.archived.length}`, ...r.archived.map((id) => `  - ${id}`),
    `- kept existing (duplicate not better): ${r.keptExisting.length}`, ...r.keptExisting.map((id) => `  - ${id}`),
    "",
    "## Unmapped ingredients (add to vocab/ingredients.json, then rerun with --force --only-stage extract)",
    "",
    ...Object.entries(r.unmapped).sort((a, b) => b[1] - a[1]).map(([name, n]) => `- ${name} (${n})`),
    "",
    "## Verifier flags",
    "",
    ...r.flags.map((f) => `- ${f.recipeId}: ${f.kind} "${f.ref}" — ${f.reason}`),
    "",
    "## Token usage",
    "",
    "```",
    r.usage,
    "```",
  ];
  return lines.join("\n");
}
