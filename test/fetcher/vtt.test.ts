import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVtt, sliceCues, renderTranscript, formatTimestamp } from "../../src/fetcher/vtt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vtt = readFileSync(path.join(here, "../fixtures/sample.ru.vtt"), "utf8");

describe("parseVtt", () => {
  it("strips inline timing tags and drops rolling duplicates", () => {
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.text)).toEqual([
      "Всем привет дорогие друзья",
      "сегодня будет лазанья",
      "нарежем кубиком лук",
    ]);
    expect(cues[0]).toEqual({ start: 0, end: 2.5, text: "Всем привет дорогие друзья" });
    expect(cues[2].start).toBe(60);
  });
});

describe("sliceCues", () => {
  it("keeps cues overlapping the range", () => {
    const cues = parseVtt(vtt);
    expect(sliceCues(cues, 2, 10).map((c) => c.text)).toEqual(["Всем привет дорогие друзья", "сегодня будет лазанья"]);
    expect(sliceCues(cues, 59, 70).map((c) => c.text)).toEqual(["нарежем кубиком лук"]);
  });
});

describe("renderTranscript", () => {
  it("prefixes each cue with mm:ss", () => {
    expect(formatTimestamp(61)).toBe("01:01");
    expect(formatTimestamp(3600)).toBe("60:00");
    const out = renderTranscript(parseVtt(vtt));
    expect(out.split("\n")[2]).toBe("[01:00] нарежем кубиком лук");
  });
});
