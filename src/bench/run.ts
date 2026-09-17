import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { runCategorizer } from "../agents/categorizer.js";
import { flagsFromVerification, runVerifier } from "../agents/verifier.js";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import { UsageLedger } from "../llm/usage.js";
import type { Categorization, DraftRecipe, RecipeFlag, Verification } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";
import { loadCategorizerTruth, scoreCategorizer, type CategorizerCase, type CategorizerLabel, type CategorizerVariantScore, type DishKeyAgreement } from "./categorizer.js";
import { loadBenchInputs, segmentKey, type BenchSegment } from "./inputs.js";
import { generateMutations, type FlagTarget, type Mutation, type MutationKind } from "./mutations.js";
import { renderBenchConsole, renderBenchHtml } from "./report.js";
import type { Variant } from "./variants.js";
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

export interface VariantUsage {
  calls: number;
  input: number;
  output: number;
  costUsd: number | null;
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
}

export interface BenchPlan extends BenchOptions {
  segments: PlannedSegment[];
  skipped: string[];
  truthErrors: string[];
  jobs: Job[];
}

interface ResultBase {
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

function describeMutation(original: DraftRecipe, m: Mutation): string {
  if (m.kind === "clean") return "unmodified draft";
  if (m.kind === "extra-step") {
    const step = m.draft.steps.at(-1)!;
    return `step ${step.order}: ${step.text}`;
  }
  if (m.kind === "extra-ingredient") {
    const ing = m.draft.ingredients.at(-1)!;
    return `${ing.rawName} ${ing.quantity} ${ing.unit}`;
  }
  const index = m.draft.ingredients.findIndex((i) => i.rawName === m.target!.ref);
  const before = original.ingredients[index];
  return `${before.rawName}: ${before.quantity} → ${m.draft.ingredients[index].quantity}${before.unit ? ` ${before.unit}` : ""}`;
}

/** Reads inputs and labels and lays out every call. Never touches an LLM. */
export async function planBench(opts: BenchOptions, deps: Pick<BenchDeps, "config" | "vocab">): Promise<BenchPlan> {
  const { segments: inputs, skipped } = await loadBenchInputs(deps.config.paths.cache);
  const truthErrors: string[] = [];
  const segments: PlannedSegment[] = [];
  const jobs: Job[] = [];
  const everyRun = (input: BenchSegment, extra: Omit<Job, "variant" | "repeat" | "input"> = {}) => {
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
      everyRun(input);
    }
  } else {
    for (const input of inputs) {
      const mutations = generateMutations(input.videoId, input.segmentIndex, input.segment, input.draft, deps.vocab);
      const described = mutations.map((m) => ({ kind: m.kind, target: m.target, detail: describeMutation(input.draft, m) }));
      segments.push({ videoId: input.videoId, segmentIndex: input.segmentIndex, workingName: input.segment.workingName, mutations: described });
      mutations.forEach((mutation, i) => everyRun(input, { mutation, detail: described[i].detail }));
    }
  }
  return { ...opts, segments, skipped, truthErrors, jobs };
}

export function planSummary(plan: BenchPlan): string {
  return `${plan.jobs.length} calls across ${plan.variants.length} variant${plan.variants.length === 1 ? "" : "s"} on ${plan.segments.length} segment${plan.segments.length === 1 ? "" : "s"}`;
}

export function renderPlan(plan: BenchPlan): string[] {
  const lines = [`bench ${plan.agent}: ${planSummary(plan)} (×${plan.repeat} repeat${plan.repeat === 1 ? "" : "s"}; parse retries can add calls)`];
  lines.push(`variants: ${plan.variants.map((v) => v.id).join(", ")}`);
  if (plan.agent === "verifier") {
    const counts = new Map<string, number>();
    for (const s of plan.segments) for (const m of s.mutations ?? []) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    lines.push(`drafts per variant and repeat: ${[...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }
  if (plan.truthErrors.length) lines.push(`ignored ground-truth rows (${plan.truthErrors.length}):`, ...plan.truthErrors.map((e) => `  ${e}`));
  if (plan.skipped.length) lines.push(`skipped (${plan.skipped.length}):`, ...plan.skipped.map((s) => `  ${s}`));
  return lines;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function executeBench(plan: BenchPlan, deps: BenchDeps, onProgress?: (done: number, total: number) => void): Promise<BenchResult> {
  const startedAt = new Date().toISOString();
  const promptsDir = deps.config.paths.prompts;
  const ledgers = new Map<string, UsageLedger>();
  const clients = new Map<string, LlmClient>();
  for (const v of plan.variants) {
    const ledger = new UsageLedger();
    const base = deps.makeLlm(ledger);
    ledgers.set(v.id, ledger);
    // The agents stay unaware of the bench: the variant's model and effort ride on every call.
    clients.set(v.id, {
      callStructured: (opts) => base.callStructured({ ...opts, model: v.model, ...(v.effort ? { effort: v.effort } : {}) }),
    });
  }

  const limit = pLimit(deps.config.concurrency);
  let done = 0;
  const timed = <T>(job: Job, work: (llm: LlmClient) => Promise<T>) =>
    limit(async () => {
      const t0 = Date.now();
      let outcome: { ok: true; value: T } | { ok: false; error: string };
      try {
        outcome = { ok: true, value: await work(clients.get(job.variant.id)!) };
      } catch (e) {
        // One variant's API rejection (say, effort on a model without it) is a result, not a crash.
        outcome = { ok: false, error: errorMessage(e) };
      }
      onProgress?.(++done, plan.jobs.length);
      return { outcome, ms: Date.now() - t0 };
    });

  const base = (job: Job) => ({ variant: job.variant.id, repeat: job.repeat, videoId: job.input.videoId, segmentIndex: job.input.segmentIndex });
  const usage = () =>
    Object.fromEntries(plan.variants.map((v) => {
      const t = ledgers.get(v.id)!.total();
      return [v.id, { calls: t.calls, input: t.input, output: t.output, costUsd: t.costUsd }];
    }));
  const common = () => ({ startedAt, finishedAt: new Date().toISOString(), repeat: plan.repeat, variants: plan.variants, segments: plan.segments, skipped: plan.skipped, truthErrors: plan.truthErrors, usage: usage() });

  if (plan.agent === "categorizer") {
    const cases = await Promise.all(
      plan.jobs.map(async (job): Promise<CategorizerCase> => {
        const { outcome, ms } = await timed<Categorization>(job, (llm) => runCategorizer(job.input.draft, deps.vocab, llm, promptsDir));
        return outcome.ok ? { ...base(job), ok: true, output: outcome.value, ms } : { ...base(job), ok: false, error: outcome.error, ms };
      }),
    );
    const labels = plan.segments.map((s) => s.label!);
    const scores = scoreCategorizer(cases, labels, plan.variants.map((v) => v.id), plan.repeat);
    return { agent: "categorizer", ...common(), cases, scores };
  }

  const cases = await Promise.all(
    plan.jobs.map(async (job): Promise<VerifierCase> => {
      const mutation = job.mutation!;
      const { outcome, ms } = await timed<{ verification: Verification; flags: RecipeFlag[] }>(job, async (llm) => {
        const verification = await runVerifier(job.input.segment, mutation.draft, llm, promptsDir);
        return { verification, flags: flagsFromVerification(mutation.draft, verification) };
      });
      const shared = { ...base(job), mutation: mutation.kind, target: mutation.target, ms };
      return outcome.ok ? { ...shared, ok: true, ...outcome.value } : { ...shared, ok: false, error: outcome.error };
    }),
  );
  return { agent: "verifier", ...common(), cases, scores: scoreVerifier(cases, plan.variants.map((v) => v.id)) };
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
