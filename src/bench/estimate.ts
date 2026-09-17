import { costUsd } from "../llm/pricing.js";

/** Russian text through Claude's tokenizer runs at roughly three characters per token. */
export const CHARS_PER_TOKEN = 3;

/**
 * A guess at output per call, thinking included. The verifier answers one entry per ingredient
 * and step; the categorizer a handful of fields. Adaptive thinking at high effort can exceed it.
 */
export const OUTPUT_TOKENS_PER_CALL = { verifier: 2500, categorizer: 150 } as const;

export interface CostEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Rough dollar figure for a list of calls, each given as its system + user prompt length in characters. */
export function estimateCost(model: string, agent: keyof typeof OUTPUT_TOKENS_PER_CALL, inputChars: number[]): CostEstimate {
  const inputTokens = Math.ceil(inputChars.reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN);
  const outputTokens = OUTPUT_TOKENS_PER_CALL[agent] * inputChars.length;
  return { calls: inputChars.length, inputTokens, outputTokens, costUsd: costUsd(model, { input_tokens: inputTokens, output_tokens: outputTokens }) };
}
