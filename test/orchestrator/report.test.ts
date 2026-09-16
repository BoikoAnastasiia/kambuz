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
});
