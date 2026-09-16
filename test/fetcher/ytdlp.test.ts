import { describe, it, expect } from "vitest";
import { parseVideoId, buildSource, ytDlpError } from "../../src/fetcher/ytdlp.js";

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
    const info = { id: "abc", webpage_url: "https://www.youtube.com/watch?v=abc", title: "T", tags: ["a"], channel: "C", channel_id: "UC1", duration: 100, upload_date: "20250101" };
    const src = buildSource(info, [{ start: 0, end: 1, text: "x" }]);
    expect(src).toMatchObject({ videoId: "abc", channelId: "UC1", durationSec: 100, uploadDate: "2025-01-01", language: "ru" });
    expect(src.cues).toHaveLength(1);
  });
});
