// Inline CSS for the self-contained HTML run report (src/orchestrator/report-html.ts).
// Kept in its own module so report-html.ts stays focused on markup.
export const REPORT_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f7f7f5;
    --panel: #ffffff;
    --text: #1a1a1a;
    --muted: #6b6b6b;
    --border: #e2e2e0;
    --accent: #2b6cb0;
    --green: #1a7f37;
    --amber: #9a6700;
    --red: #cf222e;
    --grey: #6b6b6b;
    --chip-bg: #eef0f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a;
      --panel: #1f2023;
      --text: #eaeaea;
      --muted: #9a9a9a;
      --border: #333437;
      --accent: #6ea8dc;
      --green: #3fb950;
      --amber: #d29922;
      --red: #f85149;
      --grey: #9a9a9a;
      --chip-bg: #2a2b2e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1, h2, h3 { line-height: 1.25; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  a { color: var(--accent); }
  .meta { color: var(--muted); font-size: 13px; }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
  .tile {
    flex: 1 1 140px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
  }
  .tile .n { font-size: 24px; font-weight: 700; }
  .tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  .tile.cost .n { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.02em; }
  tr.total-row td { font-weight: 700; border-top: 2px solid var(--border); }
  .bar { background: var(--chip-bg); border-radius: 3px; height: 6px; width: 100%; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--accent); }
  .status { font-weight: 600; }
  .status-done { color: var(--green); }
  .status-error { color: var(--red); }
  .status-skipped { color: var(--grey); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; }
  .badge-green { background: var(--green); }
  .badge-amber { background: var(--amber); }
  .badge-red { background: var(--red); }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--chip-bg); color: var(--muted); }
  .chip-stated { color: var(--green); }
  .chip-inferred { color: var(--amber); }
  .chip-unknown { color: var(--muted); }
  ul.plain { margin: 4px 0; padding-left: 20px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 20px;
    margin: 0 0 16px;
  }
  .card .sub { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
  ol.steps { padding-left: 22px; margin: 8px 0; }
  ol.steps li { margin-bottom: 6px; }
  .flags { margin-top: 10px; font-size: 13px; color: var(--muted); }
`;
