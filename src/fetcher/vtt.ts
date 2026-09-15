import type { TranscriptCue } from "../schemas/source.js";

function toSeconds(ts: string): number {
  const [h, m, s] = ts.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function cleanLine(line: string): string {
  return line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Parse YouTube auto-caption VTT into de-duplicated cues. */
export function parseVtt(text: string): TranscriptCue[] {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const cues: TranscriptCue[] = [];
  let lastText = "";
  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [startRaw, endRaw] = lines[idx].split("-->");
    const start = toSeconds(startRaw);
    const end = toSeconds(endRaw.trim().split(" ")[0]);
    // YouTube emits the previous cue's text again as the first line; take the last non-empty line.
    const textLines = lines.slice(idx + 1).map(cleanLine).filter(Boolean);
    const candidate = textLines.at(-1);
    if (!candidate) continue;
    if (candidate === lastText) continue; // rolling duplicate
    if (end - start < 0.05) continue; // YouTube's 10 ms "hold" cues
    cues.push({ start, end, text: candidate });
    lastText = candidate;
  }
  return cues;
}

export function sliceCues(cues: TranscriptCue[], start: number, end: number): TranscriptCue[] {
  return cues.filter((c) => c.end >= start && c.start <= end);
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderTranscript(cues: TranscriptCue[]): string {
  return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join("\n");
}
