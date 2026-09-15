import { z } from "zod";

export const TranscriptCueSchema = z.object({ start: z.number(), end: z.number(), text: z.string() });
export type TranscriptCue = z.infer<typeof TranscriptCueSchema>;

export const VideoSourceSchema = z.object({
  videoId: z.string(),
  url: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  channel: z.string(),
  channelId: z.string(),
  durationSec: z.number(),
  uploadDate: z.string().nullable(),
  language: z.literal("ru"),
  cues: z.array(TranscriptCueSchema),
});
export type VideoSource = z.infer<typeof VideoSourceSchema>;
