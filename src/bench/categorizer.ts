import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MealTypeSchema, type Categorization } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";
import { segmentKey } from "./inputs.js";
import { mean, rate } from "./stats.js";

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
export type CategorizerCase = CaseBase & ({ ok: true; output: Categorization } | { ok: false; error: string });

export interface CategorizerVariantScore {
  variant: string;
  cases: number;
  errors: number;
  cuisineAccuracy: number | null;
  categoryAccuracy: number | null;
  mealTypesExact: number | null;
  mealTypesJaccard: number | null;
  /** Share of segments (with ≥ 2 successful repeats) whose dishKey never changed; null for one repeat. */
  dishKeyStability: number | null;
  meanLatencyMs: number | null;
}

export interface DishKeyAgreement {
  a: string;
  b: string;
  segments: number;
  rate: number | null;
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

function okCases(cases: CategorizerCase[]): Array<CaseBase & { output: Categorization }> {
  return cases.flatMap((c) => (c.ok ? [c] : []));
}

/** Each variant's answer from its earliest successful repeat, per segment. */
function firstDishKeys(cases: CategorizerCase[]): Map<string, string> {
  const sorted = okCases(cases).sort((x, y) => x.repeat - y.repeat);
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
    const mine = cases.filter((c) => c.variant === variant);
    const answered = okCases(mine).filter((c) => truth.has(segmentKey(c)));
    const t = (c: CaseBase) => truth.get(segmentKey(c))!;

    let stability: number | null = null;
    if (repeat >= 2) {
      const keys = new Map<string, Set<string>>();
      const counts = new Map<string, number>();
      for (const c of answered) {
        keys.set(segmentKey(c), (keys.get(segmentKey(c)) ?? new Set()).add(c.output.dishKey));
        counts.set(segmentKey(c), (counts.get(segmentKey(c)) ?? 0) + 1);
      }
      const repeated = [...counts.entries()].filter(([, n]) => n >= 2).map(([k]) => k);
      stability = rate(repeated.filter((k) => keys.get(k)!.size === 1).length, repeated.length);
    }

    return {
      variant,
      cases: mine.length,
      errors: mine.filter((c) => !c.ok).length,
      cuisineAccuracy: rate(answered.filter((c) => c.output.cuisine === t(c).cuisine).length, answered.length),
      categoryAccuracy: rate(answered.filter((c) => c.output.category === t(c).category).length, answered.length),
      mealTypesExact: rate(answered.filter((c) => jaccard(c.output.mealTypes, t(c).mealTypes) === 1).length, answered.length),
      mealTypesJaccard: mean(answered.map((c) => jaccard(c.output.mealTypes, t(c).mealTypes))),
      dishKeyStability: stability,
      meanLatencyMs: mean(okCases(mine).map((c) => c.ms)),
    };
  });

  const firsts = new Map(variants.map((v) => [v, firstDishKeys(cases.filter((c) => c.variant === v))]));
  const agreement: DishKeyAgreement[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const A = firsts.get(variants[i])!;
      const B = firsts.get(variants[j])!;
      const shared = [...A.keys()].filter((k) => B.has(k));
      agreement.push({ a: variants[i], b: variants[j], segments: shared.length, rate: rate(shared.filter((k) => A.get(k) === B.get(k)).length, shared.length) });
    }
  }
  return { variants: scores, agreement };
}
