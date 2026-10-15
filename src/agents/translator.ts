import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { renderTranscript, sliceCues } from "../fetcher/vtt.js";
import { ProofreadSchema, TranslationWireSchema, type ProofreadIssue, type Recipe, type Translation, type TranslationWire } from "../schemas/recipe.js";
import type { VideoSource } from "../schemas/source.js";

const CYRILLIC = /[Ѐ-ӿ]/;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// A long recipe (50 steps) plus thinking at high effort runs well past the default 16k.
const MAX_TOKENS = 32000;

export interface TranslateContext {
  /** The dish's slice of the chef's own English speech or subtitles, when the video is in English. */
  originalTranscript?: string;
}

/**
 * The chef's English for this dish, when there is any: captions or subtitles in English. A video
 * whose only text is Russian subtitles (some silent English-channel videos) gets none, so a
 * translation is never "grounded" in a transcript that is itself a translation.
 */
export function englishSourceFor(recipe: Recipe, source: VideoSource | null): TranslateContext {
  if (!source || !/^en\b/i.test(source.language) || (source.captionKind !== "spoken" && source.captionKind !== "author")) return {};
  const transcript = renderTranscript(sliceCues(source.cues, recipe.source.segmentStart, recipe.source.segmentEnd)).trim();
  return transcript ? { originalTranscript: transcript } : {};
}

function translatorInput(recipe: Recipe): string {
  return JSON.stringify(
    {
      dish: recipe.nameRu,
      draftEnglishName: recipe.nameEn,
      steps: recipe.steps.map((s) => s.text),
      // The plain name, as the Russian page shows it; the amount is a separate column there.
      ingredients: recipe.ingredients.map((i) => ({ name: i.baseName || i.rawName, note: i.note })),
    },
    null,
    1,
  );
}

function sourceSection(ctx: TranslateContext): string[] {
  return ctx.originalTranscript ? ["", "The chef spoke English. Original transcript of this dish:", ctx.originalTranscript] : [];
}

export function buildTranslatorUser(recipe: Recipe, problems: string[] = [], ctx: TranslateContext = {}): string {
  const lines = [translatorInput(recipe), ...sourceSection(ctx)];
  if (problems.length) lines.push("", "An earlier translation of this recipe had these problems. Translate it again and avoid them:", ...problems.map((p) => `- ${p}`));
  return lines.join("\n");
}

/**
 * The checks code can make without a model: the counts line up, every number in a step survives
 * (as digits or a word), Celsius is marked, and no Russian is left behind.
 */
export function checkTranslation(recipe: Recipe, t: TranslationWire): string[] {
  const problems: string[] = [];
  if (!t.name.trim()) problems.push("the dish name is empty");
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

/** Which lines a set of findings points at. null when an item can't be read, so the caller retranslates everything. */
export interface Targets {
  name: boolean;
  steps: Set<number>;
  ingredients: Set<number>;
}

export function targetsOf(issues: ProofreadIssue[]): Targets | null {
  const targets: Targets = { name: false, steps: new Set(), ingredients: new Set() };
  for (const issue of issues) {
    let found = false;
    if (/\b(name|title)\b/i.test(issue.item)) {
      targets.name = true;
      found = true;
    }
    for (const m of issue.item.matchAll(/\b(step|ingredient)s?\b([\d\s,&/–-]|and)+/gi)) {
      const set = m[1].toLowerCase() === "step" ? targets.steps : targets.ingredients;
      for (const n of m[0].match(/\d+/g) ?? []) {
        set.add(Number(n));
        found = true;
      }
    }
    if (!found) return null;
  }
  return targets;
}

function describeTargets(t: Targets): string[] {
  return [...(t.name ? ["name"] : []), ...[...t.steps].map((n) => `step ${n}`), ...[...t.ingredients].map((n) => `ingredient ${n}`)];
}

export function buildProofreaderUser(recipe: Recipe, t: TranslationWire, ctx: TranslateContext = {}, only?: Targets): string {
  const line = (x: { name: string; note: string | null } | undefined) => (x ? `${x.name}${x.note ? ` (${x.note})` : ""}` : "(missing)");
  const items = [
    `name\nRU: ${recipe.nameRu}\nEN: ${t.name}`,
    ...recipe.ingredients.map((i, k) => `ingredient ${k + 1}\nRU: ${line({ name: i.baseName || i.rawName, note: i.note })}\nEN: ${line(t.ingredients[k])}`),
    ...recipe.steps.map((s, k) => `step ${k + 1}\nRU: ${s.text}\nEN: ${t.steps[k] ?? "(missing)"}`),
  ];
  const lines = [`Dish: ${recipe.nameRu}`, "", items.join("\n\n"), ...sourceSection(ctx)];
  if (only) lines.push("", `These lines were just corrected. Check only them, using the rest as context: ${describeTargets(only).join(", ")}.`);
  return lines.join("\n");
}

export function describeIssue(i: ProofreadIssue): string {
  return `${i.item} [${i.kind}]: «${i.russian}» → "${i.english}" — ${i.explanation}`;
}

export async function runTranslator(recipe: Recipe, llm: LlmClient, promptsDir: string, problems: string[] = [], ctx: TranslateContext = {}): Promise<TranslationWire> {
  const system = await loadPrompt("translator", promptsDir);
  return llm.callStructured({ agent: "translator", system, user: buildTranslatorUser(recipe, problems, ctx), schema: TranslationWireSchema, maxTokens: MAX_TOKENS });
}

export async function runProofreader(recipe: Recipe, t: TranslationWire, llm: LlmClient, promptsDir: string, ctx: TranslateContext = {}, only?: Targets): Promise<ProofreadIssue[]> {
  const system = await loadPrompt("proofreader", promptsDir);
  const out = await llm.callStructured({ agent: "proofreader", system, user: buildProofreaderUser(recipe, t, ctx, only), schema: ProofreadSchema, maxTokens: MAX_TOKENS });
  return out.issues;
}

const FixSchema = z.object({
  name: z.string().nullable(),
  steps: z.array(z.object({ step: z.number().int(), text: z.string() })),
  ingredients: z.array(z.object({ ingredient: z.number().int(), name: z.string(), note: z.string().nullable() })),
});

/**
 * Rewrites only the lines the proofreader flagged, with the whole recipe and translation as
 * context. On a 30-step recipe that is a few lines of output instead of the whole recipe again.
 */
export async function runFixer(recipe: Recipe, t: TranslationWire, issues: ProofreadIssue[], targets: Targets, llm: LlmClient, promptsDir: string, ctx: TranslateContext = {}): Promise<TranslationWire> {
  const system = await loadPrompt("translator", promptsDir);
  const user = [
    translatorInput(recipe),
    ...sourceSection(ctx),
    "",
    "Current English translation:",
    JSON.stringify(t, null, 1),
    "",
    "A proofreader found these problems:",
    ...issues.map((i) => `- ${describeIssue(i)}`),
    "",
    `Rewrite only these lines: ${describeTargets(targets).join(", ")}. Return the new English for each (step and ingredient numbers start at 1), and name only if it is listed (else null).`,
  ].join("\n");
  const fix = await llm.callStructured({ agent: "translator", system, user, schema: FixSchema, maxTokens: MAX_TOKENS });
  const steps = [...t.steps];
  for (const f of fix.steps) if (f.step >= 1 && f.step <= steps.length) steps[f.step - 1] = f.text;
  const ingredients = [...t.ingredients];
  for (const f of fix.ingredients) if (f.ingredient >= 1 && f.ingredient <= ingredients.length) ingredients[f.ingredient - 1] = { name: f.name, note: f.note };
  return { name: targets.name && fix.name ? fix.name : t.name, steps, ingredients };
}

export type TranslateOutcome = { ok: true; en: Translation } | { ok: false; problems: string[] };

/**
 * Translate, check, proofread. A translation failing the code checks is redone once in full.
 * What the proofreader finds is fixed once, line by line where it named the lines, and only
 * those lines are proofread again. A translation that still has problems is not stored, and
 * the problems are returned for a person to look at.
 */
export async function translateRecipe(
  recipe: Recipe,
  llm: LlmClient,
  promptsDir: string,
  models: { translator: string; proofreader: string },
  ctx: TranslateContext = {},
): Promise<TranslateOutcome> {
  let t = await runTranslator(recipe, llm, promptsDir, [], ctx);
  let problems = checkTranslation(recipe, t);
  if (problems.length) {
    t = await runTranslator(recipe, llm, promptsDir, problems, ctx);
    problems = checkTranslation(recipe, t);
    if (problems.length) return { ok: false, problems };
  }
  const findings = await runProofreader(recipe, t, llm, promptsDir, ctx);
  let rounds = 1;
  if (findings.length) {
    const targets = targetsOf(findings);
    t = targets ? await runFixer(recipe, t, findings, targets, llm, promptsDir, ctx) : await runTranslator(recipe, llm, promptsDir, findings.map(describeIssue), ctx);
    problems = checkTranslation(recipe, t);
    if (problems.length) return { ok: false, problems };
    const remaining = await runProofreader(recipe, t, llm, promptsDir, ctx, targets ?? undefined);
    rounds = 2;
    if (remaining.length) return { ok: false, problems: remaining.map(describeIssue) };
  }
  return {
    ok: true,
    en: {
      ...t,
      model: models.translator,
      proofreader: models.proofreader,
      translatedAt: new Date().toISOString(),
      review: { rounds, findings },
      fromEnglishSource: !!ctx.originalTranscript,
    },
  };
}
