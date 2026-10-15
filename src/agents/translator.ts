import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { ProofreadSchema, TranslationWireSchema, type ProofreadIssue, type Recipe, type Translation, type TranslationWire } from "../schemas/recipe.js";

const CYRILLIC = /[Ѐ-ӿ]/;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// A long recipe (50 steps) plus thinking at high effort runs well past the default 16k.
const MAX_TOKENS = 32000;

export function buildTranslatorUser(recipe: Recipe, problems: string[] = []): string {
  const body = JSON.stringify(
    {
      dish: `${recipe.nameRu} (${recipe.nameEn})`,
      steps: recipe.steps.map((s) => s.text),
      ingredients: recipe.ingredients.map((i) => ({ name: i.rawName, note: i.note })),
    },
    null,
    1,
  );
  if (!problems.length) return body;
  return [body, "", "An earlier translation of this recipe had these problems. Translate it again and avoid them:", ...problems.map((p) => `- ${p}`)].join("\n");
}

/**
 * The checks code can make without a model: the counts line up, every number in a step survives
 * (as digits or a word), Celsius is marked, and no Russian is left behind.
 */
export function checkTranslation(recipe: Recipe, t: TranslationWire): string[] {
  const problems: string[] = [];
  if (t.steps.length !== recipe.steps.length) problems.push(`${t.steps.length} English steps for ${recipe.steps.length} Russian ones: keep one step per step`);
  if (t.ingredients.length !== recipe.ingredients.length) {
    problems.push(`${t.ingredients.length} English ingredients for ${recipe.ingredients.length} Russian ones: keep one entry per ingredient`);
  }
  if (CYRILLIC.test(JSON.stringify(t))) problems.push("Russian (Cyrillic) text was left in the English");
  recipe.steps.forEach((s, k) => {
    const en = t.steps[k] ?? "";
    for (const n of s.text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
      const d = n.replace(",", ".");
      const word = NUMBER_WORDS[Number(d)];
      if (!en.includes(d) && !(word && new RegExp(`\\b${word}\\b`, "i").test(en))) problems.push(`step ${k + 1}: the number ${n} is missing`);
    }
    if (/градус/i.test(s.text) && !/°C/.test(en)) problems.push(`step ${k + 1}: write the temperature as °C`);
  });
  return problems;
}

export function buildProofreaderUser(recipe: Recipe, t: TranslationWire): string {
  const line = (x: { name: string; note: string | null } | undefined) => (x ? `${x.name}${x.note ? ` (${x.note})` : ""}` : "(missing)");
  const items = [
    ...recipe.ingredients.map((i, k) => `ingredient ${k + 1}\nRU: ${line({ name: i.rawName, note: i.note })}\nEN: ${line(t.ingredients[k])}`),
    ...recipe.steps.map((s, k) => `step ${k + 1}\nRU: ${s.text}\nEN: ${t.steps[k] ?? "(missing)"}`),
  ];
  return [`Dish: ${recipe.nameRu}`, "", items.join("\n\n")].join("\n");
}

export function describeIssue(i: ProofreadIssue): string {
  return `${i.item} [${i.kind}]: «${i.russian}» → "${i.english}" — ${i.explanation}`;
}

export async function runTranslator(recipe: Recipe, llm: LlmClient, promptsDir: string, problems: string[] = []): Promise<TranslationWire> {
  const system = await loadPrompt("translator", promptsDir);
  return llm.callStructured({ agent: "translator", system, user: buildTranslatorUser(recipe, problems), schema: TranslationWireSchema, maxTokens: MAX_TOKENS });
}

export async function runProofreader(recipe: Recipe, t: TranslationWire, llm: LlmClient, promptsDir: string): Promise<ProofreadIssue[]> {
  const system = await loadPrompt("proofreader", promptsDir);
  const out = await llm.callStructured({ agent: "proofreader", system, user: buildProofreaderUser(recipe, t), schema: ProofreadSchema, maxTokens: MAX_TOKENS });
  return out.issues;
}

export type TranslateOutcome = { ok: true; en: Translation } | { ok: false; problems: string[] };

/**
 * Translate, check, proofread. Whatever the checks or the proofreader find is handed back to the
 * translator once; a translation that still has problems after that is not stored, and the
 * problems are returned for a person to look at.
 */
export async function translateRecipe(recipe: Recipe, llm: LlmClient, promptsDir: string, models: { translator: string; proofreader: string }): Promise<TranslateOutcome> {
  let t = await runTranslator(recipe, llm, promptsDir);
  let problems = checkTranslation(recipe, t);
  let retried = false;
  if (problems.length) {
    t = await runTranslator(recipe, llm, promptsDir, problems);
    retried = true;
    problems = checkTranslation(recipe, t);
    if (problems.length) return { ok: false, problems };
  }
  let issues = await runProofreader(recipe, t, llm, promptsDir);
  if (issues.length && !retried) {
    t = await runTranslator(recipe, llm, promptsDir, issues.map(describeIssue));
    problems = checkTranslation(recipe, t);
    if (problems.length) return { ok: false, problems };
    issues = await runProofreader(recipe, t, llm, promptsDir);
  }
  if (issues.length) return { ok: false, problems: issues.map(describeIssue) };
  return { ok: true, en: { ...t, model: models.translator, proofreader: models.proofreader, translatedAt: new Date().toISOString() } };
}
