import { describe, it, expect } from "vitest";
import { scoreVerifier, targetStatus, type VerifierCase } from "../../src/bench/verifier.js";
import type { DraftRecipe, Verification } from "../../src/schemas/recipe.js";
import type { MutationKind, FlagTarget } from "../../src/bench/mutations.js";

const D: DraftRecipe = {
  nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
  ingredients: [
    { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
    { ingredient: "beef-mince", rawName: "фарш", quantity: 500, unit: "g", provenance: "stated", note: null },
    { ingredient: null, rawName: "соль", quantity: null, unit: null, provenance: "unknown", note: null },
  ],
  steps: [{ order: 1, text: "Нарезать лук.", timestamp: 1 }, { order: 2, text: "Обжарить 500 г фарша.", timestamp: 2 }],
};
const withCinnamon: DraftRecipe = { ...D, ingredients: [...D.ingredients, { ingredient: "cinnamon", rawName: "Корица", quantity: 200, unit: "g", provenance: "stated", note: null }] };
const withStep3: DraftRecipe = { ...D, steps: [...D.steps, { order: 3, text: "Посыпать укропом.", timestamp: 3 }] };

/** Everything supported unless named: false = rejected, null = entry omitted. */
function v(draft: DraftRecipe, overrides: Record<string, boolean | null> = {}): Verification {
  const ingredients = draft.ingredients
    .filter((i) => overrides[i.rawName] !== null)
    .map((i) => ({ rawName: i.rawName, quote: null, supported: overrides[i.rawName] ?? true }));
  const steps = draft.steps
    .filter((s) => overrides[`#${s.order}`] !== null)
    .map((s) => ({ order: s.order, quote: null, supported: overrides[`#${s.order}`] ?? true }));
  return { ingredients, steps, confidence: 1 };
}

function ok(variant: string, repeat: number, mutation: MutationKind, target: FlagTarget | null, draft: DraftRecipe, verification: Verification, ms = 50): VerifierCase {
  return { variant, repeat, videoId: "v1", segmentIndex: 0, mutation, target, draft, ok: true, verification, ms };
}
function failed(variant: string, repeat: number, mutation: MutationKind, target: FlagTarget | null, draft: DraftRecipe): VerifierCase {
  return { variant, repeat, videoId: "v1", segmentIndex: 0, mutation, target, draft, ok: false, error: "boom", ms: 1 };
}

describe("targetStatus", () => {
  it("tells an explicit rejection from an omitted entry, matching names like flagsFromVerification", () => {
    const t = { kind: "ingredient" as const, ref: "Корица" };
    expect(targetStatus(t, { ...v(withCinnamon, { Корица: null }), ingredients: [{ rawName: " корица ", quote: null, supported: false }] })).toBe("rejected");
    expect(targetStatus(t, v(withCinnamon, { Корица: null }))).toBe("missing");
    expect(targetStatus(t, v(withCinnamon))).toBe("supported");
    expect(targetStatus({ kind: "step", ref: "2" }, v(D, { "#2": false }))).toBe("rejected");
  });
});

describe("scoreVerifier", () => {
  const scaled: DraftRecipe = { ...D, ingredients: [D.ingredients[0], { ...D.ingredients[1], quantity: 750 }, D.ingredients[2]] };
  const renumbered: DraftRecipe = { ...D, steps: [D.steps[0], { ...D.steps[1], text: "Обжарить 520 г фарша." }] };
  const cases: VerifierCase[] = [
    // a, repeat 0: clean flags step 2
    ok("a", 0, "clean", null, D, v(D, { "#2": false })),
    ok("a", 0, "extra-ingredient", { kind: "ingredient", ref: "Корица" }, withCinnamon, v(withCinnamon, { Корица: false, "#2": false })),
    // omitted target: flagged by flagsFromVerification, but not detected; лук is new noise on this repeat
    ok("a", 0, "quantity-x1.5", { kind: "ingredient", ref: "фарш" }, scaled, v(scaled, { фарш: null, лук: false, "#2": false })),
    // step 2 was already flagged on this repeat's clean draft: excluded
    ok("a", 0, "changed-step-number", { kind: "step", ref: "2" }, renumbered, v(renumbered, { "#2": false })),
    ok("a", 0, "extra-step", { kind: "step", ref: "3" }, withStep3, v(withStep3, { "#2": false }), 150),
    // a, repeat 1: clean flags лук (so лук is not noise on repeat 1, but still was on repeat 0)
    ok("a", 1, "clean", null, D, v(D, { лук: false })),
    ok("a", 1, "extra-ingredient", { kind: "ingredient", ref: "Корица" }, withCinnamon, v(withCinnamon, { Корица: false, лук: false })),
    // b: errors are misses; no clean baseline means no noise
    failed("b", 0, "clean", null, D),
    ok("b", 0, "extra-ingredient", { kind: "ingredient", ref: "Корица" }, withCinnamon, v(withCinnamon, { Корица: null })),
    failed("b", 0, "extra-step", { kind: "step", ref: "3" }, withStep3),
    // c flags everything on the clean draft
    ok("c", 0, "clean", null, D, v(D, { лук: false, фарш: false, соль: false, "#1": false, "#2": false })),
  ];
  const scored = scoreVerifier(cases, ["a", "b", "c"]);
  const by = (id: string) => scored.find((s) => s.variant === id)!;

  it("counts only explicit rejections as detection, with missing and excluded shown apart", () => {
    const a = by("a");
    expect(a.detection["extra-ingredient"]).toMatchObject({ rejected: 2, missing: 0, detection: { hits: 2, total: 2 } });
    expect(a.detection["quantity-x1.5"]).toMatchObject({ rejected: 0, missing: 1, detection: { hits: 0, total: 1 } });
    expect(a.detection["changed-step-number"]).toMatchObject({ excluded: 1, detection: { hits: 0, total: 0, rate: null } });
    expect(a.detection["extra-step"]).toMatchObject({ supported: 1, detection: { hits: 0, total: 1 } });
    expect(a.detection["unit-swap"].detection.total).toBe(0);
    expect(a.overall).toMatchObject({ rejected: 2, missing: 1, supported: 1, excluded: 1, errors: 0, detection: { hits: 2, total: 4, rate: 0.5 } });
  });

  it("reports false positives on clean drafts and noise against the same repeat's clean run", () => {
    const a = by("a");
    expect(a.falsePositives.ingredients).toMatchObject({ hits: 1, total: 4 });
    expect(a.falsePositives.steps).toMatchObject({ hits: 1, total: 4 });
    expect(a.cleanFlagsMean).toBe(1);
    // noise: r0 extra-ingredient 0, quantity 1 (лук), step-number 0, extra-step 0; r1 extra-ingredient 0
    expect(a.noiseMean).toBeCloseTo(1 / 5);
    expect(a).toMatchObject({ cases: 7, errors: 0, meanLatencyMs: (50 * 6 + 150) / 7 });
  });

  it("counts failed calls as misses", () => {
    const b = by("b");
    expect(b.errors).toBe(2);
    expect(b.detection["extra-step"]).toMatchObject({ errors: 1, detection: { hits: 0, total: 1 } });
    expect(b.overall).toMatchObject({ missing: 1, errors: 1, detection: { hits: 0, total: 2 } });
    expect(b.noiseMean).toBeNull();
    expect(b.falsePositives.ingredients.rate).toBeNull();
  });

  it("makes a flag-everything variant's false-positive rate visible", () => {
    const c = by("c");
    expect(c.falsePositives.ingredients).toMatchObject({ hits: 2, total: 2, rate: 1 });
    expect(c.falsePositives.steps).toMatchObject({ hits: 2, total: 2, rate: 1 });
  });
});
