import { z } from "zod";

export const ScoutSegmentSchema = z.object({
  workingName: z.string().describe("The dish as the chef refers to it"),
  start: z.number().describe("Seconds into the video where cooking this dish starts"),
  end: z.number().describe("Seconds where it ends"),
  rawText: z.string().describe("Exact transcript slice for the range, copied verbatim"),
  cleanText: z.string().describe("Same slice with speech-to-text errors fixed; no content added or removed"),
});
export type ScoutSegment = z.infer<typeof ScoutSegmentSchema>;

export const ScoutResultSchema = z.object({
  isRecipeVideo: z.boolean(),
  segments: z.array(ScoutSegmentSchema),
});
export type ScoutResult = z.infer<typeof ScoutResultSchema>;
