import { z } from "zod";

export const JudgeDecisionSchema = z.object({
  relation: z.enum(["same", "variant"]),
  reason: z.string(),
  newNameRu: z.string().nullable().describe("Only for variant: distinguishing name for the new recipe"),
  existingNameRu: z.string().nullable().describe("Only for variant: distinguishing name for the existing recipe"),
});
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;
