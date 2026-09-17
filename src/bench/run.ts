import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { buildCategorizerUser, runCategorizerDetailed } from "../agents/categorizer.js";
import { buildVerifierUser, flagsFromVerification, runVerifier } from "../agents/verifier.js";
import { formatCost } from "../llm/usage.js";
import { loadPrompt } from "../prompts/load.js";
import { estimateCost } from "./estimate.js";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import { UsageLedger } from "../llm/usage.js";
import type { Categorization, DraftRecipe, Verification } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";
import { loadCategorizerTruth, scoreCategorizer, type CategorizerCase, type CategorizerLabel, type CategorizerVariantScore, type DishKeyAgreement } from "./categorizer.js";
import { loadBenchInputs, segmentKey, type BenchSegment } from "./inputs.js";
import { generateMutations, PLANTED_KINDS, type FlagTarget, type Mutation, type MutationKind } from "./mutations.js";
import { renderBenchConsole, renderBenchHtml } from "./report.js";
import { aggregateUsage, type CaseUsage, type VariantUsage } from "./usage.js";
import { variantLabel, type Variant } from "./variants.js";

export type { VariantUsage } from "./usage.js";
import { scoreVerifier, type VerifierCase, type VerifierVariantScore } from "./verifier.js";

export const BENCH_AGENTS = ["categorizer", "verifier"] as const;
export type BenchAgent = (typeof BENCH_AGENTS)[number];

export interface BenchOptions {
  agent: BenchAgent;
  variants: Variant[];
  repeat: number;
}

export interface BenchDeps {
  config: Config;
  vocab: Vocab;
  /**
   * Builds one variant's client; its usage must land in the given ledger. Only called once the
   * run is confirmed, so a dry run never constructs a client at all.
   */
  makeLlm: (ledger: UsageLedger) => LlmClient;
}


/** A segment the bench runs on, plus (verifier only) the drafts derived from it. */
export interface PlannedSegment {
  videoId: string;
  segmentIndex: number;
  workingName: string;
  label?: CategorizerLabel;
  mutations?: Array<{ kind: MutationKind; target: FlagTarget | null; detail: string }>;
}

interface Job {
  variant: Variant;
  repeat: number;
  input: BenchSegment;
  mutation?: Mutation;
  detail?: string;
  /** Length of system + user prompt, for the cost estimate. */
  inputChars: number;
}

export interface BenchPlan extends BenchOptions {
  segments: PlannedSegment[];
  skipped: string[];
  truthErrors: string[];
  jobs: Job[];
}

interface ResultBase {
  /** sha256 of the agent's prompt file and of the vocabulary: two reports are comparable only when these match. */
  promptsHash: string;
  vocabHash: string;
  startedAt: string;
  finishedAt: string;
  repeat: number;
  variants: Variant[];
  segments: PlannedSegment[];
  skipped: string[];
  truthErrors: string[];
  usage: Record<string, VariantUsage>;
}

export type BenchResult =
  | (ResultBase & { agent: "categorizer"; cases: CategorizerCase[]; scores: { variants: CategorizerVariantScore[]; agreement: DishKeyAgreement[] } })
  | (ResultBase & { agent: "verifier"; cases: VerifierCase[]; scores: VerifierVariantScore[] });

export function truthFile(config: Config): string {
  return path.join(config.paths.eval, "bench", "categorizer.json");
}

/** A one-line, human-readable account of what was planted, for the plan and the HTML report. */
export function describeMutation(original: DraftRecipe, m: Mutation): string {
  if (!m.target) return "unmodified draft";
  const amount = (q: number | null, unit: string | null) => `${q ?? "?"}${unit ? ` ${unit}` : ""}`;
  if (m.target.kind === "ingredient") {
    const index = m.draft.ingredients.findIndex((i) => i.rawName === m.target!.ref);
    const after = m.draft.ingredients[index];
    if (index >= original.ingredients.length) return `+ ${after.rawName} ${amount(after.quantity, after.unit)}`;
    const before = original.ingredients[index];
    return `${before.rawName}: ${amount(before.quantity, before.unit)} → ${amount(after.quantity, after.unit)}`;
  }
  const after = m.draft.steps.find((st) => String(st.order) === m.target!.ref)!;
  const before = original.steps.find((st) => st.order === after.order);
  return before ? `step ${after.order}: "${before.text}" → "${after.text}"` : `+ step ${after.order}: ${after.text}`;
}

/** Reads inputs and labels and lays out every call. Never touches an LLM. */
export async function planBench(opts: BenchOptions, deps: Pick<BenchDeps, "config" | "vocab">): Promise<BenchPlan> {
  const { segments: inputs, skipped } = await loadBenchInputs(deps.config.paths.cache);
  const truthErrors: string[] = [];
  const segments: PlannedSegment[] = [];
  const jobs: Job[] = [];
  const system = await loadPrompt(opts.agent, deps.config.paths.prompts);
  const everyRun = (input: BenchSegment, extra: Omit<Job, "variant" | "repeat" | "input">) => {
    for (const variant of opts.variants) for (let repeat = 0; repeat < opts.repeat; repeat++) jobs.push({ variant, repeat, input, ...extra });
  };

  if (opts.agent === "categorizer") {
    const truth = await loadCategorizerTruth(truthFile(deps.config), deps.vocab);
    truthErrors.push(...truth.errors);
    const byKey = new Map(inputs.map((s) => [segmentKey(s), s]));
    for (const label of truth.labels) {
      const input = byKey.get(segmentKey(label));
      if (!input) {
        skipped.push(`${segmentKey(label)}: labeled but has no cached draft`);
        continue;
      }
      segments.push({ videoId: input.videoId, segmentIndex: input.segmentIndex, workingName: input.segment.workingName, label });
      everyRun(input, { inputChars: system.length + buildCategorizerUser(input.draft, deps.vocab).length });
    }
  } else {
    for (const input of inputs) {
      const mutations = generateMutations(input, { vocab: deps.vocab, segments: inputs });
      const described = mutations.map((m) => ({ kind: m.kind, target: m.target, detail: describeMutation(input.draft, m) }));
      segments.push({ videoId: input.videoId, segmentIndex: input.segmentIndex, workingName: input.segment.workingName, mutations: described });
      mutations.forEach((mutation, i) =>
        everyRun(input, { mutation, detail: described[i].detail, inputChars: system.length + buildVerifierUser(input.segment, mutation.draft).length }),
      );
    }
  }
  return { ...opts, segments, skipped, truthErrors, jobs };
}

export function planSummary(plan: BenchPlan): string {
  return `${plan.jobs.length} calls across ${plan.variants.length} variant${plan.variants.length === 1 ? "" : "s"} on ${plan.segments.length} segment${plan.segments.length === 1 ? "" : "s"}`;
}

export function renderPlan(plan: BenchPlan): string[] {
  const lines = [`bench ${plan.agent}: ${planSummary(plan)} (×${plan.repeat} repeat${plan.repeat === 1 ? "" : "s"}; parse retries can add calls)`];
  lines.push(`variants: ${plan.variants.map(variantLabel).join(", ")}`);
  if (plan.agent === "verifier") {
    const counts = new Map<string, number>();
    for (const s of plan.segments) for (const m of s.mutations ?? []) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    const order = ["clean", ...PLANTED_KINDS].filter((k) => counts.has(k));
    lines.push(`drafts per variant and repeat: ${order.map((k) => `${counts.get(k)} ${k}`).join(", ")}`);
  }
  if (plan.truthErrors.length) lines.push(`ignored ground-truth rows (${plan.truthErrors.length}):`, ...plan.truthErrors.map((e) => `  ${e}`));
  if (plan.jobs.length) {
    lines.push(`rough estimate per variant (input ≈ prompt chars / 3; output ≈ ${plan.agent === "verifier" ? 2500 : 150} tokens per call, which thinking can exceed):`);
    for (const v of plan.variants) {
      const e = estimateCost(v.model, plan.agent, plan.jobs.filter((j) => j.variant.id === v.id).map((j) => j.inputChars));
      const k = (n: number) => `${Math.round(n / 1000)}k`;
      lines.push(`  ${variantLabel(v)}: ~${formatCost(e.costUsd)} (${e.calls} calls, ~${k(e.inputTokens)} in, ~${k(e.outputTokens)} out)`);
    }
  }
  if (plan.repeat < 3) lines.push(`note: with --repeat ${plan.repeat} the intervals will be wide; --repeat 3 or more is recommended before choosing a model`);
  if (plan.skipped.length) lines.push(`skipped (${plan.skipped.length}):`, ...plan.skipped.map((s) => `  ${s}`));
  return lines;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Recomputes every score (and the usage totals) from the stored cases alone. */
export function rescoreResult(result: BenchResult): BenchResult {
  const ids = result.variants.map((v) => v.id);
  const usage = aggregateUsage(result.cases, ids);
  if (result.agent === "categorizer") {
    const labels = result.segments.flatMap((s) => (s.label ? [s.label] : []));
    return { ...result, usage, scores: scoreCategorizer(result.cases, labels, ids, result.repeat) };
  }
  return { ...result, usage, scores: scoreVerifier(result.cases, ids) };
}

export async function executeBench(plan: BenchPlan, deps: BenchDeps, onProgress?: (done: number, total: number) => void): Promise<BenchResult> {
  const startedAt = new Date().toISOString();
  const promptsDir = deps.config.paths.prompts;
  const promptsHash = sha256(await readFile(path.join(promptsDir, `${plan.agent}.md`), "utf8"));
  const vocabHash = sha256(JSON.stringify(deps.vocab));

  const limit = pLimit(deps.config.concurrency);
  let done = 0;
  /** Each case gets its own ledger, so its tokens and cost can be stored with it. */
  const timed = <T>(job: Job, work: (llm: LlmClient) => Promise<T>) =>
    limit(async () => {
      const ledger = new UsageLedger();
      const base = deps.makeLlm(ledger);
      const v = job.variant;
      // The agents stay unaware of the bench: the variant's model and effort ride on every call.
      const llm: LlmClient = { callStructured: (opts) => base.callStructured({ ...opts, model: v.model, ...(v.effort ? { effort: v.effort } : {}) }) };
      const t0 = Date.now();
      let outcome: { ok: true; value: T } | { ok: false; error: string };
      try {
        outcome = { ok: true, value: await work(llm) };
      } catch (e) {
        // One variant's API rejection (say, effort on a model without it) is a result, not a crash.
        outcome = { ok: false, error: errorMessage(e) };
      }
      onProgress?.(++done, plan.jobs.length);
      const t = ledger.total();
      const usage: CaseUsage = { model: v.model, calls: t.calls, input: t.input, output: t.output, costUsd: t.costUsd, unbilled: ledger.unbilledCalls() };
      return { outcome, ms: Date.now() - t0, usage };
    });

  const base = (job: Job) => ({ variant: job.variant.id, repeat: job.repeat, videoId: job.input.videoId, segmentIndex: job.input.segmentIndex });
  const common = () => ({
    promptsHash, vocabHash, startedAt, finishedAt: new Date().toISOString(), repeat: plan.repeat, variants: plan.variants,
    segments: plan.segments, skipped: plan.skipped, truthErrors: plan.truthErrors, usage: {},
  });

  if (plan.agent === "categorizer") {
    const cases = await Promise.all(
      plan.jobs.map(async (job): Promise<CategorizerCase> => {
        const { outcome, ms, usage } = await timed<{ categorization: Categorization; rawCuisine: string }>(job, (llm) => runCategorizerDetailed(job.input.draft, deps.vocab, llm, promptsDir));
        return outcome.ok
          ? { ...base(job), ok: true, output: outcome.value.categorization, rawCuisine: outcome.value.rawCuisine, ms, usage }
          : { ...base(job), ok: false, error: outcome.error, ms, usage };
      }),
    );
    return rescoreResult({ agent: "categorizer", ...common(), cases, scores: { variants: [], agreement: [] } });
  }

  const cases = await Promise.all(
    plan.jobs.map(async (job): Promise<VerifierCase> => {
      const mutation = job.mutation!;
      const { outcome, ms, usage } = await timed<Verification>(job, (llm) => runVerifier(job.input.segment, mutation.draft, llm, promptsDir));
      const shared = { ...base(job), mutation: mutation.kind, target: mutation.target, draft: mutation.draft, ms, usage };
      return outcome.ok
        ? { ...shared, ok: true, verification: outcome.value, flags: flagsFromVerification(mutation.draft, outcome.value) }
        : { ...shared, ok: false, error: outcome.error };
    }),
  );
  return rescoreResult({ agent: "verifier", ...common(), cases, scores: [] });
}

/**
 * `kambuz bench rescore <json>`: re-scores a saved report with the current scoring code.
 * Reads only the file; no client, no call. Writes <json stem>.rescored.html beside it.
 */
export async function rescoreCommand(file: string, log: (line: string) => void): Promise<{ result: BenchResult; html: string }> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Partial<BenchResult>;
  if (!raw || !(BENCH_AGENTS as readonly string[]).includes(raw.agent as string) || !Array.isArray(raw.cases) || !Array.isArray(raw.variants) || !Array.isArray(raw.segments)) {
    throw new Error(`${file} is not a bench report (expected agent, variants, segments and cases)`);
  }
  const result = rescoreResult(raw as BenchResult);
  const html = file.replace(/\.json$/, "") + ".rescored.html";
  await writeFile(html, renderBenchHtml(result));
  log(renderBenchConsole(result));
  log("");
  log(`html report: ${html}`);
  return { result, html };
}

export async function writeBenchReports(result: BenchResult, reportsDir: string): Promise<{ json: string; html: string }> {
  await mkdir(reportsDir, { recursive: true });
  const stem = `bench-${result.agent}-${result.startedAt.replace(/[:.]/g, "-")}`;
  const json = path.join(reportsDir, `${stem}.json`);
  const html = path.join(reportsDir, `${stem}.html`);
  await writeFile(json, JSON.stringify(result, null, 2));
  await writeFile(html, renderBenchHtml(result));
  return { json, html };
}

/**
 * The whole `kambuz bench` flow. Without `yes` it only prints the plan: no client is built
 * and no call is made. With it, runs, writes reports/bench-<agent>-<stamp>.{json,html} and
 * prints a per-variant table.
 */
export async function benchCommand(
  opts: BenchOptions & { yes: boolean },
  deps: BenchDeps,
  log: (line: string) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<{ plan: BenchPlan; result: BenchResult | null; files: { json: string; html: string } | null }> {
  const plan = await planBench(opts, deps);
  for (const line of renderPlan(plan)) log(line);
  if (plan.jobs.length === 0) {
    log(opts.agent === "categorizer" ? `nothing to run: no usable labels in ${truthFile(deps.config)}` : "nothing to run: no cached segment has both scout.json and its extract draft");
    return { plan, result: null, files: null };
  }
  if (!opts.yes) {
    log("dry run: nothing was called. Re-run with --yes to spend the calls above.");
    return { plan, result: null, files: null };
  }
  const result = await executeBench(plan, deps, onProgress);
  const files = await writeBenchReports(result, deps.config.paths.reports);
  log("");
  log(renderBenchConsole(result));
  log("");
  log(`json: ${files.json}`);
  log(`html report: ${files.html}`);
  return { plan, result, files };
}
