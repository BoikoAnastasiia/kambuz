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

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export function flagsFromVerification(draft: DraftRecipe, v: Verification): RecipeFlag[] {
  const flags: RecipeFlag[] = [];
  for (const ing of draft.ingredients) {
    if (ing.provenance === "unknown") continue;
    const entry = v.ingredients.find((e) => normalizeName(e.rawName) === normalizeName(ing.rawName));
    if (!entry || !entry.supported) flags.push({ kind: "ingredient", ref: ing.rawName, reason: "quantity or presence not supported by transcript" });
  }
  for (const step of draft.steps) {
    const entry = v.steps.find((e) => e.order === step.order);
    if (entry && !entry.supported) flags.push({ kind: "step", ref: String(step.order), reason: "action not found in transcript" });
  }
  return flags;
}
