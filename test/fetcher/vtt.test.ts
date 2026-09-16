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
      "соль и перец & масло",
    ]);
    expect(cues[0]).toEqual({ start: 0, end: 2.5, text: "Всем привет дорогие друзья" });
    expect(cues[2].start).toBe(60);
  });

  it("decodes the HTML entities YouTube writes into caption text", () => {
    const cues = parseVtt(vtt);
    // &nbsp; would otherwise reach the prompts verbatim and split words
    expect(cues[3].text).toBe("соль и перец & масло");
    expect(cues[3].text).not.toMatch(/&\w+;/);
    expect(parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n&lt;он&gt; сказал &quot;вкусно&quot; &#39;да&#39; &#1072;").map((c) => c.text)).toEqual([
      `<он> сказал "вкусно" 'да' а`,
    ]);
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
