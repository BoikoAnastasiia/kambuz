import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildConfig, type Config } from "../../src/config.js";
import type { LlmClient, StructuredCall } from "../../src/llm/client.js";
import type { UsageLedger } from "../../src/llm/usage.js";
import { benchCommand, rescoreCommand, type BenchDeps } from "../../src/bench/run.js";
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

/**
 * Categorizer: right on sonnet, wrong cuisine on haiku. Verifier: sonnet rejects exactly the
 * planted items, haiku silently omits them, opus rejects everything. Any effort on haiku fails.
 */
function fakeLlmFactory() {
  const calls: StructuredCall<unknown>[] = [];
  const makeLlm = vi.fn((ledger: UsageLedger): LlmClient => ({
    async callStructured<T>(opts: StructuredCall<T>): Promise<T> {
      calls.push(opts as StructuredCall<unknown>);
      const model = opts.model!;
      if (model.includes("haiku") && opts.effort) throw new Error("400 effort is not supported on this model");
      // opus pretends one attempt per call failed to parse before succeeding: billed but unrecorded
      if (model.includes("opus")) ledger.addUnbilled(opts.agent, model);
      ledger.add(opts.agent, model, { input_tokens: 100, output_tokens: 10 });
      const strong = !model.includes("haiku");
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
      const original = opts.user.includes(lasagnaSegment.rawText) ? lasagnaDraft : soupDraft;
      const ingredients = [...opts.user.matchAll(/^- (.+) \[(?:stated|inferred|unknown)\] (.*)$/gm)].map(([, rawName, amount]) => ({
        rawName,
        quote: null,
        supported: original.ingredients.some((i) => i.rawName === rawName && `${i.quantity ?? "?"} ${i.unit ?? ""}`.trim() === amount),
      }));
      const steps = [...opts.user.matchAll(/^(\d+)\. (.*)$/gm)].map(([, order, text]) => ({
        order: Number(order),
        quote: null,
        supported: original.steps.some((st) => st.order === Number(order) && st.text === text),
      }));
      if (model.includes("opus")) return { ingredients: ingredients.map((i) => ({ ...i, supported: false })), steps: steps.map((st) => ({ ...st, supported: false })), confidence: 0 } as T;
      if (model.includes("haiku")) return { ingredients: ingredients.filter((i) => i.supported), steps: steps.filter((st) => st.supported), confidence: 1 } as T;
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
    expect(lines.join("\n")).toMatch(/--repeat 3 or more is recommended/);
    const plan = lines.join("\n");
    expect(plan).toMatch(/rough estimate/);
    expect(plan).toMatch(/claude-sonnet-5 \(default effort: high\): ~\$\d+\.\d+ \(18 calls/);
    expect(plan).toMatch(/claude-haiku-4-5: ~\$\d+\.\d+ \(18 calls/);
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

    expect(makeLlm).toHaveBeenCalledTimes(12); // one client and ledger per case, so each case's usage is stored
    expect(calls.filter((c) => c.effort === "low")).toHaveLength(4);
    expect(calls.filter((c) => c.model === "claude-sonnet-5" && c.effort === undefined)).toHaveLength(4);

    const r = out.result!;
    if (r.agent !== "categorizer") throw new Error("wrong agent");
    const by = (id: string) => r.scores.variants.find((v) => v.variant === id)!;
    expect(by("claude-sonnet-5")).toMatchObject({
      cases: 4, errors: 0, mealTypesJaccard: 1,
      cuisine: { hits: 4, total: 4 }, category: { hits: 4, total: 4 }, mealTypesExact: { hits: 4, total: 4 }, dishKeyStability: { hits: 2, total: 2 },
    });
    expect(by("claude-haiku-4-5")).toMatchObject({ cases: 4, errors: 0, cuisine: { hits: 0, total: 4 }, category: { hits: 4, total: 4 } });
    // failed calls are misses, not missing data
    expect(by("claude-haiku-4-5:low")).toMatchObject({ cases: 4, errors: 4, cuisine: { hits: 0, total: 4, rate: 0 }, mealTypesJaccard: 0 });
    expect(r.cases.find((c) => c.variant === "claude-haiku-4-5:low" && !c.ok)).toMatchObject({ error: expect.stringMatching(/effort is not supported/) });
    expect(r.cases.find((c) => c.variant === "claude-sonnet-5" && c.ok)).toMatchObject({ output: { dishKey: expect.stringMatching(/^(lasagna|soup)$/) } });
    expect(r.scores.agreement.find((a) => a.a === "claude-sonnet-5" && a.b === "claude-haiku-4-5")).toMatchObject({ agreement: { hits: 2, total: 2 } });

    expect(r.usage["claude-sonnet-5"]).toMatchObject({ calls: 4, input: 400, output: 40 });
    expect(r.usage["claude-sonnet-5"].costUsd).toBeCloseTo((4 * (100 * 2 + 10 * 10)) / 1_000_000, 12);
    expect(r.usage["claude-haiku-4-5"].costUsd).toBeCloseTo((4 * (100 * 1 + 10 * 5)) / 1_000_000, 12);
    expect(r.usage["claude-haiku-4-5:low"]).toMatchObject({ calls: 0, costUsd: 0, unbilled: 0 });
    // no successful call: no cost to show, rather than a misleading $0
    expect(text).toMatch(/claude-haiku-4-5:low .*· — · latency/);

    const json = JSON.parse(await readFile(out.files!.json, "utf8"));
    expect(json.promptsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.vocabHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.cases.find((c: any) => c.variant === "claude-haiku-4-5" && c.ok)).toMatchObject({ rawCuisine: "other", usage: { model: "claude-haiku-4-5", calls: 1, input: 100, output: 10 } });
    expect(path.basename(out.files!.json)).toMatch(/^bench-categorizer-.+\.json$/);
    expect(json.cases).toHaveLength(12);
    const html = await readFile(out.files!.html, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("claude-haiku-4-5:low");
    expect(html).toContain("Лазанья");
    expect(html).toContain('class="miss"');
    expect(text).toContain(out.files!.html);
    expect(text).toMatch(/4 failed \(counted as misses\), first error: 400 effort is not supported/);
    expect(html).toContain('class="has-errors"');
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
  it("separates rejection from omission, shows false positives, excludes pre-flagged changes and counts errors as misses", async () => {
    const config = await setup([]);
    const { makeLlm } = fakeLlmFactory();
    const out = await benchCommand(
      { agent: "verifier", variants: variants("claude-sonnet-5,claude-haiku-4-5,claude-opus-5,claude-haiku-4-5:low"), repeat: 1, yes: true },
      { config, vocab, makeLlm },
      () => {},
    );
    const r = out.result!;
    if (r.agent !== "verifier") throw new Error("wrong agent");
    const by = (id: string) => r.scores.find((v) => v.variant === id)!;

    const sonnet = by("claude-sonnet-5");
    expect(sonnet).toMatchObject({ cases: 9, errors: 0, cleanFlagsMean: 0, noiseMean: 0 });
    expect(sonnet.overall).toMatchObject({ rejected: 7, missing: 0, detection: { hits: 7, total: 7 } });
    for (const kind of ["extra-ingredient", "quantity-x1.5", "unit-swap", "changed-step-number", "extra-step"] as const) {
      expect(sonnet.detection[kind].detection.rate).toBe(1);
    }
    // лук, фарш, соль and картошка: unknown-provenance ingredients are presence-checked too
    expect(sonnet.falsePositives.ingredients).toMatchObject({ hits: 0, total: 4 });

    // omitting the planted entries gets them flagged by flagsFromVerification, but is not detection
    const haiku = by("claude-haiku-4-5");
    expect(haiku.overall).toMatchObject({ rejected: 0, missing: 7, detection: { hits: 0, total: 7 } });

    // flagging everything: every addition caught, every clean item a false positive, modified items pre-flagged
    const opus = by("claude-opus-5");
    expect(opus.overall).toMatchObject({ rejected: 4, excluded: 3, detection: { hits: 4, total: 4 } });
    expect(opus.falsePositives.ingredients).toMatchObject({ hits: 4, total: 4, rate: 1 });
    expect(opus.falsePositives.steps).toMatchObject({ hits: 3, total: 3, rate: 1 });

    const failing = by("claude-haiku-4-5:low");
    expect(failing).toMatchObject({ cases: 9, errors: 9 });
    expect(failing.overall).toMatchObject({ errors: 7, detection: { hits: 0, total: 7, rate: 0 } });

    expect(r.usage["claude-haiku-4-5"].calls).toBe(9);
    expect(r.usage["claude-opus-5"]).toMatchObject({ calls: 9, unbilled: 9 });
    expect(r.cases.every((c) => c.draft.ingredients.length > 0)).toBe(true);
    const html = await readFile(out.files!.html, "utf8");
    expect(html).toContain("changed-step-number");
    expect(html).toContain("omitted");
    expect(html).toContain("pre-flagged (excluded)");
    expect(html).toContain("claude-sonnet-5 (default effort: high)");
    expect(html).toMatch(/≥\$0\.\d+/);

    // everything needed to re-score is in the JSON: drafts, verifier output, per-case usage
    const saved = JSON.parse(await readFile(out.files!.json, "utf8"));
    expect(saved.cases.find((c: any) => c.mutation === "unit-swap").draft.ingredients.some((i: any) => i.unit === "ml")).toBe(true);
    expect(saved.cases.find((c: any) => c.ok).usage).toMatchObject({ calls: 1, input: 100, output: 10 });
  });

  it("rescores a saved report from the JSON alone to the same numbers, with no client", async () => {
    const config = await setup(LABELS);
    const deps = (m: ReturnType<typeof fakeLlmFactory>) => ({ config, vocab, makeLlm: m.makeLlm });
    for (const agent of ["verifier", "categorizer"] as const) {
      const live = await benchCommand({ agent, variants: variants("claude-sonnet-5,claude-haiku-4-5,claude-haiku-4-5:low"), repeat: 2, yes: true }, deps(fakeLlmFactory()), () => {});
      const lines: string[] = [];
      const { result, html } = await rescoreCommand(live.files!.json, (l) => lines.push(l));
      expect(result.scores).toEqual(live.result!.scores);
      expect(result.usage).toEqual(live.result!.usage);
      expect(html).toMatch(/\.rescored\.html$/);
      expect(await readFile(html, "utf8")).toContain("<!doctype html>");
      expect(lines.join("\n")).toContain("claude-sonnet-5");
    }
  });

  it("refuses a file that is not a bench report", async () => {
    const config = await setup([]);
    const file = path.join(config.paths.eval, "not-a-report.json");
    await writeFile(file, JSON.stringify({ hello: 1 }));
    await expect(rescoreCommand(file, () => {})).rejects.toThrow(/not a bench report/);
  });
});
