import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseVtt } from "./vtt.js";
import { VideoSourceSchema, type TranscriptCue, type VideoSource } from "../schemas/source.js";

const exec = promisify(execFile);

/** yt-dlp is an external binary; a missing one must read as an install hint, not an ENOENT stack. */
export function ytDlpError(e: unknown): Error {
  if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    return new Error("yt-dlp not found. Install it with: brew install yt-dlp");
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function ytDlp(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("yt-dlp", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw ytDlpError(e);
  }
}

export function parseVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.searchParams.get("list") && !u.searchParams.get("v")) return null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/^\/(shorts|embed)\/([^/?]+)/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/** A single video URL → [id]; a playlist/channel URL → every video id. */
export async function expandUrl(url: string): Promise<string[]> {
  const single = parseVideoId(url);
  if (single) return [single];
  const stdout = await ytDlp(["--flat-playlist", "--print", "%(id)s", url]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

const InfoSchema = z.object({
  id: z.string(),
  webpage_url: z.string(),
  title: z.string(),
  tags: z.array(z.string()).nullable().default([]),
  channel: z.string(),
  channel_id: z.string(),
  duration: z.number(),
  upload_date: z.string().nullable().default(null),
  description: z.string().nullable().default(""),
  chapters: z.array(z.object({ start_time: z.number(), end_time: z.number(), title: z.string() })).nullable().default([]),
  /** The video's spoken language as YouTube reports it ("en-US"), often missing. */
  language: z.string().nullable().default(null),
  /** Track lists keyed by language: author-uploaded subtitles and YouTube's automatic captions. */
  subtitles: z.record(z.string(), z.unknown()).nullable().default({}),
  automatic_captions: z.record(z.string(), z.unknown()).nullable().default({}),
});
export type Info = z.infer<typeof InfoSchema>;

/** Long descriptions are mostly links and hashtags; the recipe part comes first. */
const MAX_DESCRIPTION_CHARS = 4000;

/** "en-US" → "en", "ru-orig" → "ru"; null or empty → "und". */
export function baseLanguage(lang: string | null | undefined): string {
  return lang ? lang.replace(/-orig$/, "").split(/[-_]/)[0].toLowerCase() || "und" : "und";
}

export interface CaptionTrack {
  /** The key yt-dlp lists the track under, e.g. "en-orig", "ru". */
  lang: string;
  /** An automatic caption (written by YouTube's speech recognition) rather than an uploaded subtitle. */
  auto: boolean;
  kind: "spoken" | "author";
}

/**
 * The track whose text is closest to what the chef actually said or wrote:
 * 1. the automatic caption of the original speech ("<lang>-orig", any language);
 * 2. an automatic caption in the video's own language (older videos have no "-orig" key);
 * 3. subtitles the author uploaded: the video's language, then Russian, then English, then any;
 * 4. the Russian automatic caption, which may be YouTube's machine translation — still
 *    better than nothing, and what every video got before languages were picked here.
 * Any other automatic caption is a machine translation of a translation and is never used.
 */
export function pickCaptionTrack(info: Pick<Info, "language" | "subtitles" | "automatic_captions">): CaptionTrack | null {
  const auto = Object.keys(info.automatic_captions ?? {});
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== "live_chat");
  const videoLang = baseLanguage(info.language);
  const orig = auto.find((k) => k.endsWith("-orig"));
  if (orig) return { lang: orig, auto: true, kind: "spoken" };
  if (videoLang !== "und" && auto.includes(videoLang)) return { lang: videoLang, auto: true, kind: "spoken" };
  const preferred = [videoLang, "ru", "en"].map((l) => manual.find((k) => baseLanguage(k) === l)).find(Boolean) ?? manual[0];
  if (preferred) return { lang: preferred, auto: false, kind: "author" };
  if (auto.includes("ru")) return { lang: "ru", auto: true, kind: "spoken" };
  return null;
}

export interface SourceExtras {
  language: string;
  captionKind: VideoSource["captionKind"];
}

export function buildSource(info: Info, cues: TranscriptCue[], extras: SourceExtras = { language: "ru", captionKind: "spoken" }): VideoSource {
  const d = info.upload_date;
  return VideoSourceSchema.parse({
    videoId: info.id,
    url: info.webpage_url,
    title: info.title,
    tags: info.tags ?? [],
    channel: info.channel,
    channelId: info.channel_id,
    durationSec: info.duration,
    uploadDate: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    language: extras.language,
    cues,
    captionKind: extras.captionKind,
    description: (info.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
    chapters: (info.chapters ?? []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title })),
  });
}

/**
 * Turns a VideoSource's timeline into cues when there is no caption track: a silent video's
 * chapters ("1 TSP YEAST" at 0:28) are its only timed text.
 */
export function chapterCues(chapters: VideoSource["chapters"]): TranscriptCue[] {
  return chapters.map((c) => ({ start: c.start, end: c.end, text: c.title }));
}

/** A description this short has no recipe in it ("Subscribe!", a hashtag line). */
const MIN_DESCRIPTION_CHARS = 80;

export type FetchResult = VideoSource | { videoId: string; skipped: "no-captions" };

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** First call: the info json only, which lists every caption track the video has. */
export function infoArgs(videoId: string, workDir: string): string[] {
  return ["--skip-download", "--write-info-json", "-o", path.join(workDir, "%(id)s.%(ext)s"), videoUrl(videoId)];
}

/** Second call: just the chosen track, reusing the saved info json instead of loading the page again. */
export function subsArgs(infoFile: string, track: CaptionTrack, workDir: string): string[] {
  return [
    "--load-info-json", infoFile, "--skip-download",
    track.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs", track.lang, "--sub-format", "vtt",
    "-o", path.join(workDir, "%(id)s.%(ext)s"),
  ];
}

/**
 * Downloads the info json and the best caption track into workDir and returns a VideoSource.
 * Without any track it falls back to the chapters as a timeline, then to the description
 * alone; a video with none of the three is skipped.
 */
export async function fetchVideo(videoId: string, workDir: string): Promise<FetchResult> {
  await mkdir(workDir, { recursive: true });
  await ytDlp(infoArgs(videoId, workDir));
  const infoPath = path.join(workDir, `${videoId}.info.json`);
  let info: Info;
  try {
    info = InfoSchema.parse(JSON.parse(await readFile(infoPath, "utf8")));
  } catch {
    throw new Error(`yt-dlp produced no usable info json for ${videoId}`);
  }

  const track = pickCaptionTrack(info);
  if (track) {
    await ytDlp(subsArgs(infoPath, track, workDir));
    const vtt = (await readdir(workDir)).find((f) => f === `${videoId}.${track.lang}.vtt`);
    if (vtt) {
      const cues = parseVtt(await readFile(path.join(workDir, vtt), "utf8"));
      if (cues.length) return buildSource(info, cues, { language: baseLanguage(track.lang), captionKind: track.kind });
    }
  }

  const fallback = buildSource(info, [], { language: baseLanguage(info.language), captionKind: "none" });
  if (fallback.chapters.length) return { ...fallback, cues: chapterCues(fallback.chapters), captionKind: "chapters" };
  if (fallback.description.trim().length >= MIN_DESCRIPTION_CHARS) return fallback;
  return { videoId, skipped: "no-captions" };
}
