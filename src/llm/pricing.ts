export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ModelPrice {
  input: number; // USD per 1,000,000 input tokens
  output: number; // USD per 1,000,000 output tokens
}

// USD per 1,000,000 tokens. Source: Anthropic docs bundled with Claude Code, 2026.
export const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * An exact id, or a dated snapshot of one ("claude-haiku-4-5-20251001"). Only a -YYYYMMDD
 * suffix counts: "claude-sonnet-5-1" is a different model and must not borrow Sonnet 5's price.
 */
function priceFor(model: string): ModelPrice | null {
  if (Object.hasOwn(PRICES, model)) return PRICES[model];
  const family = Object.keys(PRICES)
    .filter((id) => model.startsWith(id) && /^-\d{8}$/.test(model.slice(id.length)))
    .sort((a, b) => b.length - a.length)[0];
  return family ? PRICES[family] : null;
}

/** Dollar cost of one call's usage, or null when the model has no known price. */
export function costUsd(model: string, usage: UsageTokens): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const perInputToken = price.input / 1_000_000;
  const input = usage.input_tokens * perInputToken;
  const output = (usage.output_tokens * price.output) / 1_000_000;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * perInputToken * CACHE_READ_MULTIPLIER;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * perInputToken * CACHE_WRITE_MULTIPLIER;
  return input + output + cacheRead + cacheWrite;
}
