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
});
type Info = z.infer<typeof InfoSchema>;

export function buildSource(info: Info, cues: TranscriptCue[]): VideoSource {
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
    language: "ru",
    cues,
  });
}

export type FetchResult = VideoSource | { videoId: string; skipped: "no-captions" };

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function fetchArgs(videoId: string, workDir: string): string[] {
  return [
    "--skip-download", "--write-info-json", "--write-auto-subs",
    "--sub-langs", "ru", "--sub-format", "vtt",
    "-o", path.join(workDir, "%(id)s.%(ext)s"), videoUrl(videoId),
  ];
}

/** Downloads info json + Russian auto-captions into workDir and returns a VideoSource. */
export async function fetchVideo(videoId: string, workDir: string): Promise<FetchResult> {
  await mkdir(workDir, { recursive: true });
  await ytDlp(fetchArgs(videoId, workDir));
  const files = await readdir(workDir);
  const infoFile = files.find((f) => f === `${videoId}.info.json`);
  if (!infoFile) throw new Error(`yt-dlp produced no info json for ${videoId}`);
  const info = InfoSchema.parse(JSON.parse(await readFile(path.join(workDir, infoFile), "utf8")));
  const vttFile = files.find((f) => f.startsWith(`${videoId}.ru`) && f.endsWith(".vtt"));
  if (!vttFile) return { videoId, skipped: "no-captions" };
  const cues = parseVtt(await readFile(path.join(workDir, vttFile), "utf8"));
  return buildSource(info, cues);
}
