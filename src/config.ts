import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_NAMES = ["scout", "extractor", "verifier", "categorizer", "judge"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

export interface Config {
  models: Record<AgentName, string>;
  concurrency: number;
  paths: { cache: string; catalog: string; reports: string; vocab: string; prompts: string; eval: string };
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const models = Object.fromEntries(
    AGENT_NAMES.map((n) => [n, env[`KAMBUZ_MODEL_${n.toUpperCase()}`] ?? env.KAMBUZ_MODEL ?? "claude-sonnet-5"]),
  ) as Record<AgentName, string>;
  return {
    models,
    concurrency: Number(env.KAMBUZ_CONCURRENCY ?? 4),
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
