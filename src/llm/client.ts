import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { AgentName, Config, Effort } from "../config.js";
import type { UsageLedger } from "./usage.js";

export type LlmParseReason = "refusal" | "parse" | "truncated";

export class LlmParseError extends Error {
  readonly reason: LlmParseReason;

  constructor(message: string, reason: LlmParseReason) {
    super(message);
    this.name = "LlmParseError";
    this.reason = reason;
  }
}

/**
 * messages.parse() throws instead of returning `parsed_output: null` when the content
 * doesn't satisfy the schema — the SDK wraps the Zod failure in an AnthropicError whose
 * message starts with this. That is the retryable case, so it has to be caught, not awaited.
 */
const PARSE_FAILURE = "Failed to parse structured output";

function isParseFailure(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(PARSE_FAILURE);
}

export interface StructuredCall<T> {
  agent: AgentName;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Overrides config.models[agent] for this call; usage is priced under this model. */
  model?: string;
  /** Overrides config.effort[agent] for this call. */
  effort?: Effort;
}

export interface LlmClient {
  callStructured<T>(opts: StructuredCall<T>): Promise<T>;
}

// The SDK refuses non-streaming calls whose max_tokens implies more than ten minutes
// unless a timeout is given explicitly; the scout's 32k cap trips that guard.
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export function createLlmClient(config: Config, ledger: UsageLedger, anthropic: Anthropic = new Anthropic()): LlmClient {
  async function once<T>(opts: StructuredCall<T>): Promise<T> {
    const model = opts.model ?? config.models[opts.agent];
    const effort = opts.effort ?? config.effort[opts.agent];
    const format = zodOutputFormat(opts.schema);
    const maxTokens = opts.maxTokens ?? 16000;
    let response;
    try {
      response = await anthropic.messages.parse({
        model,
        max_tokens: maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        // Without an effort the request is exactly what it was before effort existed.
        output_config: effort ? { format, effort } : { format },
      }, { timeout: REQUEST_TIMEOUT_MS });
    } catch (e) {
      // The throw carries no message, so this attempt's usage is not knowable.
      if (isParseFailure(e)) {
        ledger.addUnbilled(opts.agent, model);
        throw new LlmParseError(`${opts.agent}: ${(e as Error).message}`, "parse");
      }
      throw e;
    }
    ledger.add(opts.agent, model, response.usage);
    if (response.stop_reason === "refusal") throw new LlmParseError(`${opts.agent}: model refused the request`, "refusal");
    // A truncated answer is checked before parsed_output: retrying with the same cap
    // would only burn the same tokens again, so it is reported, not retried.
    if (response.stop_reason === "max_tokens") {
      throw new LlmParseError(`${opts.agent}: response hit max_tokens=${maxTokens} and was truncated; raise the limit or shorten the input`, "truncated");
    }
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
