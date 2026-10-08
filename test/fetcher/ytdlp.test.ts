import { describe, it, expect } from "vitest";
import { parseVideoId, buildSource, ytDlpError, pickCaptionTrack, infoArgs, subsArgs, baseLanguage, chapterCues } from "../../src/fetcher/ytdlp.js";

const tracks = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, []]));

describe("pickCaptionTrack", () => {
  it("prefers the original spoken track in any language", () => {
    expect(pickCaptionTrack({ language: null, subtitles: {}, automatic_captions: tracks(["ru", "en", "ru-orig"]) })).toEqual({ lang: "ru-orig", auto: true, kind: "spoken" });
    expect(pickCaptionTrack({ language: "en-US", subtitles: {}, automatic_captions: tracks(["en-orig", "en", "ru"]) })).toEqual({ lang: "en-orig", auto: true, kind: "spoken" });
  });

  it("takes the automatic track in the video's own language when there is no -orig key", () => {
    expect(pickCaptionTrack({ language: "en-US", subtitles: {}, automatic_captions: tracks(["en", "ru"]) })).toEqual({ lang: "en", auto: true, kind: "spoken" });
  });

  it("falls back to the author's subtitles, video language first, then Russian, then English", () => {
    expect(pickCaptionTrack({ language: null, subtitles: tracks(["en", "ru"]), automatic_captions: tracks(["en", "ru"]) })).toEqual({ lang: "ru", auto: false, kind: "author" });
    expect(pickCaptionTrack({ language: "de", subtitles: tracks(["en", "de"]), automatic_captions: {} })).toEqual({ lang: "de", auto: false, kind: "author" });
    expect(pickCaptionTrack({ language: null, subtitles: tracks(["live_chat"]), automatic_captions: {} })).toBeNull();
  });

  it("uses a Russian automatic track as the last resort and never another translation", () => {
    expect(pickCaptionTrack({ language: null, subtitles: {}, automatic_captions: tracks(["ru", "en"]) })).toEqual({ lang: "ru", auto: true, kind: "spoken" });
    expect(pickCaptionTrack({ language: null, subtitles: {}, automatic_captions: tracks(["en", "de"]) })).toBeNull();
    expect(pickCaptionTrack({ language: null, subtitles: null, automatic_captions: null })).toBeNull();
  });
});

describe("subsArgs and infoArgs", () => {
  it("loads the info json once and then downloads only the chosen track", () => {
    expect(infoArgs("abc", "/tmp/w")).toEqual(["--skip-download", "--write-info-json", "-o", "/tmp/w/%(id)s.%(ext)s", "https://www.youtube.com/watch?v=abc"]);
    const auto = subsArgs("/tmp/w/abc.info.json", { lang: "en-orig", auto: true, kind: "spoken" }, "/tmp/w");
    expect(auto.slice(0, 4)).toEqual(["--load-info-json", "/tmp/w/abc.info.json", "--skip-download", "--write-auto-subs"]);
    expect(auto[auto.indexOf("--sub-langs") + 1]).toBe("en-orig");
    expect(subsArgs("i", { lang: "ru", auto: false, kind: "author" }, "/w")).toContain("--write-subs");
  });
});

describe("baseLanguage and chapterCues", () => {
  it("reduces track and locale names to a base language", () => {
    expect(["en-US", "ru-orig", "pt_BR", null, ""].map(baseLanguage)).toEqual(["en", "ru", "pt", "und", "und"]);
  });
  it("turns chapters into timed lines for a silent video", () => {
    expect(chapterCues([{ start: 28, end: 97, title: "1 TSP YEAST" }])).toEqual([{ start: 28, end: 97, text: "1 TSP YEAST" }]);
  });
});

describe("ytDlpError", () => {
  it("turns a missing binary into an install hint instead of an ENOENT stack", () => {
    const enoent = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
    expect(ytDlpError(enoent).message).toBe("yt-dlp not found. Install it with: brew install yt-dlp");
  });

  it("passes any other yt-dlp failure through unchanged", () => {
    const boom = Object.assign(new Error("ERROR: unable to download video data"), { code: 1 });
    expect(ytDlpError(boom)).toBe(boom);
  });
});

describe("parseVideoId", () => {
  it("handles youtu.be, watch, and shorts URLs", () => {
    expect(parseVideoId("https://youtu.be/bskR7LVpF7I?si=abc")).toBe("bskR7LVpF7I");
    expect(parseVideoId("https://www.youtube.com/watch?v=bskR7LVpF7I&t=10")).toBe("bskR7LVpF7I");
    expect(parseVideoId("https://www.youtube.com/playlist?list=PL123")).toBeNull();
  });
});

describe("buildSource", () => {
  it("maps yt-dlp info json + cues into a VideoSource", () => {
    const info = {
      id: "abc", webpage_url: "https://www.youtube.com/watch?v=abc", title: "T", tags: ["a"], channel: "C", channel_id: "UC1", duration: 100, upload_date: "20250101",
      description: "Ingredients\n1 cup flour", chapters: [{ start_time: 0, end_time: 28, title: "Intro" }], language: "en-US", subtitles: {}, automatic_captions: {},
    };
    const src = buildSource(info, [{ start: 0, end: 1, text: "x" }], { language: "en", captionKind: "spoken" });
    expect(src).toMatchObject({ videoId: "abc", channelId: "UC1", durationSec: 100, uploadDate: "2025-01-01", language: "en", captionKind: "spoken", description: "Ingredients\n1 cup flour" });
    expect(src.chapters).toEqual([{ start: 0, end: 28, title: "Intro" }]);
    expect(src.cues).toHaveLength(1);
  });
});
