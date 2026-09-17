import type { DraftRecipe } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Vocab } from "../vocab/load.js";

export const PLANTED_KINDS = ["extra-ingredient", "changed-quantity", "extra-step"] as const;
export type PlantedKind = (typeof PLANTED_KINDS)[number];
export type MutationKind = PlantedKind | "clean";

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

/** Steps that could plausibly be in a recipe; each is used only when its key noun is absent from the transcript. */
export const EXTRA_STEPS: ReadonlyArray<{ text: string; keyNoun: string }> = [
  { text: "Добавить 200 мл сливок и довести до кипения.", keyNoun: "сливки" },
  { text: "Посыпать тёртым пармезаном и запекать 10 минут.", keyNoun: "пармезан" },
  { text: "Добавить щепотку корицы и перемешать.", keyNoun: "корица" },
  { text: "Полить лимонным соком и подать.", keyNoun: "лимон" },
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/** Russian inflects the ending (морковь → морковку), so a long word is matched on a trimmed stem. */
function stem(word: string): string {
  if (word.length >= 6) return word.slice(0, -2);
  if (word.length >= 4) return word.slice(0, -1);
  return word;
}

/**
 * Whether the transcript plausibly mentions `phrase`: the whole phrase as a case-insensitive
 * substring, or the stem of any of its words. Deliberately over-eager — a false "mentioned"
 * only rules a candidate out, while a false "absent" would plant an error that isn't one.
 */
export function mentions(text: string, phrase: string): boolean {
  const t = normalize(text);
  const p = normalize(phrase).trim();
  if (p && t.includes(p)) return true;
  return p.split(/[^a-zа-я0-9]+/).filter(Boolean).some((w) => t.includes(stem(w)));
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

/** One draw in [0, 1) from mulberry32, seeded per video, segment and mutation kind. */
function draw(seed: string): number {
  let t = (hash(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(items: T[], seed: string): T {
  return items[Math.floor(draw(seed) * items.length)];
}

function extraIngredient(seed: string, segment: ScoutSegment, draft: DraftRecipe, vocab: Vocab): Mutation | null {
  const usedIds = new Set(draft.ingredients.map((i) => i.ingredient));
  const usedNames = new Set(draft.ingredients.map((i) => normalize(i.rawName.trim())));
  const candidates = vocab.ingredients.filter(
    (v) =>
      !usedIds.has(v.id) &&
      !usedNames.has(normalize(v.nameRu)) &&
      ![v.nameRu, ...v.aliases].some((name) => mentions(segment.rawText, name)),
  );
  if (candidates.length === 0) return null;
  const v = pick(candidates, `${seed}:extra-ingredient`);
  const next = structuredClone(draft);
  next.ingredients.push({ ingredient: v.id, rawName: v.nameRu, quantity: 200, unit: "g", provenance: "stated", note: null });
  return { kind: "extra-ingredient", draft: next, target: { kind: "ingredient", ref: v.nameRu } };
}

function changedQuantity(seed: string, draft: DraftRecipe): Mutation | null {
  // flagsFromVerification matches by rawName, so a name that appears twice couldn't be attributed.
  const nameCount = new Map<string, number>();
  for (const i of draft.ingredients) nameCount.set(normalize(i.rawName.trim()), (nameCount.get(normalize(i.rawName.trim())) ?? 0) + 1);
  const eligible = draft.ingredients
    .map((ing, index) => ({ ing, index }))
    .filter(({ ing }) => ing.provenance !== "unknown" && ing.quantity !== null && nameCount.get(normalize(ing.rawName.trim())) === 1);
  if (eligible.length === 0) return null;
  const { ing, index } = pick(eligible, `${seed}:changed-quantity`);
  const next = structuredClone(draft);
  const q = ing.quantity as number;
  next.ingredients[index].quantity = q === 0 ? 3 : q * 3;
  return { kind: "changed-quantity", draft: next, target: { kind: "ingredient", ref: ing.rawName } };
}

function extraStep(segment: ScoutSegment, draft: DraftRecipe): Mutation | null {
  const chosen = EXTRA_STEPS.find((s) => !mentions(segment.rawText, s.keyNoun));
  if (!chosen) return null;
  const order = draft.steps.reduce((max, s) => Math.max(max, s.order), 0) + 1;
  const next = structuredClone(draft);
  next.steps.push({ order, text: chosen.text, timestamp: segment.end });
  return { kind: "extra-step", draft: next, target: { kind: "step", ref: String(order) } };
}

/**
 * The control plus each planted error that applies to this segment, in a fixed order.
 * Pure and seeded by videoId + segmentIndex, so every variant and every run sees the same drafts.
 */
export function generateMutations(videoId: string, segmentIndex: number, segment: ScoutSegment, draft: DraftRecipe, vocab: Vocab): Mutation[] {
  const seed = `${videoId}:${segmentIndex}`;
  const planted = [extraIngredient(seed, segment, draft, vocab), changedQuantity(seed, draft), extraStep(segment, draft)];
  return [{ kind: "clean", draft, target: null }, ...planted.filter((m): m is Mutation => m !== null)];
}
