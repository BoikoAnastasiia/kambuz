import { describe, it, expect } from "vitest";
import { generateMutations, mentions, EXTRA_STEPS } from "../../src/bench/mutations.js";
import { lasagnaDraft, lasagnaSegment, soupDraft, soupSegment, vocab } from "./fixtures.js";

describe("mentions", () => {
  it("matches case-insensitively, treats ё as е, and catches inflected forms", () => {
    expect(mentions("Нарежем ЛУК", "лук")).toBe(true);
    expect(mentions("добавим свёклу", "Свекла")).toBe(true);
    expect(mentions("добавим морковку", "Морковь")).toBe(true);
    expect(mentions("добавим морковку", "Корица")).toBe(false);
  });
});

describe("generateMutations", () => {
  it("is deterministic for the same video and segment", () => {
    const a = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab);
    const b = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab);
    expect(a).toEqual(b);
    expect(a.map((m) => m.kind)).toEqual(["clean", "extra-ingredient", "changed-quantity", "extra-step"]);
  });

  it("never mutates the input draft and keeps clean identical to it", () => {
    const before = structuredClone(lasagnaDraft);
    const [clean] = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab);
    expect(lasagnaDraft).toEqual(before);
    expect(clean).toEqual({ kind: "clean", draft: lasagnaDraft, target: null });
  });

  it("adds only an ingredient the transcript never mentions, stated at 200 g", () => {
    const m = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab).find((x) => x.kind === "extra-ingredient")!;
    const added = m.draft.ingredients.at(-1)!;
    // лук (alias репчатый лук), фарш (alias), морковь (морковку) and сливки (сливками) are all in the text
    expect(["Корица", "Лимон"]).toContain(added.rawName);
    expect(added).toMatchObject({ quantity: 200, unit: "g", provenance: "stated" });
    expect(m.target).toEqual({ kind: "ingredient", ref: added.rawName });
    expect(m.draft.ingredients.slice(0, -1)).toEqual(lasagnaDraft.ingredients);
  });

  it("the choice of added ingredient depends on the seed but always passes the absence check", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const m = generateMutations(`video-${i}`, i, lasagnaSegment, lasagnaDraft, vocab).find((x) => x.kind === "extra-ingredient")!;
      const name = m.draft.ingredients.at(-1)!.rawName;
      expect(mentions(lasagnaSegment.rawText, name)).toBe(false);
      picks.add(name);
    }
    expect(picks.size).toBe(2);
  });

  it("triples a stated/inferred numeric quantity", () => {
    const m = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab).find((x) => x.kind === "changed-quantity")!;
    const i = m.draft.ingredients.findIndex((x) => x.rawName === m.target!.ref);
    const original = lasagnaDraft.ingredients[i];
    expect(["лук", "фарш"]).toContain(original.rawName);
    expect(m.draft.ingredients[i].quantity).toBe(original.quantity! * 3);
    expect(m.target!.kind).toBe("ingredient");
  });

  it("adds 3 to a zero quantity", () => {
    const draft = { ...lasagnaDraft, ingredients: [{ ...lasagnaDraft.ingredients[1], quantity: 0 }] };
    const m = generateMutations("v1", 0, lasagnaSegment, draft, vocab).find((x) => x.kind === "changed-quantity")!;
    expect(m.draft.ingredients[0].quantity).toBe(3);
  });

  it("skips changed-quantity when no stated/inferred ingredient has a number", () => {
    expect(generateMutations("v1", 1, soupSegment, soupDraft, vocab).map((m) => m.kind)).not.toContain("changed-quantity");
  });

  it("appends the first extra step whose key noun is absent, timestamped at the segment end", () => {
    const m = generateMutations("v1", 0, lasagnaSegment, lasagnaDraft, vocab).find((x) => x.kind === "extra-step")!;
    // the transcript says сливками, so the cream sentence is passed over
    const expected = EXTRA_STEPS.find((s) => !mentions(lasagnaSegment.rawText, s.keyNoun))!;
    expect(expected.keyNoun).not.toBe(EXTRA_STEPS[0].keyNoun);
    expect(m.draft.steps).toEqual([...lasagnaDraft.steps, { order: 3, text: expected.text, timestamp: 300 }]);
    expect(m.target).toEqual({ kind: "step", ref: "3" });
  });
});
