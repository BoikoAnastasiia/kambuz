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
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toBeInstanceOf(LlmParseError);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it("throws on refusal without retrying", async () => {
    const { client, parse } = fakeAnthropic([{ parsed_output: null, stop_reason: "refusal" }]);
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toThrow(/refus/i);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
