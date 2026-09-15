import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { AgentName, Config } from "../config.js";
import type { UsageLedger } from "./usage.js";

export class LlmParseError extends Error {
  readonly reason: "refusal" | "parse";

  constructor(message: string, reason: "refusal" | "parse") {
    super(message);
    this.reason = reason;
  }
}

export interface StructuredCall<T> {
  agent: AgentName;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LlmClient {
  callStructured<T>(opts: StructuredCall<T>): Promise<T>;
}

export function createLlmClient(config: Config, ledger: UsageLedger, anthropic: Anthropic = new Anthropic()): LlmClient {
  async function once<T>(opts: StructuredCall<T>): Promise<T> {
    const model = config.models[opts.agent];
    const response = await anthropic.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    ledger.add(opts.agent, model, response.usage);
    if (response.stop_reason === "refusal") throw new LlmParseError(`${opts.agent}: model refused the request`, "refusal");
    if (response.parsed_output == null) throw new LlmParseError(`${opts.agent}: response did not match schema`, "parse");
    return response.parsed_output as T;
  }

  return {
    async callStructured<T>(opts: StructuredCall<T>): Promise<T> {
      try {
        return await once(opts);
      } catch (e) {
        if (e instanceof LlmParseError && e.reason === "parse") return once(opts);
        throw e;
      }
    },
  };
}
