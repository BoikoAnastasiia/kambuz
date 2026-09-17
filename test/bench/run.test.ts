import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildConfig, type Config } from "../../src/config.js";
import type { LlmClient, StructuredCall } from "../../src/llm/client.js";
import type { UsageLedger } from "../../src/llm/usage.js";
import { benchCommand, type BenchDeps } from "../../src/bench/run.js";
import { parseVariants } from "../../src/bench/variants.js";
import { makeCache, vocab, lasagnaDraft, soupDraft, lasagnaSegment, soupSegment } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(labels: unknown[]): Promise<Config> {
  const cache = await makeCache();
  const work = await mkdtemp(path.join(os.tmpdir(), "kambuz-bench-work-"));
  dirs.push(cache, work);
  await mkdir(path.join(work, "eval", "bench"), { recursive: true });
  await writeFile(path.join(work, "eval", "bench", "categorizer.json"), JSON.stringify(labels));
  const base = buildConfig({});
  return { ...base, concurrency: 3, paths: { ...base.paths, cache, eval: path.join(work, "eval"), reports: path.join(work, "reports") } };
}

const variants = (s: string) => {
  const r = parseVariants(s);
  if (!r.ok) throw new Error(r.error);
  return r.variants;
};

const LABELS = [
  { videoId: "v1", segmentIndex: 0, dish: "Лазанья", cuisine: "italian", category: "pasta", mealTypes: ["dinner"] },
  { videoId: "v1", segmentIndex: 1, dish: "Суп", cuisine: "russian", category: "soup", mealTypes: ["lunch"] },
  { videoId: "v2", segmentIndex: 0, dish: "Суп без черновика", cuisine: "russian", category: "soup", mealTypes: ["lunch"] },
  { videoId: "v1", segmentIndex: 5, dish: "плохая строка", cuisine: "klingon", category: "soup", mealTypes: ["lunch"] },
];

/** Answers like a strong model on "sonnet", a weak one on "haiku", and rejects any effort on haiku. */
function fakeLlmFactory() {
  const calls: StructuredCall<unknown>[] = [];
  const makeLlm = vi.fn((ledger: UsageLedger): LlmClient => ({
    async callStructured<T>(opts: StructuredCall<T>): Promise<T> {
      calls.push(opts as StructuredCall<unknown>);
      const model = opts.model!;
      if (model.includes("haiku") && opts.effort) throw new Error("400 effort is not supported on this model");
      ledger.add(opts.agent, model, { input_tokens: 100, output_tokens: 10 });
      const strong = model.includes("sonnet");
      if (opts.agent === "categorizer") {
        const lasagna = opts.user.includes("Лазанья");
        return {
          cuisine: strong ? (lasagna ? "italian" : "russian") : "other",
          category: lasagna ? "pasta" : "soup",
          mealTypes: lasagna ? ["dinner"] : ["lunch"],
          activeMinutes: null,
          totalMinutes: null,
          richness: "medium",
          dishKey: lasagna ? "Lasagna" : "soup",
        } as T;
      }
      // verifier: the strong model supports exactly what the original cached draft contains
      const original = opts.user.includes(lasagnaSegment.rawText) ? lasagnaDraft : soupDraft;
      const ingredients = [...opts.user.matchAll(/^- (.+) \[(?:stated|inferred|unknown)\] (.*)$/gm)].map(([, rawName, amount]) => ({
        rawName,
        quote: null,
        supported: !strong || original.ingredients.some((i) => i.rawName === rawName && `${i.quantity ?? "?"} ${i.unit ?? ""}`.trim() === amount),
      }));
      const steps = [...opts.user.matchAll(/^(\d+)\. (.*)$/gm)].map(([, order, text]) => ({
        order: Number(order),
        quote: null,
        supported: !strong || original.steps.some((st) => st.order === Number(order) && st.text === text),
      }));
      return { ingredients, steps, confidence: 0.9 } as T;
    },
  }));
  return { makeLlm, calls };
}

describe("benchCommand without --yes", () => {
  it("prints the plan and makes zero LLM calls", async () => {
    const config = await setup(LABELS);
    const { makeLlm, calls } = fakeLlmFactory();
    const lines: string[] = [];
    const out = await benchCommand({ agent: "verifier", variants: variants("claude-sonnet-5,claude-haiku-4-5"), repeat: 2, yes: false }, { config, vocab, makeLlm }, (l) => lines.push(l));
    expect(makeLlm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(out.result).toBeNull();
    // lasagna: clean + 5 planted; soup: clean + extra-ingredient + extra-step → 9 drafts × 2 variants × 2 repeats
    expect(lines.join("\n")).toContain("36 calls across 2 variants on 2 segments");
    expect(lines.join("\n")).toMatch(/v2#0: no extract-0\.json/);
    expect(lines.join("\n")).toMatch(/--yes/);
    await expect(readdir(config.paths.reports)).rejects.toThrow();
  });
});

describe("benchCommand categorizer", () => {
  it("scores each variant against the labels, records API errors per variant and writes both reports", async () => {
    const config = await setup(LABELS);
    const { makeLlm, calls } = fakeLlmFactory();
    const lines: string[] = [];
    const deps: BenchDeps = { config, vocab, makeLlm };
    const out = await benchCommand(
      { agent: "categorizer", variants: variants("claude-sonnet-5,claude-haiku-4-5,claude-haiku-4-5:low"), repeat: 2, yes: true },
      deps,
      (l) => lines.push(l),
    );
    const text = lines.join("\n");
    expect(text).toContain("12 calls across 3 variants on 2 segments");
    expect(text).toMatch(/row 4 .*klingon/);
    expect(text).toMatch(/v2#0: labeled but has no cached draft/);

    expect(makeLlm).toHaveBeenCalledTimes(3); // one client, one ledger, per variant
    expect(calls.filter((c) => c.effort === "low")).toHaveLength(4);
    expect(calls.filter((c) => c.model === "claude-sonnet-5" && c.effort === undefined)).toHaveLength(4);

    const r = out.result!;
    if (r.agent !== "categorizer") throw new Error("wrong agent");
    const by = (id: string) => r.scores.variants.find((v) => v.variant === id)!;
    expect(by("claude-sonnet-5")).toMatchObject({ cases: 4, errors: 0, cuisineAccuracy: 1, categoryAccuracy: 1, mealTypesExact: 1, mealTypesJaccard: 1, dishKeyStability: 1 });
    expect(by("claude-haiku-4-5")).toMatchObject({ cases: 4, errors: 0, cuisineAccuracy: 0, categoryAccuracy: 1 });
    expect(by("claude-haiku-4-5:low")).toMatchObject({ cases: 4, errors: 4, cuisineAccuracy: null });
    expect(r.cases.find((c) => c.variant === "claude-haiku-4-5:low" && !c.ok)).toMatchObject({ error: expect.stringMatching(/effort is not supported/) });
    expect(r.cases.find((c) => c.variant === "claude-sonnet-5" && c.ok)).toMatchObject({ output: { dishKey: expect.stringMatching(/^(lasagna|soup)$/) } });
    expect(r.scores.agreement.find((a) => a.a === "claude-sonnet-5" && a.b === "claude-haiku-4-5")).toMatchObject({ segments: 2, rate: 1 });

    expect(r.usage["claude-sonnet-5"]).toMatchObject({ calls: 4, input: 400, output: 40 });
    expect(r.usage["claude-sonnet-5"].costUsd).toBeCloseTo((4 * (100 * 2 + 10 * 10)) / 1_000_000, 12);
    expect(r.usage["claude-haiku-4-5"].costUsd).toBeCloseTo((4 * (100 * 1 + 10 * 5)) / 1_000_000, 12);
    expect(r.usage["claude-haiku-4-5:low"]).toMatchObject({ calls: 0, costUsd: 0 });

    const json = JSON.parse(await readFile(out.files!.json, "utf8"));
    expect(path.basename(out.files!.json)).toMatch(/^bench-categorizer-.+\.json$/);
    expect(json.cases).toHaveLength(12);
    const html = await readFile(out.files!.html, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("claude-haiku-4-5:low");
    expect(html).toContain("Лазанья");
    expect(html).toContain('class="miss"');
    expect(text).toContain(out.files!.html);
    expect(text).toMatch(/claude-haiku-4-5:low: 4 failed, first error: 400 effort is not supported/);
  });

  it("refuses to run with nothing labeled", async () => {
    const config = await setup([]);
    const { makeLlm } = fakeLlmFactory();
    const lines: string[] = [];
    const out = await benchCommand({ agent: "categorizer", variants: variants("claude-sonnet-5"), repeat: 1, yes: true }, { config, vocab, makeLlm }, (l) => lines.push(l));
    expect(out.result).toBeNull();
    expect(makeLlm).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/nothing to run/);
  });
});

describe("benchCommand verifier", () => {
  it("detects every planted error on the strong model, none on the weak one", async () => {
    const config = await setup([]);
    const { makeLlm } = fakeLlmFactory();
    const out = await benchCommand({ agent: "verifier", variants: variants("claude-sonnet-5,claude-haiku-4-5"), repeat: 1, yes: true }, { config, vocab, makeLlm }, () => {});
    const r = out.result!;
    if (r.agent !== "verifier") throw new Error("wrong agent");
    const by = (id: string) => r.scores.find((v) => v.variant === id)!;
    const sonnet = by("claude-sonnet-5");
    expect(sonnet).toMatchObject({ cases: 9, errors: 0, overallDetection: 1, cleanFlagsMean: 0, noiseMean: 0 });
    expect(sonnet.detection["extra-ingredient"]).toEqual({ detected: 2, total: 2, rate: 1 });
    expect(sonnet.detection["quantity-x1.5"]).toEqual({ detected: 1, total: 1, rate: 1 });
    expect(sonnet.detection["unit-swap"]).toEqual({ detected: 1, total: 1, rate: 1 });
    expect(sonnet.detection["changed-step-number"]).toEqual({ detected: 1, total: 1, rate: 1 });
    expect(sonnet.detection["extra-step"]).toEqual({ detected: 2, total: 2, rate: 1 });
    expect(by("claude-haiku-4-5")).toMatchObject({ cases: 9, overallDetection: 0, cleanFlagsMean: 0, noiseMean: 0 });
    expect(r.usage["claude-haiku-4-5"].calls).toBe(9);
    expect(r.cases.every((c) => !c.ok || Array.isArray(c.verification?.ingredients))).toBe(true);
    expect(await readFile(out.files!.html, "utf8")).toContain("changed-step-number");
  });
});
