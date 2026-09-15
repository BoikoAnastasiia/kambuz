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
    r.usage = "scout: 1200 tokens";

    const md = renderReport(r);

    expect(md).toContain("lasagna-bolognese--v1");
    expect(md).toContain("v2");
    expect(md).toContain("skipped-no-captions");
    expect(md).toContain("scout: 1200 tokens");
  });
});
