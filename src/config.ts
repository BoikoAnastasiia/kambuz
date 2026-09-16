import path from "node:path";
// Importing env.js loads .env; it must happen before buildConfig() reads process.env.
import { ROOT } from "./env.js";

export const AGENT_NAMES = ["scout", "extractor", "verifier", "categorizer", "judge"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export { ROOT };

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MIN_COMPLETENESS = 0.3;

export interface Config {
  models: Record<AgentName, string>;
  concurrency: number;
  minCompleteness: number;
  paths: { cache: string; catalog: string; reports: string; vocab: string; prompts: string; eval: string };
}

/** Empty, non-numeric, fractional-below-one or negative values all fall back. */
function concurrencyFrom(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONCURRENCY;
}

/** Empty, non-numeric or outside [0, 1] all fall back — a recipe below this score isn't written. */
function minCompletenessFrom(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_COMPLETENESS;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const models = Object.fromEntries(
    AGENT_NAMES.map((n) => [n, env[`KAMBUZ_MODEL_${n.toUpperCase()}`] ?? env.KAMBUZ_MODEL ?? "claude-sonnet-5"]),
  ) as Record<AgentName, string>;
  return {
    models,
    concurrency: concurrencyFrom(env.KAMBUZ_CONCURRENCY),
    minCompleteness: minCompletenessFrom(env.KAMBUZ_MIN_COMPLETENESS),
    paths: {
      cache: path.join(ROOT, ".cache"),
      catalog: path.join(ROOT, "catalog"),
      reports: path.join(ROOT, "reports"),
      vocab: path.join(ROOT, "vocab"),
      prompts: path.join(ROOT, "src", "prompts"),
      eval: path.join(ROOT, "eval"),
    },
  };
}

export const config = buildConfig();
