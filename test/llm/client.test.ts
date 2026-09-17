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
    // the thrown attempt was billed by the API but carries no usage: the ledger notes it
    expect(ledger.unbilledCalls()).toBe(1);
    expect(ledger.total().calls).toBe(1);
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

describe("callStructured model and effort", () => {
  function ok() {
    return fakeAnthropic([{ parsed_output: { answer: "ok" }, stop_reason: "end_turn" }]);
  }

  it("sends exactly the format when no effort is set anywhere", async () => {
    const { client, parse } = ok();
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await llm.callStructured({ agent: "verifier", system: "s", user: "u", schema: Out });
    const body = parse.mock.calls[0][0] as any;
    expect(Object.keys(body.output_config)).toEqual(["format"]);
  });

  it("sends effort alongside the format when the call sets it", async () => {
    const { client, parse } = ok();
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await llm.callStructured({ agent: "verifier", system: "s", user: "u", schema: Out, effort: "low" });
    const body = parse.mock.calls[0][0] as any;
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format).toBeDefined();
  });

  it("applies the configured effort for the agent when the call has none, and the call's own effort wins", async () => {
    const config = buildConfig({ KAMBUZ_EFFORT_VERIFIER: "medium" });
    const a = ok();
    await createLlmClient(config, new UsageLedger(), a.client).callStructured({ agent: "verifier", system: "s", user: "u", schema: Out });
    expect((a.parse.mock.calls[0][0] as any).output_config.effort).toBe("medium");
    const b = ok();
    await createLlmClient(config, new UsageLedger(), b.client).callStructured({ agent: "verifier", system: "s", user: "u", schema: Out, effort: "high" });
    expect((b.parse.mock.calls[0][0] as any).output_config.effort).toBe("high");
    const c = ok();
    await createLlmClient(config, new UsageLedger(), c.client).callStructured({ agent: "scout", system: "s", user: "u", schema: Out });
    expect((c.parse.mock.calls[0][0] as any).output_config.effort).toBeUndefined();
  });

  it("honours a per-call model override and prices usage under that model", async () => {
    const { client, parse } = ok();
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    await llm.callStructured({ agent: "categorizer", system: "s", user: "u", schema: Out, model: "claude-haiku-4-5" });
    expect((parse.mock.calls[0][0] as any).model).toBe("claude-haiku-4-5");
    // haiku: 10 in * $1/M + 2 out * $5/M; sonnet would be 10*2 + 2*10 per M
    expect(ledger.byAgent().categorizer.costUsd).toBeCloseTo((10 * 1 + 2 * 5) / 1_000_000, 12);
  });
});
