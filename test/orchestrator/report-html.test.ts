import { describe, it, expect } from "vitest";
import { renderReportHtml, escapeHtml, formatTimestamp } from "../../src/orchestrator/report-html.js";
import { emptyReport, type RunReport } from "../../src/orchestrator/report.js";
import type { Recipe } from "../../src/schemas/recipe.js";

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "borscht--v1",
    nameRu: "<script>alert(1)</script>Борщ",
    nameEn: "Borscht",
    dishKey: "borscht",
    cuisine: "russian",
    mealTypes: ["lunch"],
    category: "soup",
    richness: "hearty",
    servings: 4,
    activeMinutes: 20,
    totalMinutes: 60,
    ingredients: [
      { ingredient: "beet", rawName: "свёкла", quantity: 2, unit: "pc", provenance: "stated", note: null },
      { ingredient: null, rawName: "загадочный ингредиент", quantity: null, unit: null, provenance: "unknown", note: null },
    ],
    steps: [
      { order: 1, text: "Sauté the beets", timestamp: 3725 },
      { order: 2, text: "Simmer", timestamp: 4000 },
    ],
    flags: [{ kind: "ingredient", ref: "beet", reason: "quantity guessed" }],
    completeness: 0.8,
    source: {
      videoId: "v1",
      url: "https://www.youtube.com/watch?v=v1",
      videoTitle: "T",
      channel: "C",
      channelId: "CID",
      segmentStart: 0,
      segmentEnd: 100,
      language: "ru",
    },
    extractedAt: "2026-09-17T12:00:00.000Z",
    models: { scout: "claude-sonnet-5", extractor: "claude-sonnet-5", verifier: "claude-sonnet-5", categorizer: "claude-sonnet-5", judge: "claude-sonnet-5" },
    ...overrides,
  };
}

function baseReport(overrides: Partial<RunReport> = {}): RunReport {
  const r = emptyReport("https://youtu.be/v1");
  r.finishedAt = new Date(new Date(r.startedAt).getTime() + 5000).toISOString();
  r.videos.push({ videoId: "v1", title: "T", status: "done", recipes: 1 });
  r.written.push("borscht--v1");
  r.usageRows = [
    { agent: "scout", calls: 1, input: 1_000_000, output: 0, costUsd: 2 },
    { agent: "extractor", calls: 1, input: 1_000_000, output: 0, costUsd: 5 },
  ];
  return { ...r, ...overrides };
}

describe("formatTimestamp", () => {
  it("renders h:mm:ss past an hour", () => {
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });
  it("renders m:ss under an hour", () => {
    expect(formatTimestamp(65)).toBe("1:05");
  });
});

describe("escapeHtml", () => {
  it("escapes the five special characters", () => {
    expect(escapeHtml(`<script>&"'</script>`)).toBe("&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
  });
});

describe("renderReportHtml", () => {
  it("escapes a dish name containing a script tag", () => {
    const html = renderReportHtml(baseReport(), [baseRecipe()]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows the total cost", () => {
    const html = renderReportHtml(baseReport(), [baseRecipe()]);
    expect(html).toContain("$7.00");
  });

  it("links a step timestamp with &t=<seconds>s and an h:mm:ss label", () => {
    const html = renderReportHtml(baseReport(), [baseRecipe()]);
    expect(html).toContain("&t=3725s");
    expect(html).toContain(">1:02:05<");
  });

  it("shows the vocab id / unmapped and the provenance chip for each ingredient", () => {
    const html = renderReportHtml(baseReport(), [baseRecipe()]);
    expect(html).toContain(">beet<");
    expect(html).toContain("unmapped");
    expect(html).toContain("chip-stated");
    expect(html).toContain("chip-unknown");
  });

  it("omits empty sections", () => {
    const report = baseReport();
    const html = renderReportHtml(report, [baseRecipe()]);
    expect(html).not.toContain("Validation errors");
    expect(html).not.toContain("Verifier flags");
    expect(html).not.toContain("Failed segments");
    expect(html).not.toContain("Unmapped ingredients");
  });

  it("renders non-empty sections (too thin, validation errors, unmapped)", () => {
    const report = baseReport({
      tooThin: [{ recipeId: "thin--v1", completeness: 0.1, ingredients: 1, steps: 1 }],
      validationErrors: [{ recipeId: "bad--v1", errors: ["<img onerror=x> missing steps"] }],
      unmapped: { "неизвестный овощ": 3 },
      segmentErrors: [{ videoId: "v1", segmentIndex: 0, workingName: "soup", error: "boom" }],
      flags: [{ recipeId: "borscht--v1", kind: "ingredient", ref: "beet", reason: "guessed" }],
    });
    const html = renderReportHtml(report, [baseRecipe()]);
    expect(html).toContain("Too thin to keep");
    expect(html).toContain("thin--v1");
    expect(html).toContain("Validation errors");
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).toContain("Unmapped ingredients");
    expect(html).toContain("неизвестный овощ");
    expect(html).toContain("Failed segments");
    expect(html).toContain("Verifier flags");
  });

  it("marks an unknown run cost as ? rather than $0", () => {
    const report = baseReport({ usageRows: [{ agent: "scout", calls: 1, input: 1, output: 1, costUsd: null }] });
    const html = renderReportHtml(report, []);
    expect(html).toContain(">?<");
  });

  it("shows spent so far when passed a cumulative total", () => {
    const html = renderReportHtml(baseReport(), [], 12.5);
    expect(html).toContain("Spent so far: $12.50");
  });

  it("has no <script> tags anywhere in the generated document (no JS needed)", () => {
    const html = renderReportHtml(baseReport(), [baseRecipe()]);
    // The only "script" occurrences allowed are the escaped, inert ones from the fixture name.
    expect(html.match(/<script(?!&gt;)/gi)).toBeNull();
  });
});
