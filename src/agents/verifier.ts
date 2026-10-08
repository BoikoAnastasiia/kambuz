import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { VerificationWireSchema, type DraftRecipe, type RecipeFlag, type Verification } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { SourceContext } from "./extractor.js";

export function buildVerifierUser(segment: ScoutSegment, draft: DraftRecipe, source?: SourceContext): string {
  const ingredients = draft.ingredients
    .map((i) => `- ${i.rawName} [${i.provenance}] ${i.quantity ?? "?"} ${i.unit ?? ""}`.trim())
    .join("\n");
  const steps = draft.steps.map((s) => `${s.order}. ${s.text}`).join("\n");
  const description = source?.description.trim() ? ["", "Description (written by the author):", source.description.trim()] : [];
  return ["Raw transcript:", segment.rawText, ...description, "", "Draft ingredients:", ingredients, "", "Draft steps:", steps].join("\n");
}

export async function runVerifier(segment: ScoutSegment, draft: DraftRecipe, llm: LlmClient, promptsDir: string, source?: SourceContext): Promise<Verification> {
  const system = await loadPrompt("verifier", promptsDir);
  const raw = await llm.callStructured({ agent: "verifier", system, user: buildVerifierUser(segment, draft, source), schema: VerificationWireSchema });
  return { ...raw, confidence: Math.max(0, Math.min(1, raw.confidence)) };
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

/** A name without bracketed asides: "чипотле в адобо (jar of chipotle)" → "чипотле в адобо". */
function coreName(s: string): string {
  return normalizeName(s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " "));
}

/**
 * The verifier's entry for a draft ingredient. It is asked to echo the name, but it is shown
 * lines like "- говяжий фарш [stated] 500 g" and sometimes echoes "говяжий фарш 500 g", or
 * drops a bracketed aside. Tried in order: the exact name; the name without asides; an entry
 * that starts with that name and continues after a space (the amount it appended).
 */
export function findIngredientEntry<T extends { rawName: string }>(entries: T[], rawName: string): T | undefined {
  const name = normalizeName(rawName);
  const core = coreName(rawName);
  return (
    entries.find((e) => normalizeName(e.rawName) === name) ??
    entries.find((e) => coreName(e.rawName) === core) ??
    entries.find((e) => coreName(e.rawName).startsWith(`${core} `))
  );
}

export function flagsFromVerification(draft: DraftRecipe, v: Verification): RecipeFlag[] {
  const flags: RecipeFlag[] = [];
  // The verifier answers one entry per draft ingredient, in order; when the counts agree, an
  // entry whose name it reworded beyond recognition is still the one at the same position.
  const sameShape = v.ingredients.length === draft.ingredients.length;
  draft.ingredients.forEach((ing, i) => {
    // Presence is checked for every ingredient. An unknown-provenance one has no amount to
    // check, but an invented ingredient without an amount is still invented.
    const entry = findIngredientEntry(v.ingredients, ing.rawName) ?? (sameShape ? v.ingredients[i] : undefined);
    if (entry?.supported) return;
    const reason = ing.provenance === "unknown" ? "presence not found in transcript" : "quantity or presence not supported by transcript";
    flags.push({ kind: "ingredient", ref: ing.rawName, reason });
  });
  for (const step of draft.steps) {
    // A step the verifier said nothing about is unverified, which is not the same as
    // verified-good — flag it exactly like an ingredient it skipped.
    const entry = v.steps.find((e) => e.order === step.order);
    if (!entry || !entry.supported) flags.push({ kind: "step", ref: String(step.order), reason: "action not found in transcript" });
  }
  return flags;
}
