import path from "node:path";
// Importing env.js loads .env; it must happen before buildConfig() reads process.env.
import { ROOT } from "./env.js";

export const AGENT_NAMES = ["scout", "extractor", "verifier", "categorizer", "judge", "translator", "proofreader"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export { ROOT };

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

// Haiku 5.5 matched Sonnet 5 on the six cached videos at about 1/30th of the cost.
export const DEFAULT_MODEL = "claude-haiku-5-5";

// The English translation is the one place Haiku wasn't good enough: on a 20-recipe eval it
// left Russian in the output and changed meanings, while Sonnet 5.5 got 18 of 20 clean.
// Opus 5.5 proofreads, so the translator isn't graded by its own model.
// These ignore KAMBUZ_MODEL, which is about the extraction pipeline; set them per agent.
export const AGENT_DEFAULT_MODELS: Partial<Record<AgentName, string>> = {
  translator: "claude-sonnet-5-5",
  proofreader: "claude-opus-5-5",
};

// Agents missing here send no effort, so they run at the model's default (medium on Haiku 5.5).
// The scout at medium sometimes collapses a multi-dish video into one dish; at high it found
// every dish in repeated runs, while xhigh overthought and ran out of max_tokens.
export const DEFAULT_EFFORT: Partial<Record<AgentName, Effort>> = { scout: "high", translator: "high", proofreader: "high" };

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MIN_COMPLETENESS = 0.3;

export interface Config {
  models: Record<AgentName, string>;
  /** Thinking effort per agent; an agent missing here gets no effort field in its requests. */
  effort: Partial<Record<AgentName, Effort>>;
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

/** KAMBUZ_EFFORT_<AGENT>=low|medium|high|xhigh|max; anything else is ignored rather than sent to the API. */
function effortFrom(env: NodeJS.ProcessEnv): Partial<Record<AgentName, Effort>> {
  const effort: Partial<Record<AgentName, Effort>> = { ...DEFAULT_EFFORT };
  for (const n of AGENT_NAMES) {
    const raw = env[`KAMBUZ_EFFORT_${n.toUpperCase()}`]?.trim().toLowerCase();
    if (raw && isEffort(raw)) effort[n] = raw;
  }
  return effort;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const models = Object.fromEntries(
    AGENT_NAMES.map((n) => [n, env[`KAMBUZ_MODEL_${n.toUpperCase()}`] ?? AGENT_DEFAULT_MODELS[n] ?? env.KAMBUZ_MODEL ?? DEFAULT_MODEL]),
  ) as Record<AgentName, string>;
  return {
    models,
    effort: effortFrom(env),
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
