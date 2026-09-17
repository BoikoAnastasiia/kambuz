import type { DraftIngredient, DraftRecipe } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";
import type { BenchSegment } from "./inputs.js";

export const PLANTED_KINDS = ["extra-ingredient", "quantity-x1.5", "unit-swap", "changed-step-number", "extra-step"] as const;
export type PlantedKind = (typeof PLANTED_KINDS)[number];
export type MutationKind = PlantedKind | "clean";

/** Kinds that alter an item already in the draft (as opposed to adding one): the clean run may have flagged it already. */
export const MODIFIES_EXISTING: ReadonlySet<MutationKind> = new Set<MutationKind>(["quantity-x1.5", "unit-swap", "changed-step-number"]);

/** The planted item, in the same terms as a RecipeFlag (ingredient rawName or step order). */
export interface FlagTarget {
  kind: "ingredient" | "step";
  ref: string;
}

export interface Mutation {
  kind: MutationKind;
  draft: DraftRecipe;
  target: FlagTarget | null;
}

export interface MutationContext {
  vocab: Vocab;
  /** Every cached segment; the one being mutated is ignored. Source of realistic extra ingredients. */
  segments: BenchSegment[];
}

/**
 * Steps that could plausibly belong to many dishes. `keys` are the words whose presence in the
 * transcript would make the step true, so the step is only planted when none of them occurs.
 */
export const EXTRA_STEPS: ReadonlyArray<{ text: string; keys: string[] }> = [
  { text: "Добавить 200 мл сливок и довести до кипения.", keys: ["сливки"] },
  { text: "Посыпать тёртым пармезаном и запекать 10 минут.", keys: ["пармезан"] },
  { text: "Добавить щепотку корицы и перемешать.", keys: ["корица"] },
  { text: "Полить лимонным соком перед подачей.", keys: ["лимон", "лимонный"] },
  { text: "Добавить ложку сметаны и перемешать.", keys: ["сметана"] },
  { text: "Посыпать мелко нарезанным укропом.", keys: ["укроп"] },
  { text: "Влить 100 мл белого вина и выпарить.", keys: ["вино"] },
  { text: "Положить лавровый лист и накрыть крышкой.", keys: ["лавровый"] },
  { text: "Добавить горсть шпината и прогреть 2 минуты.", keys: ["шпинат"] },
  { text: "Посыпать сладкой паприкой.", keys: ["паприка"] },
  { text: "Добавить ложку мёда и перемешать.", keys: ["мёд"] },
  { text: "Посыпать рублеными грецкими орехами.", keys: ["орех", "грецкий"] },
];

const UNIT_SWAPS: Record<string, string> = { g: "ml", ml: "g", kg: "l", l: "kg", tbsp: "tsp", tsp: "tbsp" };

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VOWELS = "аеиоуыэюяй";

/**
 * A word-start pattern for one Russian word that survives inflection: the ending vowels are
 * dropped (сливки → сливк) and a fleeting vowel before the last consonant is optional both ways
 * (сливк matches сливок, перец matches перца). Anchoring at a word start keeps сливки from
 * matching сливочное.
 */
function wordPattern(word: string): string {
  let stem = normalize(word).replace(/[аеиоуыэюяйь]+$/, "");
  if (stem.length < 3) stem = normalize(word);
  const n = stem.length;
  const last = stem[n - 1];
  const prev = stem[n - 2];
  const before = stem[n - 3];
  let body: string;
  if (!VOWELS.includes(last) && "ое".includes(prev) && before && !VOWELS.includes(before)) {
    body = `${escapeRegex(stem.slice(0, n - 2))}[ое]?${escapeRegex(last)}`;
  } else if (!VOWELS.includes(last) && prev && !VOWELS.includes(prev)) {
    body = `${escapeRegex(stem.slice(0, n - 1))}[ое]?${escapeRegex(last)}`;
  } else {
    body = escapeRegex(stem);
  }
  return `(?<![а-яa-z0-9])${body}`;
}

/** Whether any word (3+ letters) of `phrase` occurs in `text` in some inflected form, at a word start. */
export function mentions(text: string, phrase: string): boolean {
  const t = normalize(text);
  const words = normalize(phrase).split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 3);
  return words.some((w) => new RegExp(wordPattern(w)).test(t));
}

/**
 * Deliberately over-eager: any 4+ letter prefix of any word counts. Used for planted
 * ingredients, where a false "mentioned" only loses a candidate but a false "absent" would
 * plant an ingredient the chef actually used.
 */
export function plausiblyMentions(text: string, phrase: string): boolean {
  if (mentions(text, phrase)) return true;
  const t = normalize(text);
  return normalize(phrase)
    .split(/[^а-яa-z0-9]+/)
    .filter((w) => w.length >= 4)
    .some((w) => t.includes(w.slice(0, Math.max(4, w.length - 2))));
}

function hash(s: string): number {
  // FNV-1a, 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One draw in [0, 1) from mulberry32, seeded by a string. */
function draw(seed: string): number {
  let t = (hash(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(items: readonly T[], seed: string): T {
  return items[Math.floor(draw(seed) * items.length)];
}

const nameKey = (s: string) => normalize(s.trim());

/** ×1.5, rounded to a step a cook would write (5 from 20 up, 0.5 from 5 up, else 0.25); never the original. */
export function scaleQuantity(q: number): number {
  const x = q * 1.5;
  const step = x >= 20 ? 5 : x >= 5 ? 0.5 : 0.25;
  const rounded = Math.round(x / step) * step;
  return rounded !== q ? rounded : q + step;
}

/** A different number of the same scale that the transcript does not contain, so the change is unsupported. */
function otherNumber(n: number, transcript: string, seed: string): number | null {
  const raw = n >= 100 ? [n + 20, n + 40, n - 20] : n >= 10 ? [n * 2, n + 10, n - 5] : [n + 2, n * 3, n + 5];
  const candidates = raw.filter((c) => c > 0 && c !== n && !containsNumber(transcript, String(c)));
  return candidates.length ? pick(candidates, seed) : null;
}

function containsNumber(text: string, digits: string): boolean {
  return new RegExp(`(?<![\\d.,])${digits}(?![\\d]|[.,]\\d)`).test(text);
}

/** Ingredients whose rawName occurs once, so a flag on that name can be attributed. */
function uniquelyNamed(draft: DraftRecipe): Array<{ ing: DraftIngredient; index: number }> {
  const counts = new Map<string, number>();
  for (const i of draft.ingredients) counts.set(nameKey(i.rawName), (counts.get(nameKey(i.rawName)) ?? 0) + 1);
  return draft.ingredients.map((ing, index) => ({ ing, index })).filter(({ ing }) => counts.get(nameKey(ing.rawName)) === 1);
}

function numericClaim(ing: DraftIngredient): boolean {
  return ing.provenance !== "unknown" && ing.quantity !== null && ing.quantity > 0;
}

function extraIngredient(seed: string, input: BenchSegment, ctx: MutationContext): Mutation | null {
  const { draft, segment } = input;
  const usedIds = new Set(draft.ingredients.map((i) => i.ingredient).filter(Boolean));
  const usedNames = new Set(draft.ingredients.map((i) => nameKey(i.rawName)));
  const vocabById = new Map(ctx.vocab.ingredients.map((v) => [v.id, v]));
  const absent = (rawName: string, id: string | null) => {
    if (usedNames.has(nameKey(rawName)) || (id && usedIds.has(id))) return false;
    const entry = id ? vocabById.get(id) : undefined;
    return ![rawName, ...(entry ? [entry.nameRu, ...entry.aliases] : [])].some((name) => plausiblyMentions(segment.rawText, name));
  };

  const others = ctx.segments.filter((s) => !(s.videoId === input.videoId && s.segmentIndex === input.segmentIndex));
  // Donors keep their own amount when they had one. Preferring those was tried and left too few
  // candidates on the real cache (one odd rawName planted in 5 of 13 segments), so all mix.
  const fromDrafts = (pool: BenchSegment[]): DraftIngredient[] => {
    const seen = new Set<string>();
    const out: DraftIngredient[] = [];
    for (const s of pool) {
      for (const i of s.draft.ingredients) {
        // Unmapped rawNames include verbs and fragments ("подсолить"), which would not read as an ingredient.
        if (i.ingredient === null || seen.has(nameKey(i.rawName)) || !absent(i.rawName, i.ingredient)) continue;
        seen.add(nameKey(i.rawName));
        const hasAmount = i.quantity !== null && i.quantity > 0 && i.unit !== null;
        const base = { ingredient: i.ingredient, rawName: i.rawName, provenance: "stated" as const, note: null };
        out.push(hasAmount ? { ...base, quantity: i.quantity, unit: i.unit } : { ...base, quantity: 200, unit: "g" });
      }
    }
    return out;
  };
  const tiers: DraftIngredient[][] = [
    input.category ? fromDrafts(others.filter((s) => s.category === input.category)) : [],
    fromDrafts(others),
    ctx.vocab.ingredients
      .filter((v) => absent(v.nameRu, v.id))
      .map((v) => ({ ingredient: v.id, rawName: v.nameRu, quantity: 200, unit: "g", provenance: "stated" as const, note: null })),
  ];
  const tier = tiers.find((t) => t.length > 0);
  if (!tier) return null;
  const added = pick(tier, `${seed}:extra-ingredient`);
  const next = structuredClone(draft);
  next.ingredients.push(added);
  return { kind: "extra-ingredient", draft: next, target: { kind: "ingredient", ref: added.rawName } };
}

function scaledQuantity(seed: string, draft: DraftRecipe): Mutation | null {
  const eligible = uniquelyNamed(draft).filter(({ ing }) => numericClaim(ing));
  if (eligible.length === 0) return null;
  const { ing, index } = pick(eligible, `${seed}:quantity-x1.5`);
  const next = structuredClone(draft);
  next.ingredients[index].quantity = scaleQuantity(ing.quantity as number);
  return { kind: "quantity-x1.5", draft: next, target: { kind: "ingredient", ref: ing.rawName } };
}

function unitSwap(seed: string, draft: DraftRecipe): Mutation | null {
  const eligible = uniquelyNamed(draft).filter(({ ing }) => numericClaim(ing) && ing.unit !== null && ing.unit in UNIT_SWAPS);
  if (eligible.length === 0) return null;
  const { ing, index } = pick(eligible, `${seed}:unit-swap`);
  const next = structuredClone(draft);
  next.ingredients[index].unit = UNIT_SWAPS[ing.unit as string];
  return { kind: "unit-swap", draft: next, target: { kind: "ingredient", ref: ing.rawName } };
}

function changedStepNumber(seed: string, input: BenchSegment): Mutation | null {
  const { draft, segment } = input;
  // Only whole numbers the transcript also says, so the original step is supported and the change is not.
  const options: Array<{ stepIndex: number; start: number; digits: string }> = [];
  draft.steps.forEach((step, stepIndex) => {
    for (const m of step.text.matchAll(/(?<![\d.,])\d+(?![\d]|[.,]\d)/g)) {
      if (containsNumber(segment.rawText, m[0])) options.push({ stepIndex, start: m.index!, digits: m[0] });
    }
  });
  const usable = options
    .map((o) => ({ ...o, replacement: otherNumber(Number(o.digits), segment.rawText, `${seed}:changed-step-number:${o.stepIndex}:${o.start}`) }))
    .filter((o): o is typeof o & { replacement: number } => o.replacement !== null);
  if (usable.length === 0) return null;
  const chosen = pick(usable, `${seed}:changed-step-number`);
  const next = structuredClone(draft);
  const step = next.steps[chosen.stepIndex];
  step.text = step.text.slice(0, chosen.start) + String(chosen.replacement) + step.text.slice(chosen.start + chosen.digits.length);
  return { kind: "changed-step-number", draft: next, target: { kind: "step", ref: String(step.order) } };
}

function extraStep(seed: string, input: BenchSegment): Mutation | null {
  const { draft, segment } = input;
  const eligible = EXTRA_STEPS.filter((s) => !s.keys.some((k) => mentions(segment.rawText, k)));
  if (eligible.length === 0) return null;
  const chosen = pick(eligible, `${seed}:extra-step`);
  const order = draft.steps.reduce((max, s) => Math.max(max, s.order), 0) + 1;
  const next = structuredClone(draft);
  next.steps.push({ order, text: chosen.text, timestamp: segment.end });
  return { kind: "extra-step", draft: next, target: { kind: "step", ref: String(order) } };
}

/**
 * The control plus each planted error that applies to this segment, in PLANTED_KINDS order.
 * Pure and seeded by videoId + segmentIndex, so every variant and every run sees the same drafts.
 */
export function generateMutations(input: BenchSegment, ctx: MutationContext): Mutation[] {
  const seed = `${input.videoId}:${input.segmentIndex}`;
  const planted = [
    extraIngredient(seed, input, ctx),
    scaledQuantity(seed, input.draft),
    unitSwap(seed, input.draft),
    changedStepNumber(seed, input),
    extraStep(seed, input),
  ];
  return [{ kind: "clean", draft: input.draft, target: null }, ...planted.filter((m): m is Mutation => m !== null)];
}
