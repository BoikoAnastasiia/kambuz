import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MealTypeSchema, type Categorization } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";
import { segmentKey } from "./inputs.js";
import { mean, proportion, type Proportion } from "./stats.js";

type MealType = z.infer<typeof MealTypeSchema>;

export interface CategorizerLabel {
  videoId: string;
  segmentIndex: number;
  dish: string;
  cuisine: string;
  category: string;
  mealTypes: MealType[];
}

const RowShape = z.object({
  videoId: z.string().min(1),
  segmentIndex: z.number().int().min(0),
  dish: z.string(),
  cuisine: z.string(),
  category: z.string(),
  mealTypes: z.array(z.string()).min(1),
});

/** Keeps every well-formed row whose ids exist in the vocabulary; each other row becomes one error line. */
export function validateCategorizerTruth(raw: unknown, vocab: Vocab): { labels: CategorizerLabel[]; errors: string[] } {
  if (!Array.isArray(raw)) return { labels: [], errors: ["ground truth must be a JSON array of rows"] };
  const labels: CategorizerLabel[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `row ${i + 1}`;
    const shape = RowShape.safeParse(item);
    if (!shape.success) {
      errors.push(`${where}: expected { videoId, segmentIndex, dish, cuisine, category, mealTypes[] } (${shape.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ")})`);
      return;
    }
    const row = shape.data;
    const label = `${where} (${segmentKey(row)})`;
    const problems: string[] = [];
    if (!vocab.cuisines.some((c) => c.id === row.cuisine)) problems.push(`unknown cuisine "${row.cuisine}"`);
    if (!vocab.categories.some((c) => c.id === row.category)) problems.push(`unknown category "${row.category}"`);
    for (const m of row.mealTypes) if (!MealTypeSchema.safeParse(m).success) problems.push(`unknown mealType "${m}"`);
    if (seen.has(segmentKey(row))) problems.push("duplicate of an earlier row for this segment");
    if (problems.length) {
      errors.push(`${label}: ${problems.join("; ")}`);
      return;
    }
    seen.add(segmentKey(row));
    labels.push({ ...row, mealTypes: row.mealTypes as MealType[] });
  });
  return { labels, errors };
}

export async function loadCategorizerTruth(file: string, vocab: Vocab): Promise<{ labels: CategorizerLabel[]; errors: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    return { labels: [], errors: [`cannot read ${file}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`] };
  }
  return validateCategorizerTruth(raw, vocab);
}

interface CaseBase {
  variant: string;
  repeat: number;
  videoId: string;
  segmentIndex: number;
  /** Wall time of the agent call, parse retries included. */
  ms: number;
}
export type CategorizerCase = CaseBase & ({ ok: true; output: Categorization; rawCuisine: string } | { ok: false; error: string });

export interface CategorizerVariantScore {
  variant: string;
  cases: number;
  errors: number;
  /** Over every case: a failed call is a miss, never left out. Cuisine is the model's raw answer. */
  cuisine: Proportion;
  category: Proportion;
  mealTypesExact: Proportion;
  /** Mean over every case, a failed call counting 0. */
  mealTypesJaccard: number | null;
  /** Segments (with ≥ 2 cases) whose every repeat succeeded with the same dishKey; null for one repeat. */
  dishKeyStability: Proportion | null;
  meanLatencyMs: number | null;
}

export interface DishKeyAgreement {
  a: string;
  b: string;
  agreement: Proportion;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / union.size;
}

type OkCase = Extract<CategorizerCase, { ok: true }>;

/** Each variant's answer from its earliest successful repeat, per segment. */
function firstDishKeys(cases: CategorizerCase[]): Map<string, string> {
  const sorted = cases.filter((c): c is OkCase => c.ok).sort((x, y) => x.repeat - y.repeat);
  const first = new Map<string, string>();
  for (const c of sorted) if (!first.has(segmentKey(c))) first.set(segmentKey(c), c.output.dishKey);
  return first;
}

export function scoreCategorizer(
  cases: CategorizerCase[],
  labels: CategorizerLabel[],
  variants: string[],
  repeat: number,
): { variants: CategorizerVariantScore[]; agreement: DishKeyAgreement[] } {
  const truth = new Map(labels.map((l) => [segmentKey(l), l]));
  const scores = variants.map((variant): CategorizerVariantScore => {
    const mine = cases.filter((c) => c.variant === variant && truth.has(segmentKey(c)));
    const t = (c: CaseBase) => truth.get(segmentKey(c))!;
    const hits = (test: (c: OkCase) => boolean) => mine.filter((c) => c.ok && test(c)).length;

    let stability: Proportion | null = null;
    if (repeat >= 2) {
      const bySegment = new Map<string, CategorizerCase[]>();
      for (const c of mine) bySegment.set(segmentKey(c), [...(bySegment.get(segmentKey(c)) ?? []), c]);
      const repeated = [...bySegment.values()].filter((cs) => cs.length >= 2);
      const stable = repeated.filter((cs) => cs.every((c) => c.ok) && new Set(cs.map((c) => (c as OkCase).output.dishKey)).size === 1);
      stability = proportion(stable.length, repeated.length);
    }

    return {
      variant,
      cases: mine.length,
      errors: mine.filter((c) => !c.ok).length,
      cuisine: proportion(hits((c) => c.rawCuisine === t(c).cuisine), mine.length),
      category: proportion(hits((c) => c.output.category === t(c).category), mine.length),
      mealTypesExact: proportion(hits((c) => jaccard(c.output.mealTypes, t(c).mealTypes) === 1), mine.length),
      mealTypesJaccard: mean(mine.map((c) => (c.ok ? jaccard(c.output.mealTypes, t(c).mealTypes) : 0))),
      dishKeyStability: stability,
      meanLatencyMs: mean(mine.filter((c) => c.ok).map((c) => c.ms)),
    };
  });

  const firsts = new Map(variants.map((v) => [v, firstDishKeys(cases.filter((c) => c.variant === v))]));
  const agreement: DishKeyAgreement[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const A = firsts.get(variants[i])!;
      const B = firsts.get(variants[j])!;
      const shared = [...A.keys()].filter((k) => B.has(k));
      agreement.push({ a: variants[i], b: variants[j], agreement: proportion(shared.filter((k) => A.get(k) === B.get(k)).length, shared.length) });
    }
  }
  return { variants: scores, agreement };
}
