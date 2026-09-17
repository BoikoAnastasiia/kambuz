import { describe, it, expect } from "vitest";
import { sumSpend, spendEntry } from "../../src/cli/spend.js";

describe("sumSpend", () => {
  it("sums costUsd across lines", () => {
    const raw = [
      JSON.stringify({ at: "t1", source: "u1", costUsd: 1.5, calls: 2, input: 10, output: 5 }),
      JSON.stringify({ at: "t2", source: "u2", costUsd: 2.25, calls: 1, input: 3, output: 1 }),
    ].join("\n");
    expect(sumSpend(raw)).toEqual({ totalUsd: 3.75, runs: 2, unknownRuns: 0 });
  });

  it("counts an unknown-cost run as 0 but tallies it separately", () => {
    const raw = [
      JSON.stringify({ at: "t1", source: "u1", costUsd: 1, calls: 1, input: 1, output: 1 }),
      JSON.stringify({ at: "t2", source: "u2", costUsd: null, calls: 1, input: 1, output: 1 }),
    ].join("\n");
    expect(sumSpend(raw)).toEqual({ totalUsd: 1, runs: 2, unknownRuns: 1 });
  });

  it("treats empty content as zero spend", () => {
    expect(sumSpend("")).toEqual({ totalUsd: 0, runs: 0, unknownRuns: 0 });
  });

  it("skips blank and unparsable lines", () => {
    const raw = `\n${JSON.stringify({ at: "t1", source: "u1", costUsd: 1, calls: 1, input: 1, output: 1 })}\n\nnot json\n`;
    expect(sumSpend(raw)).toEqual({ totalUsd: 1, runs: 1, unknownRuns: 0 });
  });
});

describe("spendEntry", () => {
  it("builds an entry from usage rows, summing calls/input/output and the total cost", () => {
    const entry = spendEntry("2026-09-17T12:00:00.000Z", "https://youtu.be/x", [
      { agent: "scout", calls: 1, input: 1_000_000, output: 0, costUsd: 2 },
      { agent: "extractor", calls: 1, input: 1_000_000, output: 0, costUsd: 5 },
    ]);
    expect(entry).toEqual({ at: "2026-09-17T12:00:00.000Z", source: "https://youtu.be/x", costUsd: 7, calls: 2, input: 2_000_000, output: 0 });
  });

  it("carries an unknown total cost as null when any agent's model is unpriced", () => {
    const entry = spendEntry("t", "u", [{ agent: "scout", calls: 1, input: 1, output: 1, costUsd: null }]);
    expect(entry.costUsd).toBeNull();
  });
});
