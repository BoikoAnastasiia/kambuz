import { flagsFromVerification, normalizeName } from "../agents/verifier.js";
import type { DraftRecipe, RecipeFlag, Verification } from "../schemas/recipe.js";
import { segmentKey } from "./inputs.js";
import type { CaseUsage } from "./usage.js";
import { MODIFIES_EXISTING, PLANTED_KINDS, type FlagTarget, type MutationKind, type PlantedKind } from "./mutations.js";
import { mean, proportion, type Proportion } from "./stats.js";

interface CaseBase {
  variant: string;
  repeat: number;
  videoId: string;
  segmentIndex: number;
  mutation: MutationKind;
  target: FlagTarget | null;
  /** The exact draft the verifier saw, so a report can be re-scored without regenerating it. */
  draft: DraftRecipe;
  ms: number;
  /** Tokens and cost of this case's API attempts (absent in hand-built test cases). */
  usage?: CaseUsage;
}
/** `flags` is stored for people reading the JSON; scoring always re-derives it from draft + verification. */
export type VerifierCase = CaseBase & ({ ok: true; verification: Verification; flags?: RecipeFlag[] } | { ok: false; error: string });

/**
 * rejected: the verifier returned an entry for the planted item with supported:false.
 * missing: it returned no entry for it (flagsFromVerification still flags that, but it is
 * not evidence the model noticed anything). supported: it vouched for the planted item.
 */
export type TargetStatus = "rejected" | "missing" | "supported";

export function targetStatus(target: FlagTarget, v: Verification): TargetStatus {
  const entry =
    target.kind === "ingredient"
      ? v.ingredients.find((e) => normalizeName(e.rawName) === normalizeName(target.ref))
      : v.steps.find((e) => String(e.order) === target.ref);
  if (!entry) return "missing";
  return entry.supported ? "supported" : "rejected";
}

export interface KindScore {
  rejected: number;
  missing: number;
  supported: number;
  /** Failed calls: in the denominator, as misses. */
  errors: number;
  /** Modified items this variant already flagged on the same repeat's clean draft: out of the denominator. */
  excluded: number;
  /** rejected / (rejected + missing + supported + errors). */
  detection: Proportion;
}

export interface VerifierVariantScore {
  variant: string;
  cases: number;
  errors: number;
  detection: Record<PlantedKind, KindScore>;
  overall: KindScore;
  /** On clean drafts: share of ingredients, and of steps, that got flagged. */
  falsePositives: { ingredients: Proportion; steps: Proportion };
  /** Mean number of flags on the unmodified draft. */
  cleanFlagsMean: number | null;
  /** Mean flags per mutated draft on untouched items that were not flagged on the same repeat's clean draft. */
  noiseMean: number | null;
  meanLatencyMs: number | null;
}

const flagKey = (f: { kind: string; ref: string }) => `${f.kind}:${f.ref}`;

function kindScore(statuses: Array<TargetStatus | "error" | "excluded">): KindScore {
  const count = (s: string) => statuses.filter((x) => x === s).length;
  const rejected = count("rejected");
  const missing = count("missing");
  const supported = count("supported");
  const errors = count("error");
  return { rejected, missing, supported, errors, excluded: count("excluded"), detection: proportion(rejected, rejected + missing + supported + errors) };
}

export function scoreVerifier(cases: VerifierCase[], variants: string[]): VerifierVariantScore[] {
  return variants.map((variant) => {
    const mine = cases.filter((c) => c.variant === variant);
    const flagsOf = new Map<VerifierCase, RecipeFlag[]>();
    for (const c of mine) if (c.ok) flagsOf.set(c, flagsFromVerification(c.draft, c.verification));

    const cleanByRun = new Map<string, Set<string>>();
    for (const c of mine) {
      if (c.mutation === "clean" && c.ok) cleanByRun.set(`${segmentKey(c)}@${c.repeat}`, new Set(flagsOf.get(c)!.map(flagKey)));
    }
    const cleanFlags = (c: VerifierCase) => cleanByRun.get(`${segmentKey(c)}@${c.repeat}`);

    const status = (c: VerifierCase): TargetStatus | "error" | "excluded" => {
      if (!c.ok) return "error";
      if (MODIFIES_EXISTING.has(c.mutation) && cleanFlags(c)?.has(flagKey(c.target!))) return "excluded";
      return targetStatus(c.target!, c.verification);
    };
    const planted = mine.filter((c) => c.mutation !== "clean" && c.target);
    const detection = Object.fromEntries(
      PLANTED_KINDS.map((kind) => [kind, kindScore(planted.filter((c) => c.mutation === kind).map(status))]),
    ) as Record<PlantedKind, KindScore>;

    const cleanOk = mine.filter((c): c is Extract<VerifierCase, { ok: true }> => c.ok && c.mutation === "clean");
    let ingFlagged = 0, ingTotal = 0, stepFlagged = 0, stepTotal = 0;
    for (const c of cleanOk) {
      const flags = flagsOf.get(c)!;
      ingFlagged += flags.filter((f) => f.kind === "ingredient").length;
      ingTotal += c.draft.ingredients.length;
      stepFlagged += flags.filter((f) => f.kind === "step").length;
      stepTotal += c.draft.steps.length;
    }

    const noise = planted
      .filter((c) => c.ok && cleanFlags(c))
      .map((c) => flagsOf.get(c)!.filter((f) => flagKey(f) !== flagKey(c.target!) && !cleanFlags(c)!.has(flagKey(f))).length);

    return {
      variant,
      cases: mine.length,
      errors: mine.filter((c) => !c.ok).length,
      detection,
      overall: kindScore(planted.map(status)),
      falsePositives: { ingredients: proportion(ingFlagged, ingTotal), steps: proportion(stepFlagged, stepTotal) },
      cleanFlagsMean: mean(cleanOk.map((c) => flagsOf.get(c)!.length)),
      noiseMean: mean(noise),
      meanLatencyMs: mean(mine.filter((c) => c.ok).map((c) => c.ms)),
    };
  });
}
