import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { VerificationWireSchema, type DraftRecipe, type RecipeFlag, type Verification } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";

export function buildVerifierUser(segment: ScoutSegment, draft: DraftRecipe): string {
  const ingredients = draft.ingredients
    .map((i) => `- ${i.rawName} [${i.provenance}] ${i.quantity ?? "?"} ${i.unit ?? ""}`.trim())
    .join("\n");
  const steps = draft.steps.map((s) => `${s.order}. ${s.text}`).join("\n");
  return ["Raw transcript:", segment.rawText, "", "Draft ingredients:", ingredients, "", "Draft steps:", steps].join("\n");
}

export async function runVerifier(segment: ScoutSegment, draft: DraftRecipe, llm: LlmClient, promptsDir: string): Promise<Verification> {
  const system = await loadPrompt("verifier", promptsDir);
  const raw = await llm.callStructured({ agent: "verifier", system, user: buildVerifierUser(segment, draft), schema: VerificationWireSchema });
  return { ...raw, confidence: Math.max(0, Math.min(1, raw.confidence)) };
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export function flagsFromVerification(draft: DraftRecipe, v: Verification): RecipeFlag[] {
  const flags: RecipeFlag[] = [];
  for (const ing of draft.ingredients) {
    // Presence is checked for every ingredient. An unknown-provenance one has no amount to
    // check, but an invented ingredient without an amount is still invented.
    const entry = v.ingredients.find((e) => normalizeName(e.rawName) === normalizeName(ing.rawName));
    if (entry?.supported) continue;
    const reason = ing.provenance === "unknown" ? "presence not found in transcript" : "quantity or presence not supported by transcript";
    flags.push({ kind: "ingredient", ref: ing.rawName, reason });
  }
  for (const step of draft.steps) {
    // A step the verifier said nothing about is unverified, which is not the same as
    // verified-good — flag it exactly like an ingredient it skipped.
    const entry = v.steps.find((e) => e.order === step.order);
    if (!entry || !entry.supported) flags.push({ kind: "step", ref: String(step.order), reason: "action not found in transcript" });
  }
  return flags;
}
