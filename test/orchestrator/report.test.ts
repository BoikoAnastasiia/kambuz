import { describe, it, expect } from "vitest";
import { emptyReport, renderReport } from "../../src/orchestrator/report.js";

describe("renderReport", () => {
  it("renders a written recipe id, a skipped video and the usage text", () => {
    const r = emptyReport("https://youtu.be/v1");
    r.videos.push(
      { videoId: "v1", title: "Лазанья", status: "done", recipes: 1 },
      { videoId: "v2", title: "v2", status: "skipped-no-captions", recipes: 0 },
    );
    r.written.push("lasagna-bolognese--v1");
    r.segmentErrors.push({ videoId: "v1", segmentIndex: 2, workingName: "борщ", error: "extractor: response did not match schema" });
    r.usage = "scout: 1200 tokens";

    const md = renderReport(r);

    expect(md).toContain("борщ");
    expect(md).toContain("extractor: response did not match schema");
    expect(md).toContain("lasagna-bolognese--v1");
    expect(md).toContain("v2");
    expect(md).toContain("skipped-no-captions");
    expect(md).toContain("scout: 1200 tokens");
  });

  it("renders too-thin recipes with the threshold, score and counts", () => {
    const r = emptyReport("https://youtu.be/v1", 0.3);
    r.tooThin.push({ recipeId: "meatballs-with-cheese--v1", completeness: 0.15, ingredients: 1, steps: 5 });

    const md = renderReport(r);

    expect(md).toContain("## Too thin to keep (score below 0.3)");
    expect(md).toContain("meatballs-with-cheese--v1");
    expect(md).toContain("0.15");
    expect(md).toMatch(/1 ingredient/);
    expect(md).toMatch(/5 steps/);
  });

  it("renders superseded ids under Catalog changes", () => {
    const r = emptyReport("https://youtu.be/v1");
    r.superseded.push("lasagna-bolognese--v1");

    const md = renderReport(r);

    expect(md).toContain("- superseded by a re-run: 1");
    expect(md).toContain("lasagna-bolognese--v1");
  });

  it("shows the Cost line, summed from usageRows", () => {
    const r = emptyReport("https://youtu.be/v1");
    r.usageRows = [
      { agent: "scout", calls: 1, input: 1_000_000, output: 0, costUsd: 2 },
      { agent: "extractor", calls: 1, input: 1_000_000, output: 0, costUsd: 5 },
    ];

    const md = renderReport(r);

    expect(md).toContain("Cost: $7.00");
  });

  it("shows an unknown Cost as ? when a bucket's model is unpriced", () => {
    const r = emptyReport("https://youtu.be/v1");
    r.usageRows = [{ agent: "scout", calls: 1, input: 1_000_000, output: 0, costUsd: null }];

    const md = renderReport(r);

    expect(md).toContain("Cost: ?");
  });
});
