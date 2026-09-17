import type { RecipeFlag, Verification } from "../schemas/recipe.js";
import { segmentKey } from "./inputs.js";
import { PLANTED_KINDS, type FlagTarget, type MutationKind, type PlantedKind } from "./mutations.js";
import { mean, rate } from "./stats.js";

interface CaseBase {
  variant: string;
  repeat: number;
  videoId: string;
  segmentIndex: number;
  mutation: MutationKind;
  target: FlagTarget | null;
  ms: number;
}
export type VerifierCase = CaseBase & ({ ok: true; flags: RecipeFlag[]; verification?: Verification } | { ok: false; error: string });

export interface Detection {
  detected: number;
  total: number;
  rate: number | null;
}

export interface VerifierVariantScore {
  variant: string;
  cases: number;
  errors: number;
  detection: Record<PlantedKind, Detection>;
  overallDetection: number | null;
  /** Mean number of flags on the unmodified draft. */
  cleanFlagsMean: number | null;
  /** Mean flags per mutated draft on untouched items that this variant never raised on the clean draft of that segment. */
  noiseMean: number | null;
  meanLatencyMs: number | null;
}

const flagKey = (f: { kind: string; ref: string }) => `${f.kind}:${f.ref}`;

export function isDetected(target: FlagTarget, flags: RecipeFlag[]): boolean {
  return flags.some((f) => flagKey(f) === flagKey(target));
}

export function scoreVerifier(cases: VerifierCase[], variants: string[]): VerifierVariantScore[] {
  return variants.map((variant) => {
    const mine = cases.filter((c) => c.variant === variant);
    const ok = mine.flatMap((c) => (c.ok ? [c] : []));
    const clean = ok.filter((c) => c.mutation === "clean");
    const mutated = ok.filter((c) => c.mutation !== "clean" && c.target);

    // Union over repeats: an item flagged on any clean run of the segment is that variant's baseline, not noise.
    const cleanFlags = new Map<string, Set<string>>();
    for (const c of clean) {
      const set = cleanFlags.get(segmentKey(c)) ?? new Set<string>();
      for (const f of c.flags) set.add(flagKey(f));
      cleanFlags.set(segmentKey(c), set);
    }

    const detection = Object.fromEntries(
      PLANTED_KINDS.map((kind) => {
        const of = mutated.filter((c) => c.mutation === kind);
        const detected = of.filter((c) => isDetected(c.target!, c.flags)).length;
        return [kind, { detected, total: of.length, rate: rate(detected, of.length) }];
      }),
    ) as Record<PlantedKind, Detection>;

    const noise = mutated
      .filter((c) => cleanFlags.has(segmentKey(c)))
      .map((c) => {
        const baseline = cleanFlags.get(segmentKey(c))!;
        return c.flags.filter((f) => flagKey(f) !== flagKey(c.target!) && !baseline.has(flagKey(f))).length;
      });

    return {
      variant,
      cases: mine.length,
      errors: mine.length - ok.length,
      detection,
      overallDetection: rate(mutated.filter((c) => isDetected(c.target!, c.flags)).length, mutated.length),
      cleanFlagsMean: mean(clean.map((c) => c.flags.length)),
      noiseMean: mean(noise),
      meanLatencyMs: mean(ok.map((c) => c.ms)),
    };
  });
}
