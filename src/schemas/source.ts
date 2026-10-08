import { z } from "zod";

export const TranscriptCueSchema = z.object({ start: z.number(), end: z.number(), text: z.string() });
export type TranscriptCue = z.infer<typeof TranscriptCueSchema>;

export const ChapterSchema = z.object({ start: z.number(), end: z.number(), title: z.string() });
export type Chapter = z.infer<typeof ChapterSchema>;

/**
 * Where the timed text in `cues` came from: the original spoken-word captions, subtitles
 * the author uploaded, the video's chapter titles (a silent video), or nothing at all
 * (only the description is left).
 */
export const CaptionKindSchema = z.enum(["spoken", "author", "chapters", "none"]);
export type CaptionKind = z.infer<typeof CaptionKindSchema>;

export const VideoSourceSchema = z.object({
  videoId: z.string(),
  url: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  channel: z.string(),
  channelId: z.string(),
  durationSec: z.number(),
  uploadDate: z.string().nullable(),
  /** Language of the cues (or of the video, when there are none), e.g. "ru", "en"; "und" if unknown. */
  language: z.string(),
  cues: z.array(TranscriptCueSchema),
  // Defaults keep sources cached before these fields existed valid: they were all Russian speech.
  captionKind: CaptionKindSchema.default("spoken"),
  description: z.string().default(""),
  chapters: z.array(ChapterSchema).default([]),
});
export type VideoSource = z.infer<typeof VideoSourceSchema>;
