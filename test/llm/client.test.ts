import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, LlmParseError } from "../../src/llm/client.js";
import { UsageLedger } from "../../src/llm/usage.js";
import { buildConfig } from "../../src/config.js";

const Out = z.object({ answer: z.string() });

function fakeAnthropic(responses: Array<{ parsed_output: unknown; stop_reason: string }>) {
  const parse = vi.fn(async (_request?: unknown) => ({ ...responses.shift()!, usage: { input_tokens: 10, output_tokens: 2 } }));
  return { client: { messages: { parse } } as any, parse };
}

describe("callStructured", () => {
  it("returns parsed output and records usage under the agent", async () => {
    const { client, parse } = fakeAnthropic([{ parsed_output: { answer: "ok" }, stop_reason: "end_turn" }]);
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    const out = await llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out });
    expect(out).toEqual({ answer: "ok" });
    expect(ledger.byAgent().scout.calls).toBe(1);
    expect(parse.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-5", system: "s" });
  });
  it("retries once when parsed_output is null, then throws", async () => {
    const { client, parse } = fakeAnthropic([
      { parsed_output: null, stop_reason: "end_turn" },
      { parsed_output: null, stop_reason: "end_turn" },
    ]);
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toBeInstanceOf(LlmParseError);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(ledger.byAgent().scout.calls).toBe(2);
  });
  it("retries when the SDK throws a structured-output parse error, then succeeds", async () => {
    // messages.parse() THROWS an AnthropicError when the content doesn't satisfy the
    // Zod schema — parsed_output is never null in that case, so the retry has to catch it.
    const parse = vi.fn(async (_request?: unknown) => {
      if (parse.mock.calls.length === 1) {
        throw new Error('Failed to parse structured output: AnthropicError: invalid_type at "answer"');
      }
      return { parsed_output: { answer: "ok" }, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
    });
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, { messages: { parse } } as any);
    expect(await llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).toEqual({ answer: "ok" });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("gives up with a parse error when both attempts throw", async () => {
    const parse = vi.fn(async (_request?: unknown) => {
      throw new Error("Failed to parse structured output: AnthropicError: bad");
    });
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, { messages: { parse } } as any);
    const err = await llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmParseError);
    expect(err.reason).toBe("parse");
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("does not retry a truncated response and names the agent and the token cap", async () => {
    const { client, parse } = fakeAnthropic([
      { parsed_output: { answer: "partial" }, stop_reason: "max_tokens" },
      { parsed_output: { answer: "ok" }, stop_reason: "end_turn" },
    ]);
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    const err = await llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out, maxTokens: 512 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmParseError);
    expect(err.reason).toBe("truncated");
    expect(err.message).toMatch(/scout/);
    expect(err.message).toMatch(/512/);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(ledger.byAgent().scout.calls).toBe(1);
  });

  it("throws on refusal without retrying", async () => {
    const { client, parse } = fakeAnthropic([{ parsed_output: null, stop_reason: "refusal" }]);
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toThrow(/refus/i);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(ledger.byAgent().scout.calls).toBe(1);
  });
});
