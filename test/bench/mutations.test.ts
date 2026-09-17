import { describe, it, expect } from "vitest";
import { generateMutations, mentions, plausiblyMentions, scaleQuantity, EXTRA_STEPS, PLANTED_KINDS, type MutationContext } from "../../src/bench/mutations.js";
import type { BenchSegment } from "../../src/bench/inputs.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import { lasagnaDraft, lasagnaSegment, soupDraft, soupSegment, vocab } from "./fixtures.js";

const lasagna: BenchSegment = { videoId: "v1", segmentIndex: 0, segment: lasagnaSegment, draft: lasagnaDraft, category: "pasta" };
const soup: BenchSegment = { videoId: "v1", segmentIndex: 1, segment: soupSegment, draft: soupDraft, category: "soup" };

function donor(videoId: string, category: string, rawName: string, quantity: number | null, unit: string | null): BenchSegment {
  const draft: DraftRecipe = { ...soupDraft, ingredients: [{ ingredient: `id-${rawName}`, rawName, quantity, unit, provenance: "stated", note: null }] };
  return { videoId, segmentIndex: 0, segment: soupSegment, draft, category };
}

const ctx: MutationContext = { vocab, segments: [lasagna, soup] };
const find = (ms: ReturnType<typeof generateMutations>, kind: string) => ms.find((m) => m.kind === kind);

describe("mentions", () => {
  it("matches inflected forms at a word start", () => {
    expect(mentions("Нарежем ЛУК", "лук")).toBe(true);
    expect(mentions("добавим свёклу", "Свекла")).toBe(true);
    expect(mentions("добавим морковку", "Морковь")).toBe(true);
    expect(mentions("200 мл сливок", "сливки")).toBe(true);
    expect(mentions("два перца", "перец")).toBe(true);
  });
  it("does not let a different word with the same prefix count", () => {
    expect(mentions("растопим сливочное масло", "сливки")).toBe(false);
    expect(mentions("добавим морковку", "Корица")).toBe(false);
    expect(mentions("размешаем", "мешок")).toBe(false);
  });
  it("plausiblyMentions stays over-eager for ingredients", () => {
    expect(plausiblyMentions("растопим сливочное масло", "сливки")).toBe(true);
  });
});

describe("scaleQuantity", () => {
  it("multiplies by 1.5 and rounds to a cook's step", () => {
    expect(scaleQuantity(500)).toBe(750);
    expect(scaleQuantity(250)).toBe(375);
    expect(scaleQuantity(4)).toBe(6);
    expect(scaleQuantity(3)).toBe(4.5);
    expect(scaleQuantity(1)).toBe(1.5);
    expect(scaleQuantity(0.5)).toBe(0.75);
    expect(scaleQuantity(1.5)).toBe(2.25);
  });
  it("never returns the original", () => {
    for (const q of [0.1, 0.25, 0.5, 1, 1.5, 2, 7, 13, 33, 100, 1000]) expect(scaleQuantity(q)).not.toBe(q);
  });
});

describe("generateMutations", () => {
  it("is deterministic and yields every applicable kind in order", () => {
    const a = generateMutations(lasagna, ctx);
    expect(generateMutations(lasagna, ctx)).toEqual(a);
    expect(a.map((m) => m.kind)).toEqual(["clean", ...PLANTED_KINDS]);
  });

  it("keeps clean identical, never mutates the input, and never produces a no-op", () => {
    const before = structuredClone(lasagnaDraft);
    for (let i = 0; i < 25; i++) {
      const ms = generateMutations({ ...lasagna, videoId: `video-${i}` }, ctx);
      expect(ms[0]).toEqual({ kind: "clean", draft: lasagnaDraft, target: null });
      for (const m of ms.slice(1)) expect(m.draft).not.toEqual(lasagnaDraft);
    }
    expect(lasagnaDraft).toEqual(before);
  });

  it("extra-ingredient prefers a same-category draft, then any other draft, then the vocabulary", () => {
    const pasta = donor("p", "pasta", "пармезан", 50, "g");
    const other = donor("o", "dessert", "шоколад", null, null);
    const same = find(generateMutations(lasagna, { vocab, segments: [lasagna, pasta, other] }), "extra-ingredient")!;
    expect(same.draft.ingredients.at(-1)).toEqual({ ingredient: "id-пармезан", rawName: "пармезан", quantity: 50, unit: "g", provenance: "stated", note: null });
    expect(same.target).toEqual({ kind: "ingredient", ref: "пармезан" });

    const fallback = find(generateMutations(lasagna, { vocab, segments: [lasagna, other] }), "extra-ingredient")!;
    expect(fallback.draft.ingredients.at(-1)).toMatchObject({ rawName: "шоколад", quantity: 200, unit: "g" });

    const fromVocab = find(generateMutations(lasagna, { vocab, segments: [lasagna] }), "extra-ingredient")!;
    const added = fromVocab.draft.ingredients.at(-1)!;
    expect(["Корица", "Лимон"]).toContain(added.rawName);
    expect(plausiblyMentions(lasagnaSegment.rawText, added.rawName)).toBe(false);
  });

  it("extra-ingredient ignores unmapped donor rawNames", () => {
    const unmapped = donor("p", "pasta", "подсолить", null, null);
    unmapped.draft.ingredients[0].ingredient = null;
    const m = find(generateMutations(lasagna, { vocab, segments: [lasagna, unmapped] }), "extra-ingredient")!;
    expect(m.draft.ingredients.at(-1)!.rawName).not.toBe("подсолить");
  });

  it("extra-ingredient skips donor ingredients the transcript mentions", () => {
    const m = find(generateMutations(lasagna, { vocab, segments: [lasagna, donor("p", "pasta", "морковка", 1, "pc")] }), "extra-ingredient")!;
    expect(m.draft.ingredients.at(-1)!.rawName).not.toBe("морковка");
  });

  it("quantity-x1.5 scales a stated/inferred numeric quantity", () => {
    const m = find(generateMutations(lasagna, ctx), "quantity-x1.5")!;
    const i = m.draft.ingredients.findIndex((x) => x.rawName === m.target!.ref);
    expect(m.draft.ingredients[i].quantity).toBe(scaleQuantity(lasagnaDraft.ingredients[i].quantity!));
  });

  it("unit-swap changes only the unit, and only for swappable units", () => {
    const m = find(generateMutations(lasagna, ctx), "unit-swap")!;
    expect(m.target).toEqual({ kind: "ingredient", ref: "фарш" });
    expect(m.draft.ingredients[1]).toEqual({ ...lasagnaDraft.ingredients[1], unit: "ml" });
    const pcOnly = { ...lasagna, draft: { ...lasagnaDraft, ingredients: [lasagnaDraft.ingredients[0]] } };
    expect(find(generateMutations(pcOnly, ctx), "unit-swap")).toBeUndefined();
  });

  it("changed-step-number replaces a number the transcript says with one it does not", () => {
    const m = find(generateMutations(lasagna, ctx), "changed-step-number")!;
    expect(m.target).toEqual({ kind: "step", ref: "2" });
    const text = m.draft.steps[1].text;
    const n = text.match(/\d+/)![0];
    expect(n).not.toBe("500");
    expect(lasagnaSegment.rawText).not.toContain(n);
    expect(text.replace(n, "500")).toBe(lasagnaDraft.steps[1].text);
  });

  it("skips kinds with nothing to change", () => {
    const kinds = generateMutations(soup, ctx).map((m) => m.kind);
    expect(kinds).not.toContain("quantity-x1.5");
    expect(kinds).not.toContain("unit-swap");
    expect(kinds).not.toContain("changed-step-number");
  });

  it("extra-step picks among every eligible sentence by seed, at the segment end", () => {
    const texts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const m = find(generateMutations({ ...lasagna, videoId: `video-${i}` }, ctx), "extra-step")!;
      const added = m.draft.steps.at(-1)!;
      expect(added).toMatchObject({ order: 3, timestamp: 300 });
      expect(m.target).toEqual({ kind: "step", ref: "3" });
      const entry = EXTRA_STEPS.find((s) => s.text === added.text)!;
      expect(entry.keys.some((k) => mentions(lasagnaSegment.rawText, k))).toBe(false);
      texts.add(added.text);
    }
    // the transcript says сливками, so the cream step is never planted
    expect([...texts]).not.toContain(EXTRA_STEPS[0].text);
    expect(texts.size).toBeGreaterThan(3);
  });

  it("allows the cream step when the transcript only mentions сливочное масло", () => {
    const seg = { ...soup, segment: { ...soupSegment, rawText: "растопим сливочное масло" } };
    const texts = new Set<string>();
    for (let i = 0; i < 60; i++) texts.add(find(generateMutations({ ...seg, videoId: `x${i}` }, ctx), "extra-step")!.draft.steps.at(-1)!.text);
    expect(texts).toContain(EXTRA_STEPS[0].text);
  });
});
