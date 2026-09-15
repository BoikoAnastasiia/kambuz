# Kambuz Ingestion Pipeline Implementation Plan

**Goal:** A CLI that takes a YouTube video or playlist URL and writes one grounded, structured recipe JSON per dish found, via a chain of typed agents.

**Architecture:** Plain-TypeScript orchestrator runs six stages per video (fetcher → scout → extractor per segment → verifier → categorizer → judge). Each agent is a pure function `(typedInput) => Promise<typedOutput>` built on one shared LLM wrapper using structured outputs. Every stage's result is cached on disk per video so runs resume.

**Tech Stack:** Node 22, TypeScript, `tsx`, `@anthropic-ai/sdk` (structured outputs via `client.messages.parse` + `zodOutputFormat`), Zod, Vitest, `yt-dlp` subprocess.

**Spec:** `docs/specs/2026-09-15-kambuz-ingestion-pipeline-design.md`

## Global Constraints

- Default model for every agent: `claude-sonnet-5`. Model per agent is overridable via config; never hardcode a model string inside an agent.
- Every LLM call goes through `src/llm/client.ts` and logs `usage`.
- Agents are pure: no filesystem, no network except the LLM call. The orchestrator does all I/O.
- No quantity is ever filled from general cooking knowledge; provenance is one of `stated | inferred | unknown`.
- Vocabulary files in `vocab/` are edited by humans only. Code validates against them, never writes them.
- Recipe name rule (spec §5): base dish + single defining variation; no adjectives, no chef/channel name, no "судовой".
- `dish_key` is a lowercase English slug: `[a-z0-9]+(-[a-z0-9]+)*`.
- Git commits must not carry any AI attribution trailer.
- ESM project: never use `__dirname`; derive paths from `import.meta.url`.
- Structured-output schemas use `.nullable()` for optional values, never `.optional()`.

---

## File structure

```
kambuz/
  package.json, tsconfig.json, vitest.config.ts, .env.example
  src/
    cli.ts                      argument parsing, dispatches to ingest / eval
    config.ts                   models per agent, concurrency, paths
    schemas/
      source.ts                 VideoSource, TranscriptCue
      scout.ts                  ScoutResult, ScoutSegment
      recipe.ts                 DraftRecipe, Verification, Categorization, Recipe
      judge.ts                  JudgeDecision
    fetcher/
      vtt.ts                    VTT text → TranscriptCue[]; slice by range; render
      ytdlp.ts                  subprocess wrapper: expandPlaylist, fetchVideo
    vocab/
      load.ts                   read vocab/*.json with Zod
      validate.ts               validateRecipe(recipe, vocab) → string[] errors
    llm/
      client.ts                 callStructured<T>(agent, system, user, schema)
      usage.ts                  UsageLedger: add(), total(), toString()
    prompts/
      load.ts                   loadPrompt(name) reads src/prompts/<name>.md
      scout.md, extractor.md, verifier.md, categorizer.md, judge.md
    agents/
      scout.ts                  runScout(source) → ScoutResult
      extractor.ts              runExtractor(segment, vocab) → DraftRecipe
      verifier.ts               runVerifier(segment, draft) → Verification
      categorizer.ts            runCategorizer(draft) → Categorization
      judge.ts                  findCandidates, completeness, runJudge
    orchestrator/
      cache.ts                  StageCache: get/set per video+stage
      assemble.ts               build final Recipe from stage outputs
      catalog.ts                write recipe file, index, archive
      report.ts                 RunReport → markdown
      run.ts                    ingest(url, opts): the pipeline
    eval/
      run.ts                    runs eval set, prints diff table
  vocab/cuisines.json, categories.json, ingredients.json
  eval/cases/<videoId>.json
  catalog/recipes/, catalog/archive/, catalog/index.json
  test/                         mirrors src/, plus test/fixtures/
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `config` object with `models: Record<AgentName, string>`, `concurrency: number`, `paths: { cache, catalog, reports, vocab, prompts }`, `AgentName = "scout"|"extractor"|"verifier"|"categorizer"|"judge"`.

- [ ] **Step 1: Init package and install deps**

```bash
cd /Users/admin/Documents/job_searching/kambuz
npm init -y >/dev/null
npm pkg set type=module name=kambuz version=0.1.0 private=true
npm pkg set scripts.test="vitest run" scripts.test:watch="vitest" scripts.typecheck="tsc --noEmit" scripts.kambuz="tsx src/cli.ts"
npm install @anthropic-ai/sdk zod p-limit
npm install -D typescript tsx vitest @types/node
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write vitest.config.ts and .env.example**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

```
# .env.example
ANTHROPIC_API_KEY=
```

- [ ] **Step 4: Write the failing config test**

```ts
// test/config.test.ts
import { describe, it, expect } from "vitest";
import { config, AGENT_NAMES } from "../src/config.js";

describe("config", () => {
  it("has a model for every agent, defaulting to claude-sonnet-5", () => {
    for (const name of AGENT_NAMES) {
      expect(config.models[name]).toBe("claude-sonnet-5");
    }
  });
  it("lets KAMBUZ_MODEL_SCOUT override one agent", () => {
    process.env.KAMBUZ_MODEL_SCOUT = "claude-opus-5";
    const { buildConfig } = require("../src/config.js");
    expect(buildConfig().models.scout).toBe("claude-sonnet-5");
    delete process.env.KAMBUZ_MODEL_SCOUT;
  });
});
```

Replace the `require` in the second test with a dynamic import: `const { buildConfig } = await import("../src/config.js");` and make the test `async`.

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot find module `../src/config.js`

- [ ] **Step 6: Write src/config.ts**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_NAMES = ["scout", "extractor", "verifier", "categorizer", "judge"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

export interface Config {
  models: Record<AgentName, string>;
  concurrency: number;
  paths: { cache: string; catalog: string; reports: string; vocab: string; prompts: string; eval: string };
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const models = Object.fromEntries(
    AGENT_NAMES.map((n) => [n, env[`KAMBUZ_MODEL_${n.toUpperCase()}`] ?? env.KAMBUZ_MODEL ?? "claude-sonnet-5"]),
  ) as Record<AgentName, string>;
  return {
    models,
    concurrency: Number(env.KAMBUZ_CONCURRENCY ?? 4),
    paths: {
      cache: path.join(ROOT, ".cache"),
      catalog: path.join(ROOT, "catalog"),
      reports: path.join(ROOT, "reports"),
      vocab: path.join(ROOT, "vocab"),
      prompts: path.join(ROOT, "src", "prompts"),
      eval: path.join(ROOT, "eval"),
    },
  };
}

export const config = buildConfig();
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 2 passed, no type errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/config.ts test/config.test.ts
git commit -m "Scaffold TypeScript project with per-agent model config"
```

---

### Task 2: Zod schemas for every stage

**Files:**
- Create: `src/schemas/source.ts`, `src/schemas/scout.ts`, `src/schemas/recipe.ts`, `src/schemas/judge.ts`
- Test: `test/schemas/recipe.test.ts`

**Interfaces:**
- Produces (all exported as both Zod schema and inferred type):
  - `TranscriptCue { start:number; end:number; text:string }`
  - `VideoSource { videoId, url, title, tags:string[], channel, channelId, durationSec:number, uploadDate:string|null, language:"ru", cues:TranscriptCue[] }`
  - `ScoutSegment { workingName, start, end, rawText, cleanText }`, `ScoutResult { isRecipeVideo:boolean; segments:ScoutSegment[] }`
  - `Provenance = "stated"|"inferred"|"unknown"`
  - `DraftIngredient { ingredient:string|null; rawName; quantity:number|null; unit:string|null; provenance; note:string|null }`
  - `DraftStep { order:number; text:string; timestamp:number }`
  - `DraftRecipe { nameRu, nameEn, servings:number|null, ingredients:DraftIngredient[], steps:DraftStep[], unmappedIngredients:string[] }`
  - `Verification { ingredients:{rawName, quote:string|null, supported:boolean}[]; steps:{order, quote:string|null, supported:boolean}[]; confidence:number }`
  - `Categorization { cuisine, mealTypes:("breakfast"|"lunch"|"dinner")[], category, activeMinutes:number|null, totalMinutes:number|null, richness:"light"|"medium"|"hearty", dishKey }`
  - `RecipeFlag { kind:"ingredient"|"step"; ref:string; reason:string }`
  - `Recipe` (spec §6, camelCase field names as above plus `id, dishKey, flags, completeness, source{...}, extractedAt, models`)
  - `JudgeDecision { relation:"same"|"variant"; reason:string; newNameRu:string|null; existingNameRu:string|null }`

- [ ] **Step 1: Write the failing test**

```ts
// test/schemas/recipe.test.ts
import { describe, it, expect } from "vitest";
import { DraftRecipeSchema, CategorizationSchema } from "../../src/schemas/recipe.js";

describe("DraftRecipeSchema", () => {
  it("accepts a minimal valid draft", () => {
    const r = DraftRecipeSchema.parse({
      nameRu: "Лазанья с соусом болоньезе",
      nameEn: "Lasagna with bolognese",
      servings: null,
      ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
      steps: [{ order: 1, text: "Нарезать лук кубиком.", timestamp: 61 }],
      unmappedIngredients: [],
    });
    expect(r.ingredients[0].provenance).toBe("inferred");
  });
  it("rejects an unknown provenance", () => {
    expect(() =>
      DraftRecipeSchema.parse({
        nameRu: "x", nameEn: "x", servings: null, unmappedIngredients: [], steps: [],
        ingredients: [{ ingredient: null, rawName: "лук", quantity: null, unit: null, provenance: "guessed", note: null }],
      }),
    ).toThrow();
  });
});

describe("CategorizationSchema", () => {
  it("rejects a dishKey with spaces or uppercase", () => {
    const base = { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };
    expect(() => CategorizationSchema.parse({ ...base, dishKey: "Lasagna Bolognese" })).toThrow();
    expect(CategorizationSchema.parse({ ...base, dishKey: "lasagna-bolognese" }).dishKey).toBe("lasagna-bolognese");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/schemas`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the schemas**

```ts
// src/schemas/source.ts
import { z } from "zod";

export const TranscriptCueSchema = z.object({ start: z.number(), end: z.number(), text: z.string() });
export type TranscriptCue = z.infer<typeof TranscriptCueSchema>;

export const VideoSourceSchema = z.object({
  videoId: z.string(),
  url: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  channel: z.string(),
  channelId: z.string(),
  durationSec: z.number(),
  uploadDate: z.string().nullable(),
  language: z.literal("ru"),
  cues: z.array(TranscriptCueSchema),
});
export type VideoSource = z.infer<typeof VideoSourceSchema>;
```

```ts
// src/schemas/scout.ts
import { z } from "zod";

export const ScoutSegmentSchema = z.object({
  workingName: z.string().describe("The dish as the chef refers to it"),
  start: z.number().describe("Seconds into the video where cooking this dish starts"),
  end: z.number().describe("Seconds where it ends"),
  rawText: z.string().describe("Exact transcript slice for the range, copied verbatim"),
  cleanText: z.string().describe("Same slice with speech-to-text errors fixed; no content added or removed"),
});
export type ScoutSegment = z.infer<typeof ScoutSegmentSchema>;

export const ScoutResultSchema = z.object({
  isRecipeVideo: z.boolean(),
  segments: z.array(ScoutSegmentSchema),
});
export type ScoutResult = z.infer<typeof ScoutResultSchema>;
```

```ts
// src/schemas/recipe.ts
import { z } from "zod";

export const ProvenanceSchema = z.enum(["stated", "inferred", "unknown"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DraftIngredientSchema = z.object({
  ingredient: z.string().nullable().describe("Canonical id from the vocabulary, or null if it cannot be mapped"),
  rawName: z.string().describe("What the chef called it"),
  quantity: z.number().nullable(),
  unit: z.string().nullable().describe("g, ml, pc, tbsp, tsp, clove, or null"),
  provenance: ProvenanceSchema,
  note: z.string().nullable(),
});
export type DraftIngredient = z.infer<typeof DraftIngredientSchema>;

export const DraftStepSchema = z.object({
  order: z.number().int(),
  text: z.string(),
  timestamp: z.number().describe("Seconds into the video when the chef starts this step"),
});
export type DraftStep = z.infer<typeof DraftStepSchema>;

export const DraftRecipeSchema = z.object({
  nameRu: z.string(),
  nameEn: z.string(),
  servings: z.number().nullable(),
  ingredients: z.array(DraftIngredientSchema),
  steps: z.array(DraftStepSchema),
  unmappedIngredients: z.array(z.string()),
});
export type DraftRecipe = z.infer<typeof DraftRecipeSchema>;

export const VerificationSchema = z.object({
  ingredients: z.array(z.object({ rawName: z.string(), quote: z.string().nullable(), supported: z.boolean() })),
  steps: z.array(z.object({ order: z.number().int(), quote: z.string().nullable(), supported: z.boolean() })),
  confidence: z.number().min(0).max(1),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner"]);
export const RichnessSchema = z.enum(["light", "medium", "hearty"]);
export const DishKeySchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const CategorizationSchema = z.object({
  cuisine: z.string(),
  mealTypes: z.array(MealTypeSchema).min(1),
  category: z.string(),
  activeMinutes: z.number().nullable(),
  totalMinutes: z.number().nullable(),
  richness: RichnessSchema,
  dishKey: DishKeySchema,
});
export type Categorization = z.infer<typeof CategorizationSchema>;

export const RecipeFlagSchema = z.object({ kind: z.enum(["ingredient", "step"]), ref: z.string(), reason: z.string() });
export type RecipeFlag = z.infer<typeof RecipeFlagSchema>;

export const RecipeSchema = z.object({
  id: z.string(),
  nameRu: z.string(),
  nameEn: z.string(),
  dishKey: DishKeySchema,
  cuisine: z.string(),
  mealTypes: z.array(MealTypeSchema),
  category: z.string(),
  richness: RichnessSchema,
  servings: z.number().nullable(),
  activeMinutes: z.number().nullable(),
  totalMinutes: z.number().nullable(),
  ingredients: z.array(DraftIngredientSchema),
  steps: z.array(DraftStepSchema),
  flags: z.array(RecipeFlagSchema),
  completeness: z.number(),
  source: z.object({
    videoId: z.string(), url: z.string(), videoTitle: z.string(),
    channel: z.string(), channelId: z.string(),
    segmentStart: z.number(), segmentEnd: z.number(), language: z.literal("ru"),
  }),
  extractedAt: z.string(),
  models: z.record(z.string(), z.string()),
});
export type Recipe = z.infer<typeof RecipeSchema>;
```

```ts
// src/schemas/judge.ts
import { z } from "zod";

export const JudgeDecisionSchema = z.object({
  relation: z.enum(["same", "variant"]),
  reason: z.string(),
  newNameRu: z.string().nullable().describe("Only for variant: distinguishing name for the new recipe"),
  existingNameRu: z.string().nullable().describe("Only for variant: distinguishing name for the existing recipe"),
});
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/schemas && npx tsc --noEmit`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/schemas test/schemas
git commit -m "Add Zod schemas for every pipeline stage"
```

---

### Task 3: Vocabulary files, loader, validator

**Files:**
- Create: `vocab/cuisines.json`, `vocab/categories.json`, `vocab/ingredients.json`, `src/vocab/load.ts`, `src/vocab/validate.ts`
- Test: `test/vocab/validate.test.ts`

**Interfaces:**
- Produces: `Vocab { cuisines: VocabEntry[]; categories: VocabEntry[]; ingredients: IngredientEntry[] }`, `VocabEntry { id, nameRu, nameEn }`, `IngredientEntry extends VocabEntry { aliases: string[] }`, `loadVocab(dir: string): Promise<Vocab>`, `validateRecipe(recipe: Pick<Recipe,"cuisine"|"category"|"ingredients">, vocab: Vocab): string[]`, `ingredientPromptList(vocab): string` (one line per ingredient: `id — nameRu / nameEn (aliases…)`).

- [ ] **Step 1: Write the vocab JSON files**

`vocab/cuisines.json`:
```json
[
  { "id": "ukrainian", "nameRu": "Украинская", "nameEn": "Ukrainian" },
  { "id": "russian", "nameRu": "Русская", "nameEn": "Russian" },
  { "id": "georgian", "nameRu": "Грузинская", "nameEn": "Georgian" },
  { "id": "italian", "nameRu": "Итальянская", "nameEn": "Italian" },
  { "id": "french", "nameRu": "Французская", "nameEn": "French" },
  { "id": "spanish", "nameRu": "Испанская", "nameEn": "Spanish" },
  { "id": "turkish", "nameRu": "Турецкая", "nameEn": "Turkish" },
  { "id": "asian", "nameRu": "Азиатская", "nameEn": "Asian" },
  { "id": "other", "nameRu": "Другая", "nameEn": "Other" }
]
```

`vocab/categories.json`:
```json
[
  { "id": "soup", "nameRu": "Суп", "nameEn": "Soup" },
  { "id": "salad", "nameRu": "Салат", "nameEn": "Salad" },
  { "id": "pasta", "nameRu": "Паста", "nameEn": "Pasta" },
  { "id": "dumplings", "nameRu": "Пельмени и вареники", "nameEn": "Dumplings" },
  { "id": "bake", "nameRu": "Запеканка / выпечка", "nameEn": "Bake" },
  { "id": "stew", "nameRu": "Тушёное", "nameEn": "Stew" },
  { "id": "grill", "nameRu": "Гриль / жареное", "nameEn": "Grill" },
  { "id": "breakfast-dish", "nameRu": "Завтрак", "nameEn": "Breakfast dish" },
  { "id": "dessert", "nameRu": "Десерт", "nameEn": "Dessert" },
  { "id": "bread", "nameRu": "Хлеб", "nameEn": "Bread" },
  { "id": "sauce", "nameRu": "Соус", "nameEn": "Sauce" },
  { "id": "side", "nameRu": "Гарнир", "nameEn": "Side" }
]
```

`vocab/ingredients.json` — start with this seed and grow from run reports. Each entry: `{ "id", "nameRu", "nameEn", "aliases": [] }`. Seed at least these 60 (write all with proper Russian names): onion, garlic, carrot, celery-stalk, tomato, canned-tomato, tomato-paste, potato, bell-pepper, cucumber, cabbage, beet, mushroom, eggplant, zucchini, spinach, dill, parsley, cilantro, green-onion, lemon, apple, beef, beef-mince, veal, pork, pork-mince, lamb, chicken, chicken-breast, chicken-thigh, bacon, jamon, sausage, fish-white, salmon, shrimp, egg, milk, cream, sour-cream, butter, cheese-hard, parmesan, mozzarella, cottage-cheese, flour, sugar, salt, black-pepper, nutmeg, bay-leaf, paprika, olive-oil, sunflower-oil, vinegar, rice, buckwheat, pasta-sheets, spaghetti, bread, breadcrumbs, beans, lentils, chickpeas, water, stock-beef, stock-chicken, wine-red, wine-white. Add aliases where obvious, e.g. `"cilantro": ["кинза", "кориандр", "coriander"]`, `"celery-stalk": ["стебель сельдерея", "сельдерей", "стебля сидений"]`, `"jamon": ["хамон"]`.

- [ ] **Step 2: Write the failing test**

```ts
// test/vocab/validate.test.ts
import { describe, it, expect } from "vitest";
import { validateRecipe, ingredientPromptList } from "../../src/vocab/validate.js";
import type { Vocab } from "../../src/vocab/load.js";

const vocab: Vocab = {
  cuisines: [{ id: "italian", nameRu: "Итальянская", nameEn: "Italian" }],
  categories: [{ id: "pasta", nameRu: "Паста", nameEn: "Pasta" }],
  ingredients: [{ id: "onion", nameRu: "Лук", nameEn: "Onion", aliases: ["лук репчатый"] }],
};
const ing = (ingredient: string | null) => ({ ingredient, rawName: "x", quantity: null, unit: null, provenance: "unknown" as const, note: null });

describe("validateRecipe", () => {
  it("returns no errors for known ids", () => {
    expect(validateRecipe({ cuisine: "italian", category: "pasta", ingredients: [ing("onion"), ing(null)] }, vocab)).toEqual([]);
  });
  it("reports unknown cuisine, category and ingredient ids", () => {
    const errors = validateRecipe({ cuisine: "martian", category: "soup", ingredients: [ing("unicorn")] }, vocab);
    expect(errors).toEqual([
      "unknown cuisine: martian",
      "unknown category: soup",
      "unknown ingredient: unicorn",
    ]);
  });
});

describe("ingredientPromptList", () => {
  it("renders one line per ingredient with aliases", () => {
    expect(ingredientPromptList(vocab)).toBe("onion — Лук / Onion (лук репчатый)");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/vocab`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write loader and validator**

```ts
// src/vocab/load.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const EntrySchema = z.object({ id: z.string(), nameRu: z.string(), nameEn: z.string() });
const IngredientSchema = EntrySchema.extend({ aliases: z.array(z.string()).default([]) });
export type VocabEntry = z.infer<typeof EntrySchema>;
export type IngredientEntry = z.infer<typeof IngredientSchema>;
export interface Vocab { cuisines: VocabEntry[]; categories: VocabEntry[]; ingredients: IngredientEntry[] }

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function loadVocab(dir: string): Promise<Vocab> {
  return {
    cuisines: await readJson(path.join(dir, "cuisines.json"), z.array(EntrySchema)),
    categories: await readJson(path.join(dir, "categories.json"), z.array(EntrySchema)),
    ingredients: await readJson(path.join(dir, "ingredients.json"), z.array(IngredientSchema)),
  };
}
```

```ts
// src/vocab/validate.ts
import type { Vocab } from "./load.js";
import type { DraftIngredient } from "../schemas/recipe.js";

export function validateRecipe(
  recipe: { cuisine: string; category: string; ingredients: DraftIngredient[] },
  vocab: Vocab,
): string[] {
  const errors: string[] = [];
  if (!vocab.cuisines.some((c) => c.id === recipe.cuisine)) errors.push(`unknown cuisine: ${recipe.cuisine}`);
  if (!vocab.categories.some((c) => c.id === recipe.category)) errors.push(`unknown category: ${recipe.category}`);
  const ids = new Set(vocab.ingredients.map((i) => i.id));
  for (const ing of recipe.ingredients) {
    if (ing.ingredient !== null && !ids.has(ing.ingredient)) errors.push(`unknown ingredient: ${ing.ingredient}`);
  }
  return errors;
}

export function ingredientPromptList(vocab: Vocab): string {
  return vocab.ingredients
    .map((i) => `${i.id} — ${i.nameRu} / ${i.nameEn}${i.aliases.length ? ` (${i.aliases.join(", ")})` : ""}`)
    .join("\n");
}
```

- [ ] **Step 5: Add a loader smoke test to the same file and run**

Append to `test/vocab/validate.test.ts`:

```ts
import { loadVocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

describe("loadVocab", () => {
  it("loads the real vocab files and every id is a slug", async () => {
    const v = await loadVocab(config.paths.vocab);
    for (const e of [...v.cuisines, ...v.categories, ...v.ingredients]) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(v.ingredients.length).toBeGreaterThanOrEqual(60);
  });
});
```

Run: `npx vitest run test/vocab && npx tsc --noEmit`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add vocab src/vocab test/vocab
git commit -m "Add controlled vocabularies with loader and validator"
```

---

### Task 4: VTT parsing and slicing

**Files:**
- Create: `src/fetcher/vtt.ts`, `test/fixtures/sample.ru.vtt`
- Test: `test/fetcher/vtt.test.ts`

**Interfaces:**
- Produces: `parseVtt(text: string): TranscriptCue[]` (dedupes YouTube's rolling duplicate lines), `sliceCues(cues, start, end): TranscriptCue[]`, `renderTranscript(cues): string` (one line per cue: `[mm:ss] text`), `formatTimestamp(sec:number): string`.

- [ ] **Step 1: Write the fixture**

`test/fixtures/sample.ru.vtt` (YouTube auto-caption style, with the rolling duplicate pattern):

```
WEBVTT
Kind: captions
Language: ru

00:00:00.000 --> 00:00:02.500 align:start position:0%
 
Всем<00:00:00.500><c> привет</c><00:00:01.000><c> дорогие</c><00:00:01.500><c> друзья</c>

00:00:02.500 --> 00:00:02.510 align:start position:0%
Всем привет дорогие друзья
 

00:00:02.510 --> 00:00:05.000 align:start position:0%
Всем привет дорогие друзья
сегодня<00:00:03.000><c> будет</c><00:00:03.500><c> лазанья</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
сегодня будет лазанья
 

00:01:00.000 --> 00:01:03.000 align:start position:0%
нарежем<00:01:00.500><c> кубиком</c><00:01:01.000><c> лук</c>
```

- [ ] **Step 2: Write the failing test**

```ts
// test/fetcher/vtt.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVtt, sliceCues, renderTranscript, formatTimestamp } from "../../src/fetcher/vtt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vtt = readFileSync(path.join(here, "../fixtures/sample.ru.vtt"), "utf8");

describe("parseVtt", () => {
  it("strips inline timing tags and drops rolling duplicates", () => {
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.text)).toEqual([
      "Всем привет дорогие друзья",
      "сегодня будет лазанья",
      "нарежем кубиком лук",
    ]);
    expect(cues[0]).toEqual({ start: 0, end: 2.5, text: "Всем привет дорогие друзья" });
    expect(cues[2].start).toBe(60);
  });
});

describe("sliceCues", () => {
  it("keeps cues overlapping the range", () => {
    const cues = parseVtt(vtt);
    expect(sliceCues(cues, 2, 10).map((c) => c.text)).toEqual(["Всем привет дорогие друзья", "сегодня будет лазанья"]);
    expect(sliceCues(cues, 59, 70).map((c) => c.text)).toEqual(["нарежем кубиком лук"]);
  });
});

describe("renderTranscript", () => {
  it("prefixes each cue with mm:ss", () => {
    expect(formatTimestamp(61)).toBe("01:01");
    expect(formatTimestamp(3600)).toBe("60:00");
    const out = renderTranscript(parseVtt(vtt));
    expect(out.split("\n")[2]).toBe("[01:00] нарежем кубиком лук");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/fetcher/vtt.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write src/fetcher/vtt.ts**

```ts
import type { TranscriptCue } from "../schemas/source.js";

function toSeconds(ts: string): number {
  const [h, m, s] = ts.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function cleanLine(line: string): string {
  return line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Parse YouTube auto-caption VTT into de-duplicated cues. */
export function parseVtt(text: string): TranscriptCue[] {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const cues: TranscriptCue[] = [];
  let lastText = "";
  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [startRaw, endRaw] = lines[idx].split("-->");
    const start = toSeconds(startRaw);
    const end = toSeconds(endRaw.split(" ")[1] ?? endRaw); // "00:00:02.500 align:start..." → first token after arrow
    // YouTube emits the previous cue's text again as the first line; take the last non-empty line.
    const textLines = lines.slice(idx + 1).map(cleanLine).filter(Boolean);
    const candidate = textLines.at(-1);
    if (!candidate) continue;
    if (candidate === lastText) continue; // rolling duplicate
    if (end - start < 0.05) continue;     // YouTube's 10 ms "hold" cues
    cues.push({ start, end, text: candidate });
    lastText = candidate;
  }
  return cues;
}

export function sliceCues(cues: TranscriptCue[], start: number, end: number): TranscriptCue[] {
  return cues.filter((c) => c.end >= start && c.start <= end);
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderTranscript(cues: TranscriptCue[]): string {
  return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join("\n");
}
```

Note on the `end` parse: the line is `00:00:00.000 --> 00:00:02.500 align:start position:0%`. After splitting on `-->`, `endRaw` is ` 00:00:02.500 align:start position:0%`; `endRaw.trim().split(" ")[0]` is the timestamp. Use that form: `const end = toSeconds(endRaw.trim().split(" ")[0]);`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/fetcher && npx tsc --noEmit`
Expected: all pass. If the duplicate-handling assertion fails, print `parseVtt(vtt)` and adjust the "hold cue" threshold; the fixture's hold cues last 10 ms.

- [ ] **Step 6: Commit**

```bash
git add src/fetcher/vtt.ts test/fetcher/vtt.test.ts test/fixtures/sample.ru.vtt
git commit -m "Parse YouTube auto-caption VTT into timestamped cues"
```

---

### Task 5: yt-dlp fetcher

**Files:**
- Create: `src/fetcher/ytdlp.ts`
- Test: `test/fetcher/ytdlp.test.ts`

**Interfaces:**
- Consumes: `parseVtt` from Task 4, `VideoSourceSchema` from Task 2.
- Produces: `expandUrl(url: string): Promise<string[]>` (video ids; a single video URL yields one id), `fetchVideo(videoId: string, workDir: string): Promise<VideoSource | { videoId: string; skipped: "no-captions" }>`, `parseVideoId(url: string): string | null`.
- Requires `yt-dlp` on PATH. Install: `brew install yt-dlp` (or `pipx install yt-dlp`). Add to README in Task 14.

- [ ] **Step 1: Write the failing unit test for URL parsing**

```ts
// test/fetcher/ytdlp.test.ts
import { describe, it, expect } from "vitest";
import { parseVideoId, buildSource } from "../../src/fetcher/ytdlp.js";

describe("parseVideoId", () => {
  it("handles youtu.be, watch, and shorts URLs", () => {
    expect(parseVideoId("https://youtu.be/bskR7LVpF7I?si=abc")).toBe("bskR7LVpF7I");
    expect(parseVideoId("https://www.youtube.com/watch?v=bskR7LVpF7I&t=10")).toBe("bskR7LVpF7I");
    expect(parseVideoId("https://www.youtube.com/playlist?list=PL123")).toBeNull();
  });
});

describe("buildSource", () => {
  it("maps yt-dlp info json + cues into a VideoSource", () => {
    const info = { id: "abc", webpage_url: "https://www.youtube.com/watch?v=abc", title: "T", tags: ["a"], channel: "C", channel_id: "UC1", duration: 100, upload_date: "20250101" };
    const src = buildSource(info, [{ start: 0, end: 1, text: "x" }]);
    expect(src).toMatchObject({ videoId: "abc", channelId: "UC1", durationSec: 100, uploadDate: "2025-01-01", language: "ru" });
    expect(src.cues).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fetcher/ytdlp.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/fetcher/ytdlp.ts**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseVtt } from "./vtt.js";
import { VideoSourceSchema, type TranscriptCue, type VideoSource } from "../schemas/source.js";

const exec = promisify(execFile);

export function parseVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.searchParams.get("list") && !u.searchParams.get("v")) return null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/^\/(shorts|embed)\/([^/?]+)/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/** A single video URL → [id]; a playlist/channel URL → every video id. */
export async function expandUrl(url: string): Promise<string[]> {
  const single = parseVideoId(url);
  if (single) return [single];
  const { stdout } = await exec("yt-dlp", ["--flat-playlist", "--print", "%(id)s", url], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

const InfoSchema = z.object({
  id: z.string(),
  webpage_url: z.string(),
  title: z.string(),
  tags: z.array(z.string()).nullable().default([]),
  channel: z.string(),
  channel_id: z.string(),
  duration: z.number(),
  upload_date: z.string().nullable().default(null),
});
type Info = z.infer<typeof InfoSchema>;

export function buildSource(info: Info, cues: TranscriptCue[]): VideoSource {
  const d = info.upload_date;
  return VideoSourceSchema.parse({
    videoId: info.id,
    url: info.webpage_url,
    title: info.title,
    tags: info.tags ?? [],
    channel: info.channel,
    channelId: info.channel_id,
    durationSec: info.duration,
    uploadDate: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    language: "ru",
    cues,
  });
}

export type FetchResult = VideoSource | { videoId: string; skipped: "no-captions" };

/** Downloads info json + Russian auto-captions into workDir and returns a VideoSource. */
export async function fetchVideo(videoId: string, workDir: string): Promise<FetchResult> {
  await mkdir(workDir, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  await exec("yt-dlp", [
    "--skip-download", "--write-info-json", "--write-auto-subs", "--sub-langs", "ru", "--sub-format", "vtt",
    "-o", path.join(workDir, "%(id)s.%(ext)s"), url,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const files = await readdir(workDir);
  const infoFile = files.find((f) => f === `${videoId}.info.json`);
  if (!infoFile) throw new Error(`yt-dlp produced no info json for ${videoId}`);
  const info = InfoSchema.parse(JSON.parse(await readFile(path.join(workDir, infoFile), "utf8")));
  const vttFile = files.find((f) => f.startsWith(`${videoId}.ru`) && f.endsWith(".vtt"));
  if (!vttFile) return { videoId, skipped: "no-captions" };
  const cues = parseVtt(await readFile(path.join(workDir, vttFile), "utf8"));
  return buildSource(info, cues);
}
```

- [ ] **Step 4: Run unit tests**

Run: `npx vitest run test/fetcher && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 5: Manual smoke test against the real video**

Run: `npx tsx -e 'import("./src/fetcher/ytdlp.js").then(async m => { const r = await m.fetchVideo("bskR7LVpF7I", ".cache/bskR7LVpF7I/yt"); console.log("cues" in r ? r.cues.length + " cues, first: " + r.cues[0].text : r); })'`
Expected: a few hundred cues, first cue starts with "Всем привет". If `yt-dlp` is missing, install it and rerun.

- [ ] **Step 6: Commit**

```bash
git add src/fetcher/ytdlp.ts test/fetcher/ytdlp.test.ts
git commit -m "Fetch video metadata and Russian auto-captions via yt-dlp"
```

---

### Task 6: LLM client wrapper with usage ledger

**Files:**
- Create: `src/llm/usage.ts`, `src/llm/client.ts`
- Test: `test/llm/usage.test.ts`, `test/llm/client.test.ts`

**Interfaces:**
- Produces:
  - `UsageLedger` with `add(agent: AgentName, model: string, usage: { input_tokens:number; output_tokens:number })`, `total(): { input:number; output:number; calls:number }`, `byAgent(): Record<string,{input,output,calls}>`, `toString(): string`.
  - `LlmClient` with `callStructured<T>(opts: { agent: AgentName; system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T>`.
  - `createLlmClient(config: Config, ledger: UsageLedger, anthropic?: Anthropic): LlmClient` — the third argument lets tests inject a fake.
- Behavior: uses `client.messages.parse` with `output_config.format = zodOutputFormat(schema)`; throws `LlmParseError` if `parsed_output` is null or `stop_reason === "refusal"`; one outer retry on parse failure.

- [ ] **Step 1: Write the failing ledger test**

```ts
// test/llm/usage.test.ts
import { describe, it, expect } from "vitest";
import { UsageLedger } from "../../src/llm/usage.js";

describe("UsageLedger", () => {
  it("sums totals and groups by agent", () => {
    const l = new UsageLedger();
    l.add("scout", "claude-sonnet-5", { input_tokens: 100, output_tokens: 10 });
    l.add("scout", "claude-sonnet-5", { input_tokens: 50, output_tokens: 5 });
    l.add("extractor", "claude-sonnet-5", { input_tokens: 1, output_tokens: 1 });
    expect(l.total()).toEqual({ input: 151, output: 16, calls: 3 });
    expect(l.byAgent().scout).toEqual({ input: 150, output: 15, calls: 2 });
    expect(l.toString()).toContain("scout");
  });
});
```

- [ ] **Step 2: Write the failing client test with a fake Anthropic**

```ts
// test/llm/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, LlmParseError } from "../../src/llm/client.js";
import { UsageLedger } from "../../src/llm/usage.js";
import { buildConfig } from "../../src/config.js";

const Out = z.object({ answer: z.string() });

function fakeAnthropic(responses: Array<{ parsed_output: unknown; stop_reason: string }>) {
  const parse = vi.fn(async () => ({ ...responses.shift()!, usage: { input_tokens: 10, output_tokens: 2 } }));
  return { client: { messages: { parse } } as any, parse };
}

describe("callStructured", () => {
  it("returns parsed output and records usage under the agent", async () => {
    const { client, parse } = fakeAnthropic([{ parsed_output: { answer: "ok" }, stop_reason: "end_turn" }]);
    const ledger = new UsageLedger();
    const llm = createLlmClient(buildConfig({}), ledger, client);
    const out = await llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out });
    expect(out).toEqual({ answer: "ok" });
    expect(ledger.byAgent().scout.calls).toBe(1);
    expect(parse.mock.calls[0][0]).toMatchObject({ model: "claude-sonnet-5", system: "s" });
  });
  it("retries once when parsed_output is null, then throws", async () => {
    const { client, parse } = fakeAnthropic([
      { parsed_output: null, stop_reason: "end_turn" },
      { parsed_output: null, stop_reason: "end_turn" },
    ]);
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toBeInstanceOf(LlmParseError);
    expect(parse).toHaveBeenCalledTimes(2);
  });
  it("throws on refusal without retrying", async () => {
    const { client, parse } = fakeAnthropic([{ parsed_output: null, stop_reason: "refusal" }]);
    const llm = createLlmClient(buildConfig({}), new UsageLedger(), client);
    await expect(llm.callStructured({ agent: "scout", system: "s", user: "u", schema: Out })).rejects.toThrow(/refus/i);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `npx vitest run test/llm`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write usage.ts and client.ts**

```ts
// src/llm/usage.ts
import type { AgentName } from "../config.js";

interface Bucket { input: number; output: number; calls: number }

export class UsageLedger {
  private buckets = new Map<string, Bucket>();

  add(agent: AgentName, model: string, usage: { input_tokens: number; output_tokens: number }): void {
    const b = this.buckets.get(agent) ?? { input: 0, output: 0, calls: 0 };
    b.input += usage.input_tokens;
    b.output += usage.output_tokens;
    b.calls += 1;
    this.buckets.set(agent, b);
    void model; // kept for future per-model pricing
  }

  byAgent(): Record<string, Bucket> {
    return Object.fromEntries(this.buckets);
  }

  total(): Bucket {
    let t: Bucket = { input: 0, output: 0, calls: 0 };
    for (const b of this.buckets.values()) t = { input: t.input + b.input, output: t.output + b.output, calls: t.calls + b.calls };
    return t;
  }

  toString(): string {
    const lines = [...this.buckets.entries()].map(([a, b]) => `${a.padEnd(12)} ${String(b.calls).padStart(4)} calls ${String(b.input).padStart(9)} in ${String(b.output).padStart(8)} out`);
    const t = this.total();
    lines.push(`${"total".padEnd(12)} ${String(t.calls).padStart(4)} calls ${String(t.input).padStart(9)} in ${String(t.output).padStart(8)} out`);
    return lines.join("\n");
  }
}
```

```ts
// src/llm/client.ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { AgentName, Config } from "../config.js";
import type { UsageLedger } from "./usage.js";

export class LlmParseError extends Error {}

export interface StructuredCall<T> {
  agent: AgentName;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LlmClient {
  callStructured<T>(opts: StructuredCall<T>): Promise<T>;
}

export function createLlmClient(config: Config, ledger: UsageLedger, anthropic: Anthropic = new Anthropic()): LlmClient {
  async function once<T>(opts: StructuredCall<T>): Promise<T> {
    const model = config.models[opts.agent];
    const response = await anthropic.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    ledger.add(opts.agent, model, response.usage);
    if (response.stop_reason === "refusal") throw new LlmParseError(`${opts.agent}: model refused the request`);
    if (response.parsed_output == null) throw new LlmParseError(`${opts.agent}: response did not match schema`);
    return response.parsed_output as T;
  }

  return {
    async callStructured<T>(opts: StructuredCall<T>): Promise<T> {
      try {
        return await once(opts);
      } catch (e) {
        if (e instanceof LlmParseError && !/refused/.test(e.message)) return once(opts);
        throw e;
      }
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/llm && npx tsc --noEmit`
Expected: 4 passed. If `zodOutputFormat` import path errors, check `node_modules/@anthropic-ai/sdk/helpers/zod` exists and the installed SDK version supports `messages.parse`; upgrade with `npm install @anthropic-ai/sdk@latest` if not.

- [ ] **Step 6: Commit**

```bash
git add src/llm test/llm
git commit -m "Add structured-output LLM client with usage ledger"
```

---

### Task 7: Prompt loader and scout agent

**Files:**
- Create: `src/prompts/load.ts`, `src/prompts/scout.md`, `src/agents/scout.ts`
- Test: `test/agents/scout.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 6), `renderTranscript`, `sliceCues` (Task 4), `ScoutResultSchema` (Task 2).
- Produces: `loadPrompt(name: string, promptsDir: string): Promise<string>`, `buildScoutUser(source: VideoSource): string`, `runScout(source: VideoSource, llm: LlmClient, promptsDir: string): Promise<ScoutResult>`. `runScout` post-processes: for each returned segment it **overwrites `rawText`** with the verbatim slice from `source.cues` for `[start,end]` (so raw text is never LLM-authored), clamps `end` to `durationSec`, and drops segments shorter than 20 seconds.

- [ ] **Step 1: Write src/prompts/scout.md**

```markdown
You are the SCOUT agent in a recipe-extraction pipeline for a Russian-language YouTube cooking channel run by a ship's cook. The channel mixes recipe videos with travel vlogs and sponsor updates. A single recipe video can contain up to 8 dishes ("меню на день").

You receive the video title, its tags, and the full auto-generated Russian transcript with [mm:ss] timestamps. Auto-captions contain speech-to-text errors (e.g. "стебля сидений" for "стебля сельдерея").

Your job: find every dish that is actually cooked in this video and report where it happens.

Rules:
1. `isRecipeVideo` is false and `segments` is empty if nothing is cooked (travel, vlog, contract talk, restaurant visit).
2. One segment per dish. A sauce or side made only as part of a main dish is NOT its own segment (bolognese inside a lasagna stays in the lasagna). If the chef presents it as a standalone thing he plates separately, it is a segment.
3. `start` and `end` are seconds into the video. Dishes can interleave (soup simmers while he makes a salad); overlapping ranges are fine. Cover every moment where that dish is handled.
4. `workingName`: the dish as the chef names it, in Russian, short. Not the video title.
5. `rawText`: copy the transcript lines for the range verbatim, without the [mm:ss] prefixes. Do not fix anything here.
6. `cleanText`: the same lines with speech-to-text errors corrected, filler ("так", "погнали", "[музыка]") removed, and sentences punctuated. You may fix words. You must NOT add, remove, or reorder any ingredient, quantity, or action. If unsure whether a word is an error, leave it.

Return only the structured result.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/agents/scout.test.ts
import { describe, it, expect, vi } from "vitest";
import { runScout, buildScoutUser } from "../../src/agents/scout.js";
import type { VideoSource } from "../../src/schemas/source.js";
import { config } from "../../src/config.js";

const source: VideoSource = {
  videoId: "v1", url: "u", title: "Судовой рецепт | Лазанья", tags: ["лазанья"], channel: "C", channelId: "UC", durationSec: 120, uploadDate: null, language: "ru",
  cues: [
    { start: 0, end: 5, text: "Всем привет сегодня лазанья" },
    { start: 30, end: 35, text: "нарежем кубиком лук" },
    { start: 100, end: 105, text: "приятного аппетита" },
  ],
};

describe("buildScoutUser", () => {
  it("includes title, tags and timestamped transcript", () => {
    const u = buildScoutUser(source);
    expect(u).toContain("Судовой рецепт | Лазанья");
    expect(u).toContain("лазанья");
    expect(u).toContain("[00:30] нарежем кубиком лук");
  });
});

describe("runScout", () => {
  it("replaces rawText with the verbatim cue slice and clamps end", async () => {
    const llm = { callStructured: vi.fn(async () => ({
      isRecipeVideo: true,
      segments: [{ workingName: "лазанья", start: 25, end: 999, rawText: "LLM WROTE THIS", cleanText: "Нарежем кубиком лук." }],
    })) };
    const r = await runScout(source, llm as any, config.paths.prompts);
    expect(r.segments[0].rawText).toBe("нарежем кубиком лук\nприятного аппетита");
    expect(r.segments[0].end).toBe(120);
    expect(llm.callStructured.mock.calls[0][0].agent).toBe("scout");
  });
  it("drops segments shorter than 20 seconds", async () => {
    const llm = { callStructured: vi.fn(async () => ({
      isRecipeVideo: true,
      segments: [{ workingName: "x", start: 30, end: 40, rawText: "", cleanText: "" }],
    })) };
    const r = await runScout(source, llm as any, config.paths.prompts);
    expect(r.segments).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/scout.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write load.ts and scout.ts**

```ts
// src/prompts/load.ts
import { readFile } from "node:fs/promises";
import path from "node:path";

const cache = new Map<string, string>();

export async function loadPrompt(name: string, promptsDir: string): Promise<string> {
  const key = path.join(promptsDir, `${name}.md`);
  const hit = cache.get(key);
  if (hit) return hit;
  const text = (await readFile(key, "utf8")).trim();
  cache.set(key, text);
  return text;
}
```

```ts
// src/agents/scout.ts
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { ScoutResultSchema, type ScoutResult } from "../schemas/scout.js";
import type { VideoSource } from "../schemas/source.js";
import { renderTranscript, sliceCues } from "../fetcher/vtt.js";

export const MIN_SEGMENT_SECONDS = 20;

export function buildScoutUser(source: VideoSource): string {
  return [
    `Title: ${source.title}`,
    `Tags: ${source.tags.join(", ") || "(none)"}`,
    `Duration: ${source.durationSec} seconds`,
    "",
    "Transcript:",
    renderTranscript(source.cues),
  ].join("\n");
}

export async function runScout(source: VideoSource, llm: LlmClient, promptsDir: string): Promise<ScoutResult> {
  const system = await loadPrompt("scout", promptsDir);
  const raw = await llm.callStructured({ agent: "scout", system, user: buildScoutUser(source), schema: ScoutResultSchema, maxTokens: 32000 });
  const segments = raw.segments
    .map((s) => {
      const start = Math.max(0, s.start);
      const end = Math.min(source.durationSec, s.end);
      return { ...s, start, end, rawText: sliceCues(source.cues, start, end).map((c) => c.text).join("\n") };
    })
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SECONDS);
  return { isRecipeVideo: raw.isRecipeVideo && segments.length > 0, segments };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/agents && npx tsc --noEmit`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/load.ts src/prompts/scout.md src/agents/scout.ts test/agents/scout.test.ts
git commit -m "Add scout agent that segments a video into dishes"
```

---

### Task 8: Extractor agent

**Files:**
- Create: `src/prompts/extractor.md`, `src/agents/extractor.ts`
- Test: `test/agents/extractor.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `loadPrompt`, `ingredientPromptList` (Task 3), `DraftRecipeSchema`, `ScoutSegment`.
- Produces: `buildExtractorUser(segment: ScoutSegment, vocab: Vocab): string`, `runExtractor(segment: ScoutSegment, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<DraftRecipe>`. Post-processing: any `ingredient` id not in the vocab is set to `null` and its `rawName` pushed to `unmappedIngredients` (dedupe); steps are renumbered `1..n` in order of `timestamp`; timestamps below `segment.start` are clamped to `segment.start`.

- [ ] **Step 1: Write src/prompts/extractor.md**

```markdown
You are the EXTRACTOR agent. You receive the cleaned transcript of ONE dish being cooked by a Russian-speaking chef, with the dish's working name and its timestamp range. You produce one structured recipe.

Grounding rules — these matter more than completeness:
1. Every ingredient and every step must come from what the chef said. Never add an ingredient or step from your own knowledge of the dish.
2. Quantities:
   - `stated`: the chef said an amount ("полтора литра молока" → quantity 1.5, unit "l").
   - `inferred`: the chef's phrasing implies an amount without a number. "возьмём луковицу" → 1 pc. "пару зубчиков чеснока" → 2 clove. "пачку сливочного масла" → 1 pack (unit "pack").
   - `unknown`: the chef used it but never said or implied how much. quantity and unit are null.
   Never fill a quantity because "a lasagna usually needs 500 g of mince". That is forbidden.
3. Units: g, kg, ml, l, pc, tbsp, tsp, clove, pack, pinch, or null. Convert "полкило" → 500 g, "литр" → 1 l.
4. `ingredient`: the canonical id from the vocabulary list below. Match by Russian name or alias; speech-to-text garbles are common, so "стебля сидений" is celery-stalk. If nothing fits, set `ingredient` to null and put the raw name in `unmappedIngredients`. Never invent a new id.
5. `rawName`: the chef's own words for it, in Russian.
6. Steps: imperative Russian sentences in cooking order, one action each. `timestamp` is the second (from the [mm:ss] markers) where the chef starts that action. Merge trivial chatter; keep every real action.
7. `nameRu`: canonical dish name = base dish + the single variation that defines it. No adjectives, no chef or channel name, no "судовой". Examples: "Лазанья с соусом болоньезе", "Борщ с фасолью", "Оливье", "Сырники", "Паста карбонара", "Хачапури по-аджарски", "Плов с бараниной", "Куриный суп с лапшой", "Драники", "Гуляш из говядины".
8. `nameEn`: English form of the same canonical name.
9. `servings`: only if the chef states it (crew of 20 → 20), else null.

Return only the structured recipe.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/agents/extractor.test.ts
import { describe, it, expect, vi } from "vitest";
import { runExtractor, buildExtractorUser } from "../../src/agents/extractor.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [], categories: [],
  ingredients: [{ id: "onion", nameRu: "Лук", nameEn: "Onion", aliases: [] }],
};
const segment: ScoutSegment = { workingName: "лазанья", start: 30, end: 200, rawText: "raw", cleanText: "Нарежем кубиком лук. Добавим фарш." };

describe("buildExtractorUser", () => {
  it("includes working name, range, clean text and the vocabulary", () => {
    const u = buildExtractorUser(segment, vocab);
    expect(u).toContain("лазанья");
    expect(u).toContain("onion — Лук / Onion");
    expect(u).toContain("Нарежем кубиком лук");
  });
});

describe("runExtractor", () => {
  it("nulls unknown ingredient ids, records them as unmapped, and renumbers steps by timestamp", async () => {
    const llm = { callStructured: vi.fn(async () => ({
      nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
      ingredients: [
        { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
        { ingredient: "minced-unicorn", rawName: "фарш", quantity: null, unit: null, provenance: "unknown", note: null },
      ],
      steps: [
        { order: 1, text: "Добавить фарш.", timestamp: 90 },
        { order: 2, text: "Нарезать лук.", timestamp: 10 },
      ],
    })) };
    const r = await runExtractor(segment, vocab, llm as any, config.paths.prompts);
    expect(r.ingredients[1].ingredient).toBeNull();
    expect(r.unmappedIngredients).toEqual(["фарш"]);
    expect(r.steps.map((s) => [s.order, s.timestamp])).toEqual([[1, 30], [2, 90]]);
    expect(llm.callStructured.mock.calls[0][0].agent).toBe("extractor");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/extractor.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write src/agents/extractor.ts**

```ts
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { DraftRecipeSchema, type DraftRecipe } from "../schemas/recipe.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Vocab } from "../vocab/load.js";
import { ingredientPromptList } from "../vocab/validate.js";
import { formatTimestamp } from "../fetcher/vtt.js";

export function buildExtractorUser(segment: ScoutSegment, vocab: Vocab): string {
  return [
    `Dish (working name): ${segment.workingName}`,
    `Segment range: ${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)} (${segment.start}s–${segment.end}s)`,
    "",
    "Ingredient vocabulary (id — Russian / English (aliases)):",
    ingredientPromptList(vocab),
    "",
    "Cleaned transcript:",
    segment.cleanText,
  ].join("\n");
}

export async function runExtractor(segment: ScoutSegment, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<DraftRecipe> {
  const system = await loadPrompt("extractor", promptsDir);
  const raw = await llm.callStructured({ agent: "extractor", system, user: buildExtractorUser(segment, vocab), schema: DraftRecipeSchema });
  const known = new Set(vocab.ingredients.map((i) => i.id));
  const unmapped = new Set(raw.unmappedIngredients);
  const ingredients = raw.ingredients.map((ing) => {
    if (ing.ingredient !== null && !known.has(ing.ingredient)) {
      unmapped.add(ing.rawName);
      return { ...ing, ingredient: null };
    }
    return ing;
  });
  const steps = [...raw.steps]
    .map((s) => ({ ...s, timestamp: Math.max(segment.start, s.timestamp) }))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((s, i) => ({ ...s, order: i + 1 }));
  return { ...raw, ingredients, steps, unmappedIngredients: [...unmapped] };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/agents && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/extractor.md src/agents/extractor.ts test/agents/extractor.test.ts
git commit -m "Add extractor agent producing grounded draft recipes"
```

---

### Task 9: Verifier agent

**Files:**
- Create: `src/prompts/verifier.md`, `src/agents/verifier.ts`
- Test: `test/agents/verifier.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `loadPrompt`, `VerificationSchema`, `DraftRecipe`, `ScoutSegment`.
- Produces: `runVerifier(segment: ScoutSegment, draft: DraftRecipe, llm, promptsDir): Promise<Verification>` and `flagsFromVerification(draft: DraftRecipe, v: Verification): RecipeFlag[]` (pure): one flag per ingredient with provenance `stated|inferred` whose entry is `supported: false` or missing from `v.ingredients`, and one per step marked unsupported. `unknown`-provenance ingredients are never flagged.

- [ ] **Step 1: Write src/prompts/verifier.md**

```markdown
You are the VERIFIER agent. You receive the RAW auto-caption transcript of one dish (with speech-to-text noise, unedited) and a draft recipe extracted from it. Your job is to check that the draft is grounded in the transcript.

For every ingredient in the draft:
- Find the shortest transcript quote that supports its presence AND, when provenance is `stated` or `inferred`, its quantity. Put it in `quote`.
- `supported` is true only if the quote genuinely supports it. Speech-to-text garbles count as support when the intended word is obvious ("стебля сидений" supports celery).
- For provenance `unknown`, only presence needs support.
- If no quote exists, `quote` is null and `supported` is false.

For every step: the same, by `order`. A step is supported if the chef performs or describes that action.

`confidence`: your overall 0–1 estimate that the draft reflects what the chef actually did.

Be strict about quantities: a draft saying 500 g of mince when the chef never said an amount is unsupported. Be lenient about wording.

Return only the structured result.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/agents/verifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { runVerifier, flagsFromVerification } from "../../src/agents/verifier.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { ScoutSegment } from "../../src/schemas/scout.js";
import { config } from "../../src/config.js";

const draft: DraftRecipe = {
  nameRu: "Лазанья", nameEn: "Lasagna", servings: null, unmappedIngredients: [],
  ingredients: [
    { ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null },
    { ingredient: "beef-mince", rawName: "фарш", quantity: 500, unit: "g", provenance: "stated", note: null },
    { ingredient: "salt", rawName: "соль", quantity: null, unit: null, provenance: "unknown", note: null },
  ],
  steps: [{ order: 1, text: "Нарезать лук.", timestamp: 30 }, { order: 2, text: "Обжарить фарш.", timestamp: 60 }],
};
const segment: ScoutSegment = { workingName: "лазанья", start: 0, end: 100, rawText: "нарежем кубиком лук добавляем фарш", cleanText: "" };

describe("flagsFromVerification", () => {
  it("flags unsupported stated/inferred ingredients and steps, never unknown ones", () => {
    const flags = flagsFromVerification(draft, {
      ingredients: [
        { rawName: "лук", quote: "нарежем кубиком лук", supported: true },
        { rawName: "фарш", quote: null, supported: false },
      ],
      steps: [{ order: 1, quote: "нарежем", supported: true }, { order: 2, quote: null, supported: false }],
      confidence: 0.7,
    });
    expect(flags).toEqual([
      { kind: "ingredient", ref: "фарш", reason: "quantity or presence not supported by transcript" },
      { kind: "step", ref: "2", reason: "action not found in transcript" },
    ]);
  });
});

describe("runVerifier", () => {
  it("sends raw text and the draft to the verifier agent", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ingredients: [], steps: [], confidence: 1 })) };
    await runVerifier(segment, draft, llm as any, config.paths.prompts);
    const call = llm.callStructured.mock.calls[0][0];
    expect(call.agent).toBe("verifier");
    expect(call.user).toContain("нарежем кубиком лук");
    expect(call.user).toContain("Обжарить фарш");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/verifier.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write src/agents/verifier.ts**

```ts
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { VerificationSchema, type DraftRecipe, type RecipeFlag, type Verification } from "../schemas/recipe.js";
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
  return llm.callStructured({ agent: "verifier", system, user: buildVerifierUser(segment, draft), schema: VerificationSchema });
}

export function flagsFromVerification(draft: DraftRecipe, v: Verification): RecipeFlag[] {
  const flags: RecipeFlag[] = [];
  for (const ing of draft.ingredients) {
    if (ing.provenance === "unknown") continue;
    const entry = v.ingredients.find((e) => e.rawName === ing.rawName);
    if (!entry || !entry.supported) flags.push({ kind: "ingredient", ref: ing.rawName, reason: "quantity or presence not supported by transcript" });
  }
  for (const step of draft.steps) {
    const entry = v.steps.find((e) => e.order === step.order);
    if (entry && !entry.supported) flags.push({ kind: "step", ref: String(step.order), reason: "action not found in transcript" });
  }
  return flags;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/agents && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/verifier.md src/agents/verifier.ts test/agents/verifier.test.ts
git commit -m "Add verifier agent that grounds drafts in the raw transcript"
```

---

### Task 10: Categorizer agent

**Files:**
- Create: `src/prompts/categorizer.md`, `src/agents/categorizer.ts`
- Test: `test/agents/categorizer.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `loadPrompt`, `CategorizationSchema`, `DraftRecipe`, `Vocab`.
- Produces: `runCategorizer(draft: DraftRecipe, vocab: Vocab, llm, promptsDir): Promise<Categorization>`. Post-processing: if `cuisine` is not in vocab → `"other"`; if `category` not in vocab → throw `Error("categorizer returned unknown category: …")` (this is a prompt bug, surface it); `dishKey` is normalized with `slugify` (lowercase, non-alphanumerics → `-`, trim dashes).

- [ ] **Step 1: Write src/prompts/categorizer.md**

```markdown
You are the CATEGORIZER agent. You receive one finished recipe (name, ingredients, steps) and assign classification fields from fixed lists.

- `cuisine`: exactly one id from the cuisine list. Pick the tradition the dish belongs to, not where the chef is. Pelmeni → russian, borscht → ukrainian, khachapuri → georgian, lasagna → italian. If it is a generic dish with no clear tradition, use "other".
- `mealTypes`: one or more of breakfast, lunch, dinner, as this dish is realistically eaten. Syrniki → ["breakfast"]. Borscht → ["lunch","dinner"]. Lasagna → ["dinner"].
- `category`: exactly one id from the category list.
- `activeMinutes`: hands-on time implied by the steps; `totalMinutes`: including simmering/baking/resting the chef mentions. Null if the steps give no basis.
- `richness`: light (salads, light soups), medium, hearty (meat bakes, stews, dumplings).
- `dishKey`: English slug of base dish + defining variation, matching the recipe name: "Лазанья с соусом болоньезе" → lasagna-bolognese; "Борщ с фасолью" → borscht-beans; "Оливье" → olivier; "Сырники" → syrniki; "Плов с бараниной" → plov-lamb. Lowercase letters, digits and single dashes only. Use the dish's common transliteration, not a translation ("syrniki", not "cheese-pancakes").

Return only the structured result.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/agents/categorizer.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCategorizer, slugify } from "../../src/agents/categorizer.js";
import type { DraftRecipe } from "../../src/schemas/recipe.js";
import type { Vocab } from "../../src/vocab/load.js";
import { config } from "../../src/config.js";

const vocab: Vocab = {
  cuisines: [{ id: "italian", nameRu: "", nameEn: "" }, { id: "other", nameRu: "", nameEn: "" }],
  categories: [{ id: "pasta", nameRu: "", nameEn: "" }],
  ingredients: [],
};
const draft: DraftRecipe = { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, ingredients: [], steps: [], unmappedIngredients: [] };
const base = { mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty" };

describe("slugify", () => {
  it("normalizes to a dish key", () => {
    expect(slugify(" Lasagna  Bolognese! ")).toBe("lasagna-bolognese");
  });
});

describe("runCategorizer", () => {
  it("falls back to other for unknown cuisine and slugifies dishKey", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "klingon", dishKey: "lasagna-bolognese" })) };
    const c = await runCategorizer(draft, vocab, llm as any, config.paths.prompts);
    expect(c.cuisine).toBe("other");
    expect(c.dishKey).toBe("lasagna-bolognese");
  });
  it("throws on unknown category", async () => {
    const llm = { callStructured: vi.fn(async () => ({ ...base, cuisine: "italian", category: "casserole", dishKey: "x" })) };
    await expect(runCategorizer(draft, vocab, llm as any, config.paths.prompts)).rejects.toThrow(/unknown category/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/categorizer.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write src/agents/categorizer.ts**

```ts
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { CategorizationSchema, type Categorization, type DraftRecipe } from "../schemas/recipe.js";
import type { Vocab } from "../vocab/load.js";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildCategorizerUser(draft: DraftRecipe, vocab: Vocab): string {
  return [
    `Recipe: ${draft.nameRu} / ${draft.nameEn}`,
    `Cuisines: ${vocab.cuisines.map((c) => c.id).join(", ")}`,
    `Categories: ${vocab.categories.map((c) => c.id).join(", ")}`,
    "",
    "Ingredients:",
    draft.ingredients.map((i) => `- ${i.rawName} ${i.quantity ?? ""} ${i.unit ?? ""}`.trim()).join("\n"),
    "",
    "Steps:",
    draft.steps.map((s) => `${s.order}. ${s.text}`).join("\n"),
  ].join("\n");
}

export async function runCategorizer(draft: DraftRecipe, vocab: Vocab, llm: LlmClient, promptsDir: string): Promise<Categorization> {
  const system = await loadPrompt("categorizer", promptsDir);
  const raw = await llm.callStructured({ agent: "categorizer", system, user: buildCategorizerUser(draft, vocab), schema: CategorizationSchema });
  const cuisine = vocab.cuisines.some((c) => c.id === raw.cuisine) ? raw.cuisine : "other";
  if (!vocab.categories.some((c) => c.id === raw.category)) throw new Error(`categorizer returned unknown category: ${raw.category}`);
  return { ...raw, cuisine, dishKey: slugify(raw.dishKey) };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/agents && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/categorizer.md src/agents/categorizer.ts test/agents/categorizer.test.ts
git commit -m "Add categorizer agent for cuisine, meal type and dish key"
```

---

### Task 11: Judge — candidate lookup, completeness, same-or-variant

**Files:**
- Create: `src/prompts/judge.md`, `src/agents/judge.ts`
- Test: `test/agents/judge.test.ts`

**Interfaces:**
- Consumes: `Recipe`, `JudgeDecisionSchema`, `LlmClient`, `loadPrompt`.
- Produces:
  - `JACCARD_THRESHOLD = 0.6`, `FLAG_PENALTY = 0.1`, `STEP_BONUS_PER_STEP = 0.005` (max 0.05), `TEXT_BONUS_PER_1000_CHARS = 0.01` (max 0.05).
  - `jaccard(a: string[], b: string[]): number`
  - `findCandidates(recipe: Pick<Recipe,"dishKey"|"ingredients">, catalog: Recipe[]): Recipe[]`
  - `completeness(input: { ingredients: DraftIngredient[]; flags: RecipeFlag[]; steps: unknown[]; rawTextLength: number }): number` clamped to `[0,1]`
  - `runJudge(existing: Recipe, incoming: Recipe, llm, promptsDir): Promise<JudgeDecision>`
  - `decide(existing: Recipe, incoming: Recipe, decision: JudgeDecision): { action: "replace"|"keep-existing"|"keep-both"; incoming: Recipe; existing: Recipe }` (pure; applies renames for variants; tie on completeness keeps existing).

- [ ] **Step 1: Write src/prompts/judge.md**

```markdown
You are the JUDGE agent. Two recipes from the same channel appear to be the same dish. Decide whether they are the SAME recipe (the chef cooked the same thing again, possibly with small differences in amounts or wording) or genuine VARIANTS (a meaningful difference in main ingredients or method that a cook would call a different dish: vegetable lasagna vs bolognese lasagna, borscht with beans vs borscht with pork ribs).

- Small differences in quantity, optional garnish, or step wording → `same`.
- A different protein, a different base sauce, a different cooking method (baked vs fried), or a defining added ingredient → `variant`.

If `variant`, propose distinguishing Russian names for both, following the rule "base dish + single defining variation, no adjectives": `newNameRu` and `existingNameRu`. If `same`, leave both null.

Return only the structured decision with a one-sentence reason.
```

- [ ] **Step 2: Write the failing test**

```ts
// test/agents/judge.test.ts
import { describe, it, expect, vi } from "vitest";
import { jaccard, findCandidates, completeness, decide, runJudge } from "../../src/agents/judge.js";
import type { Recipe } from "../../src/schemas/recipe.js";
import { config } from "../../src/config.js";

function recipe(over: Partial<Recipe> & { ingredientIds?: string[] }): Recipe {
  const { ingredientIds = [], ...rest } = over;
  return {
    id: "x", nameRu: "X", nameEn: "X", dishKey: "x", cuisine: "other", mealTypes: ["dinner"], category: "stew", richness: "medium",
    servings: null, activeMinutes: null, totalMinutes: null, flags: [], completeness: 0.5, extractedAt: "", models: {},
    ingredients: ingredientIds.map((id) => ({ ingredient: id, rawName: id, quantity: 1, unit: "pc", provenance: "stated" as const, note: null })),
    steps: [],
    source: { videoId: "v", url: "", videoTitle: "", channel: "", channelId: "", segmentStart: 0, segmentEnd: 0, language: "ru" },
    ...rest,
  };
}

describe("jaccard", () => {
  it("computes overlap", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("findCandidates", () => {
  it("matches by dishKey or ingredient overlap >= 0.6", () => {
    const catalog = [
      recipe({ id: "1", dishKey: "borscht", ingredientIds: ["beet", "cabbage"] }),
      recipe({ id: "2", dishKey: "plov", ingredientIds: ["rice", "lamb", "carrot", "onion"] }),
      recipe({ id: "3", dishKey: "salad", ingredientIds: ["cucumber"] }),
    ];
    const incoming = recipe({ dishKey: "borscht-beans", ingredientIds: ["rice", "lamb", "carrot", "onion", "garlic"] });
    expect(findCandidates(incoming, catalog).map((r) => r.id)).toEqual(["2"]);
    expect(findCandidates(recipe({ dishKey: "borscht" }), catalog).map((r) => r.id)).toEqual(["1"]);
  });
});

describe("completeness", () => {
  it("is the share of quantified ingredients minus flags plus small bonuses, clamped", () => {
    const ing = (p: "stated" | "inferred" | "unknown") => ({ ingredient: null, rawName: "r", quantity: null, unit: null, provenance: p, note: null });
    expect(completeness({ ingredients: [ing("stated"), ing("unknown")], flags: [], steps: [], rawTextLength: 0 })).toBeCloseTo(0.5);
    expect(completeness({ ingredients: [ing("stated")], flags: [{ kind: "step", ref: "1", reason: "" }], steps: [], rawTextLength: 0 })).toBeCloseTo(0.9);
    expect(completeness({ ingredients: [ing("stated")], flags: [], steps: new Array(20), rawTextLength: 10000 })).toBeCloseTo(1);
    expect(completeness({ ingredients: [], flags: [], steps: [], rawTextLength: 0 })).toBe(0);
  });
});

describe("decide", () => {
  it("replaces when same and incoming is more complete; keeps existing on tie", () => {
    const existing = recipe({ id: "old", completeness: 0.5 });
    expect(decide(existing, recipe({ id: "new", completeness: 0.7 }), { relation: "same", reason: "", newNameRu: null, existingNameRu: null }).action).toBe("replace");
    expect(decide(existing, recipe({ id: "new", completeness: 0.5 }), { relation: "same", reason: "", newNameRu: null, existingNameRu: null }).action).toBe("keep-existing");
  });
  it("keeps both and renames on variant", () => {
    const r = decide(recipe({ id: "old" }), recipe({ id: "new" }), { relation: "variant", reason: "", newNameRu: "Лазанья овощная", existingNameRu: "Лазанья с соусом болоньезе" });
    expect(r.action).toBe("keep-both");
    expect(r.incoming.nameRu).toBe("Лазанья овощная");
    expect(r.existing.nameRu).toBe("Лазанья с соусом болоньезе");
  });
});

describe("runJudge", () => {
  it("calls the judge agent with both recipes", async () => {
    const llm = { callStructured: vi.fn(async () => ({ relation: "same", reason: "r", newNameRu: null, existingNameRu: null })) };
    const d = await runJudge(recipe({ nameRu: "Старый" }), recipe({ nameRu: "Новый" }), llm as any, config.paths.prompts);
    expect(d.relation).toBe("same");
    expect(llm.callStructured.mock.calls[0][0].user).toContain("Старый");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/agents/judge.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write src/agents/judge.ts**

```ts
import type { LlmClient } from "../llm/client.js";
import { loadPrompt } from "../prompts/load.js";
import { JudgeDecisionSchema, type JudgeDecision } from "../schemas/judge.js";
import type { DraftIngredient, Recipe, RecipeFlag } from "../schemas/recipe.js";

export const JACCARD_THRESHOLD = 0.6;
export const FLAG_PENALTY = 0.1;
export const STEP_BONUS_PER_STEP = 0.005;
export const STEP_BONUS_MAX = 0.05;
export const TEXT_BONUS_PER_1000_CHARS = 0.01;
export const TEXT_BONUS_MAX = 0.05;

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function ids(ingredients: DraftIngredient[]): string[] {
  return ingredients.map((i) => i.ingredient).filter((x): x is string => x !== null);
}

export function findCandidates(recipe: Pick<Recipe, "dishKey" | "ingredients">, catalog: Recipe[]): Recipe[] {
  const mine = ids(recipe.ingredients);
  return catalog.filter((r) => r.dishKey === recipe.dishKey || jaccard(mine, ids(r.ingredients)) >= JACCARD_THRESHOLD);
}

export function completeness(input: { ingredients: DraftIngredient[]; flags: RecipeFlag[]; steps: unknown[]; rawTextLength: number }): number {
  if (input.ingredients.length === 0) return 0;
  const quantified = input.ingredients.filter((i) => i.provenance !== "unknown").length / input.ingredients.length;
  const penalty = input.flags.length * FLAG_PENALTY;
  const stepBonus = Math.min(STEP_BONUS_MAX, input.steps.length * STEP_BONUS_PER_STEP);
  const textBonus = Math.min(TEXT_BONUS_MAX, (input.rawTextLength / 1000) * TEXT_BONUS_PER_1000_CHARS);
  return Math.max(0, Math.min(1, quantified - penalty + stepBonus + textBonus));
}

function describe(r: Recipe): string {
  return [
    `Name: ${r.nameRu} / ${r.nameEn}`,
    `Ingredients: ${r.ingredients.map((i) => `${i.rawName} ${i.quantity ?? "?"} ${i.unit ?? ""}`.trim()).join("; ")}`,
    `Steps: ${r.steps.map((s) => s.text).join(" ")}`,
  ].join("\n");
}

export async function runJudge(existing: Recipe, incoming: Recipe, llm: LlmClient, promptsDir: string): Promise<JudgeDecision> {
  const system = await loadPrompt("judge", promptsDir);
  const user = ["EXISTING recipe:", describe(existing), "", "NEW recipe:", describe(incoming)].join("\n");
  return llm.callStructured({ agent: "judge", system, user, schema: JudgeDecisionSchema });
}

export type JudgeAction = "replace" | "keep-existing" | "keep-both";

export function decide(existing: Recipe, incoming: Recipe, decision: JudgeDecision): { action: JudgeAction; incoming: Recipe; existing: Recipe } {
  if (decision.relation === "variant") {
    return {
      action: "keep-both",
      incoming: decision.newNameRu ? { ...incoming, nameRu: decision.newNameRu } : incoming,
      existing: decision.existingNameRu ? { ...existing, nameRu: decision.existingNameRu } : existing,
    };
  }
  return { action: incoming.completeness > existing.completeness ? "replace" : "keep-existing", incoming, existing };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/agents && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/judge.md src/agents/judge.ts test/agents/judge.test.ts
git commit -m "Add judge: duplicate candidates, completeness score, same-or-variant"
```

---

### Task 12: Stage cache and catalog writer

**Files:**
- Create: `src/orchestrator/cache.ts`, `src/orchestrator/catalog.ts`
- Test: `test/orchestrator/cache.test.ts`, `test/orchestrator/catalog.test.ts`

**Interfaces:**
- Produces:
  - `class StageCache { constructor(root: string); get<T>(videoId, stage: string, schema: z.ZodType<T>): Promise<T|null>; set(videoId, stage, value): Promise<void>; has(videoId, stage): Promise<boolean>; dir(videoId): string }` — files at `<root>/<videoId>/<stage>.json`.
  - `class Catalog { constructor(root: string); load(): Promise<Recipe[]>; write(recipe: Recipe): Promise<void>; archive(recipe: Recipe): Promise<void>; rename(recipe: Recipe, nameRu: string): Promise<void> }` — recipes at `<root>/recipes/<id>.json`, archive at `<root>/archive/<id>--<timestamp>.json`, `index.json` rebuilt on every write with `{ id, nameRu, nameEn, dishKey, cuisine, mealTypes, category, completeness, videoId }[]`.

- [ ] **Step 1: Write the failing cache test**

```ts
// test/orchestrator/cache.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { StageCache } from "../../src/orchestrator/cache.js";

describe("StageCache", () => {
  it("round-trips a stage value and reports presence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-"));
    const c = new StageCache(root);
    expect(await c.has("v1", "scout")).toBe(false);
    expect(await c.get("v1", "scout", z.object({ a: z.number() }))).toBeNull();
    await c.set("v1", "scout", { a: 1 });
    expect(await c.has("v1", "scout")).toBe(true);
    expect(await c.get("v1", "scout", z.object({ a: z.number() }))).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Write the failing catalog test**

```ts
// test/orchestrator/catalog.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../../src/orchestrator/catalog.js";
import type { Recipe } from "../../src/schemas/recipe.js";

const base: Recipe = {
  id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht", dishKey: "borscht", cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", richness: "medium",
  servings: null, activeMinutes: null, totalMinutes: null, ingredients: [], steps: [], flags: [], completeness: 0.5,
  source: { videoId: "v1", url: "", videoTitle: "", channel: "", channelId: "", segmentStart: 0, segmentEnd: 0, language: "ru" },
  extractedAt: "2026-01-01T00:00:00.000Z", models: {},
};

describe("Catalog", () => {
  it("writes, indexes, renames and archives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-cat-"));
    const cat = new Catalog(root);
    expect(await cat.load()).toEqual([]);
    await cat.write(base);
    expect((await cat.load())[0].id).toBe("borscht--v1");
    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    expect(index).toEqual([{ id: "borscht--v1", nameRu: "Борщ", nameEn: "Borscht", dishKey: "borscht", cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", completeness: 0.5, videoId: "v1" }]);
    await cat.rename(base, "Борщ с фасолью");
    expect((await cat.load())[0].nameRu).toBe("Борщ с фасолью");
    await cat.archive(base);
    expect(await cat.load()).toEqual([]);
    expect((await readdir(path.join(root, "archive")))[0]).toMatch(/^borscht--v1--/);
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `npx vitest run test/orchestrator`
Expected: FAIL.

- [ ] **Step 4: Write cache.ts and catalog.ts**

```ts
// src/orchestrator/cache.ts
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export class StageCache {
  constructor(private root: string) {}

  dir(videoId: string): string {
    return path.join(this.root, videoId);
  }

  private file(videoId: string, stage: string): string {
    return path.join(this.dir(videoId), `${stage}.json`);
  }

  async has(videoId: string, stage: string): Promise<boolean> {
    try { await access(this.file(videoId, stage)); return true; } catch { return false; }
  }

  async get<T>(videoId: string, stage: string, schema: z.ZodType<T>): Promise<T | null> {
    if (!(await this.has(videoId, stage))) return null;
    return schema.parse(JSON.parse(await readFile(this.file(videoId, stage), "utf8")));
  }

  async set(videoId: string, stage: string, value: unknown): Promise<void> {
    await mkdir(this.dir(videoId), { recursive: true });
    await writeFile(this.file(videoId, stage), JSON.stringify(value, null, 2));
  }
}
```

```ts
// src/orchestrator/catalog.ts
import { mkdir, readFile, writeFile, readdir, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { RecipeSchema, type Recipe } from "../schemas/recipe.js";

export class Catalog {
  constructor(private root: string) {}

  private recipesDir = () => path.join(this.root, "recipes");
  private archiveDir = () => path.join(this.root, "archive");
  private file = (id: string) => path.join(this.recipesDir(), `${id}.json`);

  async load(): Promise<Recipe[]> {
    await mkdir(this.recipesDir(), { recursive: true });
    const files = (await readdir(this.recipesDir())).filter((f) => f.endsWith(".json")).sort();
    return Promise.all(files.map(async (f) => RecipeSchema.parse(JSON.parse(await readFile(path.join(this.recipesDir(), f), "utf8")))));
  }

  async write(recipe: Recipe): Promise<void> {
    await mkdir(this.recipesDir(), { recursive: true });
    await writeFile(this.file(recipe.id), JSON.stringify(recipe, null, 2));
    await this.rebuildIndex();
  }

  async rename(recipe: Recipe, nameRu: string): Promise<void> {
    await this.write({ ...recipe, nameRu });
  }

  async archive(recipe: Recipe): Promise<void> {
    await mkdir(this.archiveDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsRename(this.file(recipe.id), path.join(this.archiveDir(), `${recipe.id}--${stamp}.json`));
    await this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<void> {
    const all = await this.load();
    const index = all.map((r) => ({
      id: r.id, nameRu: r.nameRu, nameEn: r.nameEn, dishKey: r.dishKey, cuisine: r.cuisine,
      mealTypes: r.mealTypes, category: r.category, completeness: r.completeness, videoId: r.source.videoId,
    }));
    await writeFile(path.join(this.root, "index.json"), JSON.stringify(index, null, 2));
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/orchestrator && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/cache.ts src/orchestrator/catalog.ts test/orchestrator
git commit -m "Add per-video stage cache and catalog writer with index and archive"
```

---

### Task 13: Assemble, report, and the ingest pipeline

**Files:**
- Create: `src/orchestrator/assemble.ts`, `src/orchestrator/report.ts`, `src/orchestrator/run.ts`
- Test: `test/orchestrator/assemble.test.ts`, `test/orchestrator/run.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `assembleRecipe(input: { source: VideoSource; segment: ScoutSegment; draft: DraftRecipe; verification: Verification; categorization: Categorization; models: Record<string,string>; now?: Date }): Recipe` — `id = ${dishKey}--${videoId}`; when a video has two segments with the same dishKey, the orchestrator appends `-2`, `-3` to the id.
  - `RunReport { startedAt: string; videos: { videoId; title; status: "done"|"skipped-no-captions"|"not-recipe"|"cached"|"error"; recipes: number; error?: string }[]; written: string[]; archived: string[]; keptExisting: string[]; unmapped: Record<string, number>; flags: { recipeId; kind; ref; reason }[]; usage: string }` and `renderReport(r: RunReport): string` (markdown).
  - `ingest(url: string, deps: { config; llm; vocab; cache: StageCache; catalog: Catalog; fetch?: typeof fetchVideo; expand?: typeof expandUrl }, opts: { force?: boolean }): Promise<RunReport>`.
- Pipeline per video (all through the cache; a stage is skipped if cached and `!force`):
  1. `source` ← `fetchVideo(videoId, cache.dir(videoId)+"/yt")`; on `skipped` record status and continue.
  2. `scout` ← `runScout`; if `!isRecipeVideo` record `not-recipe`.
  3. For each segment `i`: `extract-i`, `verify-i`, `categorize-i` (extractor and verifier depend on each other in order; segments run in parallel with `pLimit(config.concurrency)`).
  4. Assemble, `validateRecipe` against vocab (errors → throw, recorded as video `error`), compute `completeness` (flags from `flagsFromVerification`, `rawTextLength = segment.rawText.length`).
  5. Judge: `findCandidates` against `catalog.load()`; for the first candidate run `runJudge` + `decide`; apply: `replace` → archive existing, write incoming; `keep-existing` → record; `keep-both` → rename existing if changed, write incoming. No candidate → write.
  6. Collect unmapped names and flags into the report.
- Errors in one video never stop the run: catch, record `error` with message, continue.

- [ ] **Step 1: Write the failing assemble test**

```ts
// test/orchestrator/assemble.test.ts
import { describe, it, expect } from "vitest";
import { assembleRecipe } from "../../src/orchestrator/assemble.js";

describe("assembleRecipe", () => {
  it("builds id from dishKey and videoId, attaches flags and completeness", () => {
    const r = assembleRecipe({
      source: { videoId: "v1", url: "u", title: "T", tags: [], channel: "C", channelId: "UC", durationSec: 100, uploadDate: null, language: "ru", cues: [] },
      segment: { workingName: "борщ", start: 10, end: 90, rawText: "x".repeat(2000), cleanText: "" },
      draft: {
        nameRu: "Борщ", nameEn: "Borscht", servings: null, unmappedIngredients: [],
        ingredients: [{ ingredient: "beet", rawName: "свёкла", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
        steps: [{ order: 1, text: "Сварить.", timestamp: 20 }],
      },
      verification: { ingredients: [{ rawName: "свёкла", quote: null, supported: false }], steps: [], confidence: 0.5 },
      categorization: { cuisine: "ukrainian", mealTypes: ["lunch"], category: "soup", activeMinutes: 30, totalMinutes: 90, richness: "medium", dishKey: "borscht" },
      models: { scout: "claude-sonnet-5" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(r.id).toBe("borscht--v1");
    expect(r.flags).toHaveLength(1);
    expect(r.completeness).toBeCloseTo(1 - 0.1 + 0.005 + 0.02);
    expect(r.source).toMatchObject({ videoId: "v1", videoTitle: "T", segmentStart: 10, segmentEnd: 90 });
    expect(r.extractedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Write the failing run test with fakes**

```ts
// test/orchestrator/run.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingest } from "../../src/orchestrator/run.js";
import { StageCache } from "../../src/orchestrator/cache.js";
import { Catalog } from "../../src/orchestrator/catalog.js";
import { buildConfig } from "../../src/config.js";
import { loadVocab } from "../../src/vocab/load.js";
import type { VideoSource } from "../../src/schemas/source.js";

const source: VideoSource = {
  videoId: "v1", url: "u", title: "Лазанья", tags: [], channel: "C", channelId: "UC", durationSec: 300, uploadDate: null, language: "ru",
  cues: [{ start: 0, end: 5, text: "лазанья" }, { start: 100, end: 105, text: "нарежем лук" }],
};

function fakeLlm() {
  return {
    callStructured: vi.fn(async ({ agent }: { agent: string }) => {
      switch (agent) {
        case "scout": return { isRecipeVideo: true, segments: [{ workingName: "лазанья", start: 0, end: 300, rawText: "", cleanText: "Нарежем лук." }] };
        case "extractor": return { nameRu: "Лазанья с соусом болоньезе", nameEn: "Lasagna with bolognese", servings: null, unmappedIngredients: ["хамон"],
          ingredients: [{ ingredient: "onion", rawName: "лук", quantity: 1, unit: "pc", provenance: "inferred", note: null }],
          steps: [{ order: 1, text: "Нарезать лук.", timestamp: 100 }] };
        case "verifier": return { ingredients: [{ rawName: "лук", quote: "нарежем лук", supported: true }], steps: [{ order: 1, quote: "нарежем лук", supported: true }], confidence: 0.9 };
        case "categorizer": return { cuisine: "italian", mealTypes: ["dinner"], category: "pasta", activeMinutes: 40, totalMinutes: 90, richness: "hearty", dishKey: "lasagna-bolognese" };
        case "judge": return { relation: "same", reason: "r", newNameRu: null, existingNameRu: null };
        default: throw new Error(agent);
      }
    }),
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kambuz-run-"));
  const config = buildConfig({});
  return {
    config,
    llm: fakeLlm(),
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(path.join(root, "cache")),
    catalog: new Catalog(path.join(root, "catalog")),
    fetch: vi.fn(async () => source),
    expand: vi.fn(async () => ["v1"]),
  };
}

describe("ingest", () => {
  it("runs every stage once, writes the recipe and reports unmapped names", async () => {
    const deps = await setup();
    const report = await ingest("https://youtu.be/v1", deps, {});
    expect(report.videos[0].status).toBe("done");
    expect(report.written).toEqual(["lasagna-bolognese--v1"]);
    expect(report.unmapped).toEqual({ "хамон": 1 });
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer"]);
    expect((await deps.catalog.load())[0].nameRu).toBe("Лазанья с соусом болоньезе");
  });

  it("uses the cache on a second run and calls the judge for the duplicate", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v1", deps, {});
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["judge"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
    expect(await deps.catalog.load()).toHaveLength(1);
  });

  it("records a skipped video when there are no captions", async () => {
    const deps = await setup();
    deps.fetch = vi.fn(async () => ({ videoId: "v1", skipped: "no-captions" as const }));
    const report = await ingest("https://youtu.be/v1", deps, {});
    expect(report.videos[0].status).toBe("skipped-no-captions");
    expect(deps.llm.callStructured).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `npx vitest run test/orchestrator`
Expected: FAIL for assemble and run.

- [ ] **Step 4: Write assemble.ts**

```ts
// src/orchestrator/assemble.ts
import type { VideoSource } from "../schemas/source.js";
import type { ScoutSegment } from "../schemas/scout.js";
import type { Categorization, DraftRecipe, Recipe, Verification } from "../schemas/recipe.js";
import { flagsFromVerification } from "../agents/verifier.js";
import { completeness } from "../agents/judge.js";

export function assembleRecipe(input: {
  source: VideoSource; segment: ScoutSegment; draft: DraftRecipe; verification: Verification;
  categorization: Categorization; models: Record<string, string>; now?: Date; idSuffix?: string;
}): Recipe {
  const { source, segment, draft, verification, categorization: c } = input;
  const flags = flagsFromVerification(draft, verification);
  return {
    id: `${c.dishKey}--${source.videoId}${input.idSuffix ?? ""}`,
    nameRu: draft.nameRu,
    nameEn: draft.nameEn,
    dishKey: c.dishKey,
    cuisine: c.cuisine,
    mealTypes: c.mealTypes,
    category: c.category,
    richness: c.richness,
    servings: draft.servings,
    activeMinutes: c.activeMinutes,
    totalMinutes: c.totalMinutes,
    ingredients: draft.ingredients,
    steps: draft.steps,
    flags,
    completeness: completeness({ ingredients: draft.ingredients, flags, steps: draft.steps, rawTextLength: segment.rawText.length }),
    source: {
      videoId: source.videoId, url: source.url, videoTitle: source.title, channel: source.channel, channelId: source.channelId,
      segmentStart: segment.start, segmentEnd: segment.end, language: "ru",
    },
    extractedAt: (input.now ?? new Date()).toISOString(),
    models: input.models,
  };
}
```

- [ ] **Step 5: Write report.ts**

```ts
// src/orchestrator/report.ts
export type VideoStatus = "done" | "skipped-no-captions" | "not-recipe" | "error";

export interface RunReport {
  startedAt: string;
  url: string;
  videos: { videoId: string; title: string; status: VideoStatus; recipes: number; error?: string }[];
  written: string[];
  archived: string[];
  keptExisting: string[];
  unmapped: Record<string, number>;
  flags: { recipeId: string; kind: string; ref: string; reason: string }[];
  usage: string;
}

export function emptyReport(url: string): RunReport {
  return { startedAt: new Date().toISOString(), url, videos: [], written: [], archived: [], keptExisting: [], unmapped: {}, flags: [], usage: "" };
}

export function renderReport(r: RunReport): string {
  const counts = r.videos.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.status]: (acc[v.status] ?? 0) + 1 }), {});
  const lines = [
    `# Kambuz run ${r.startedAt}`,
    "",
    `Source: ${r.url}`,
    "",
    "## Videos",
    "",
    ...Object.entries(counts).map(([s, n]) => `- ${s}: ${n}`),
    "",
    "| video | title | status | recipes |",
    "|---|---|---|---|",
    ...r.videos.map((v) => `| ${v.videoId} | ${v.title.replace(/\|/g, "/")} | ${v.status}${v.error ? ` (${v.error})` : ""} | ${v.recipes} |`),
    "",
    "## Catalog changes",
    "",
    `- written: ${r.written.length}`, ...r.written.map((id) => `  - ${id}`),
    `- archived (replaced by a more complete version): ${r.archived.length}`, ...r.archived.map((id) => `  - ${id}`),
    `- kept existing (duplicate not better): ${r.keptExisting.length}`, ...r.keptExisting.map((id) => `  - ${id}`),
    "",
    "## Unmapped ingredients (add to vocab/ingredients.json, then rerun with --force --only-stage extract)",
    "",
    ...Object.entries(r.unmapped).sort((a, b) => b[1] - a[1]).map(([name, n]) => `- ${name} (${n})`),
    "",
    "## Verifier flags",
    "",
    ...r.flags.map((f) => `- ${f.recipeId}: ${f.kind} "${f.ref}" — ${f.reason}`),
    "",
    "## Token usage",
    "",
    "```",
    r.usage,
    "```",
  ];
  return lines.join("\n");
}
```

- [ ] **Step 6: Write run.ts**

```ts
// src/orchestrator/run.ts
import pLimit from "p-limit";
import type { Config } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { Vocab } from "../vocab/load.js";
import { validateRecipe } from "../vocab/validate.js";
import { StageCache } from "./cache.js";
import { Catalog } from "./catalog.js";
import { assembleRecipe } from "./assemble.js";
import { emptyReport, type RunReport } from "./report.js";
import { fetchVideo as realFetch, expandUrl as realExpand, type FetchResult } from "../fetcher/ytdlp.js";
import { VideoSourceSchema, type VideoSource } from "../schemas/source.js";
import { ScoutResultSchema } from "../schemas/scout.js";
import { CategorizationSchema, DraftRecipeSchema, VerificationSchema, type Recipe } from "../schemas/recipe.js";
import { runScout } from "../agents/scout.js";
import { runExtractor } from "../agents/extractor.js";
import { runVerifier } from "../agents/verifier.js";
import { runCategorizer } from "../agents/categorizer.js";
import { findCandidates, runJudge, decide } from "../agents/judge.js";
import path from "node:path";
import { z } from "zod";

export interface IngestDeps {
  config: Config;
  llm: LlmClient;
  vocab: Vocab;
  cache: StageCache;
  catalog: Catalog;
  fetch?: (videoId: string, workDir: string) => Promise<FetchResult>;
  expand?: (url: string) => Promise<string[]>;
  usageText?: () => string;
}

export interface IngestOptions {
  force?: boolean;
  onlyStage?: "scout" | "extract" | "verify" | "categorize";
}

const SkippedSchema = z.object({ videoId: z.string(), skipped: z.literal("no-captions") });

export async function ingest(url: string, deps: IngestDeps, opts: IngestOptions): Promise<RunReport> {
  const { config, llm, vocab, cache, catalog } = deps;
  const fetch = deps.fetch ?? realFetch;
  const expand = deps.expand ?? realExpand;
  const report = emptyReport(url);
  const promptsDir = config.paths.prompts;
  const forced = (stage: IngestOptions["onlyStage"]) => opts.force && (!opts.onlyStage || opts.onlyStage === stage);

  async function stage<T>(videoId: string, key: string, schema: z.ZodType<T>, force: boolean | undefined, run: () => Promise<T>): Promise<T> {
    if (!force) {
      const hit = await cache.get(videoId, key, schema);
      if (hit) return hit;
    }
    const value = await run();
    await cache.set(videoId, key, value);
    return value;
  }

  const videoIds = await expand(url);
  for (const videoId of videoIds) {
    let title = videoId;
    try {
      const fetched = await stage(videoId, "source", z.union([VideoSourceSchema, SkippedSchema]), false, () => fetch(videoId, path.join(cache.dir(videoId), "yt")));
      if ("skipped" in fetched) {
        report.videos.push({ videoId, title, status: "skipped-no-captions", recipes: 0 });
        continue;
      }
      const source: VideoSource = fetched;
      title = source.title;

      const scout = await stage(videoId, "scout", ScoutResultSchema, forced("scout"), () => runScout(source, llm, promptsDir));
      if (!scout.isRecipeVideo) {
        report.videos.push({ videoId, title, status: "not-recipe", recipes: 0 });
        continue;
      }

      const limit = pLimit(config.concurrency);
      const recipes = await Promise.all(
        scout.segments.map((segment, i) =>
          limit(async () => {
            const draft = await stage(videoId, `extract-${i}`, DraftRecipeSchema, forced("extract"), () => runExtractor(segment, vocab, llm, promptsDir));
            const verification = await stage(videoId, `verify-${i}`, VerificationSchema, forced("verify") || forced("extract"), () => runVerifier(segment, draft, llm, promptsDir));
            const categorization = await stage(videoId, `categorize-${i}`, CategorizationSchema, forced("categorize") || forced("extract"), () => runCategorizer(draft, vocab, llm, promptsDir));
            for (const name of draft.unmappedIngredients) report.unmapped[name] = (report.unmapped[name] ?? 0) + 1;
            return assembleRecipe({ source, segment, draft, verification, categorization, models: config.models });
          }),
        ),
      );

      // de-duplicate ids within one video (same dishKey twice)
      const seen = new Map<string, number>();
      for (const r of recipes) {
        const n = (seen.get(r.id) ?? 0) + 1;
        seen.set(r.id, n);
        if (n > 1) r.id = `${r.id}-${n}`;
      }

      for (const recipe of recipes) {
        const errors = validateRecipe(recipe, vocab);
        if (errors.length) throw new Error(`invalid recipe ${recipe.id}: ${errors.join("; ")}`);
        for (const f of recipe.flags) report.flags.push({ recipeId: recipe.id, ...f });
        await placeInCatalog(recipe);
      }
      report.videos.push({ videoId, title, status: "done", recipes: recipes.length });
    } catch (e) {
      report.videos.push({ videoId, title, status: "error", recipes: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

  report.usage = deps.usageText?.() ?? "";
  return report;

  async function placeInCatalog(incoming: Recipe): Promise<void> {
    const existingAll = (await catalog.load()).filter((r) => r.id !== incoming.id);
    const candidates = findCandidates(incoming, existingAll);
    const self = (await catalog.load()).find((r) => r.id === incoming.id);
    if (candidates.length === 0) {
      if (self && self.completeness >= incoming.completeness) { report.keptExisting.push(self.id); return; }
      await catalog.write(incoming);
      report.written.push(incoming.id);
      return;
    }
    const existing = candidates[0];
    const decision = await runJudge(existing, incoming, llm, promptsDir);
    const result = decide(existing, incoming, decision);
    if (result.action === "replace") {
      await catalog.archive(existing);
      report.archived.push(existing.id);
      await catalog.write(result.incoming);
      report.written.push(result.incoming.id);
    } else if (result.action === "keep-existing") {
      report.keptExisting.push(existing.id);
    } else {
      if (result.existing.nameRu !== existing.nameRu) await catalog.rename(existing, result.existing.nameRu);
      await catalog.write(result.incoming);
      report.written.push(result.incoming.id);
    }
  }
}
```

Note on the second test ("uses the cache on a second run"): on the rerun the incoming recipe has the same id as the existing one. `placeInCatalog` excludes same-id from candidates, so with no other candidates and `self.completeness >= incoming.completeness` it records `keptExisting` without calling the judge. That contradicts the test's expected `["judge"]`. Resolve it in favor of the simpler behavior: **change the test** expectation to `expect(agents).toEqual([])` and keep `keptExisting` as `["lasagna-bolognese--v1"]`. The judge is exercised when a *different* video produces the same dishKey; add that case:

```ts
  it("calls the judge when another video yields the same dish and keeps the more complete one", async () => {
    const deps = await setup();
    await ingest("https://youtu.be/v1", deps, {});
    deps.expand = vi.fn(async () => ["v2"]);
    deps.fetch = vi.fn(async () => ({ ...source, videoId: "v2" }));
    deps.llm.callStructured.mockClear();
    const report = await ingest("https://youtu.be/v2", deps, {});
    const agents = deps.llm.callStructured.mock.calls.map((c) => c[0].agent);
    expect(agents).toEqual(["scout", "extractor", "verifier", "categorizer", "judge"]);
    expect(report.keptExisting).toEqual(["lasagna-bolognese--v1"]);
    expect(await deps.catalog.load()).toHaveLength(1);
  });
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, including the four `ingest` cases.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator test/orchestrator
git commit -m "Add ingest pipeline with stage cache, judge placement and run report"
```

---

### Task 14: CLI, README, first real run

**Files:**
- Create: `src/cli.ts`, `README.md`
- Modify: `.gitignore` (already has `.cache/`, `reports/`, `node_modules/`, `.env`)

**Interfaces:**
- Consumes: `ingest`, `renderReport`, `createLlmClient`, `UsageLedger`, `loadVocab`, `StageCache`, `Catalog`, `config`.
- Produces: `npm run kambuz -- ingest <url> [--force] [--only-stage scout|extract|verify|categorize]` which writes `reports/<timestamp>.md`, prints its path and the usage table.

- [ ] **Step 1: Write src/cli.ts**

```ts
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLlmClient } from "./llm/client.js";
import { UsageLedger } from "./llm/usage.js";
import { loadVocab } from "./vocab/load.js";
import { StageCache } from "./orchestrator/cache.js";
import { Catalog } from "./orchestrator/catalog.js";
import { ingest, type IngestOptions } from "./orchestrator/run.js";
import { renderReport } from "./orchestrator/report.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      "only-stage": { type: "string" },
    },
  });
  const [command, url] = positionals;
  if (command !== "ingest" || !url) {
    console.error("usage: kambuz ingest <video-or-playlist-url> [--force] [--only-stage scout|extract|verify|categorize]");
    process.exit(1);
  }
  const ledger = new UsageLedger();
  const deps = {
    config,
    llm: createLlmClient(config, ledger),
    vocab: await loadVocab(config.paths.vocab),
    cache: new StageCache(config.paths.cache),
    catalog: new Catalog(config.paths.catalog),
    usageText: () => ledger.toString(),
  };
  const opts: IngestOptions = { force: values.force, onlyStage: values["only-stage"] as IngestOptions["onlyStage"] };
  const report = await ingest(url, deps, opts);
  await mkdir(config.paths.reports, { recursive: true });
  const file = path.join(config.paths.reports, `${report.startedAt.replace(/[:.]/g, "-")}.md`);
  await writeFile(file, renderReport(report));
  console.log(renderReport(report));
  console.log(`\nreport: ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Write README.md**

```markdown
# Kambuz

Multi-agent pipeline that turns YouTube cooking videos into grounded, structured recipes.
Give it a video or playlist URL; it writes one JSON per dish into `catalog/recipes/`.

Agents: fetcher (yt-dlp) → scout (find dishes) → extractor (per dish) → verifier (ground in transcript) → categorizer → judge (duplicates).
Nothing is invented: every ingredient and step must be supported by what the chef said.

## Setup

    brew install yt-dlp        # or: pipx install yt-dlp
    npm install
    cp .env.example .env       # add ANTHROPIC_API_KEY

## Run

    npm run kambuz -- ingest "https://youtu.be/bskR7LVpF7I"
    npm run kambuz -- ingest "https://www.youtube.com/playlist?list=..."
    npm run kambuz -- ingest <url> --force --only-stage extract   # rerun extraction after editing vocab

Per-video stage results are cached in `.cache/<videoId>/`; a run report lands in `reports/`.

Models: every agent uses `claude-sonnet-5`. Override with `KAMBUZ_MODEL=<id>` or per agent, e.g. `KAMBUZ_MODEL_SCOUT=claude-opus-5`.

## Test

    npm test
    npm run typecheck

## Design

See `docs/specs/2026-09-15-kambuz-ingestion-pipeline-design.md`.
```

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 4: First real run on the lasagna video**

Run: `set -a && source .env && set +a && npm run kambuz -- ingest "https://youtu.be/bskR7LVpF7I"`
Expected: report shows one video `done` with 1 recipe, `catalog/recipes/lasagna-bolognese--bskR7LVpF7I.json` exists (dishKey may differ slightly; that's fine), usage table printed. Open the JSON and check: `nameRu` follows the naming rule, milk is `1.5 l` with provenance `stated`, onion is `inferred`, steps have increasing timestamps, and `unmappedIngredients` lists anything not yet in the vocab.

If the scout returns zero segments or the extractor mislabels things, this is prompt tuning, not a code bug: adjust the `.md` prompt and rerun with `--force --only-stage scout` (or `extract`). Commit prompt changes separately.

- [ ] **Step 5: Add unmapped ingredients from the report to `vocab/ingredients.json`, rerun with `--force --only-stage extract`, confirm the report's unmapped list shrinks.**

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md vocab/ingredients.json catalog
git commit -m "Add ingest CLI and first catalog entry from a real video"
```

---

### Task 15: Regression eval set

**Files:**
- Create: `src/eval/run.ts`, `eval/cases/bskR7LVpF7I.json`, and nine more cases you pick from the channel (at least: one "меню на день" multi-dish video, one vlog with zero dishes, one noisy-caption video).
- Modify: `src/cli.ts` (add `eval` command), `package.json` script `eval`.

**Interfaces:**
- Case file shape: `{ "videoId": string, "note": string, "expect": { "dishCount": number, "names": string[], "cuisines": string[], "mealTypes": string[][], "ingredients"?: { "dishIndex": number, "must": { "ingredient": string, "provenance": "stated"|"inferred"|"unknown", "quantity"?: number }[] } } }`.
- `runEval(deps, caseDir, opts: { force: boolean }): Promise<EvalRow[]>` where `EvalRow { videoId; check: string; expected: string; actual: string; pass: boolean }`; the CLI prints a markdown table and exits non-zero if any row fails.
- Eval reads the same stage cache, so without `--force` it's free after the first run.

- [ ] **Step 1: Write eval/cases/bskR7LVpF7I.json after inspecting the real output from Task 14**

```json
{
  "videoId": "bskR7LVpF7I",
  "note": "single recipe, clean audio, lasagna with bolognese and bechamel",
  "expect": {
    "dishCount": 1,
    "names": ["Лазанья с соусом болоньезе"],
    "cuisines": ["italian"],
    "mealTypes": [["dinner"]],
    "ingredients": {
      "dishIndex": 0,
      "must": [
        { "ingredient": "milk", "provenance": "stated", "quantity": 1.5 },
        { "ingredient": "onion", "provenance": "inferred" },
        { "ingredient": "nutmeg", "provenance": "unknown" }
      ]
    }
  }
}
```

Adjust `names` and the `must` list to what the chef actually says, verified by watching the relevant timestamps. The eval encodes ground truth, not the model's first answer.

- [ ] **Step 2: Write src/eval/run.ts**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { IngestDeps } from "../orchestrator/run.js";
import { ingest } from "../orchestrator/run.js";

const CaseSchema = z.object({
  videoId: z.string(),
  note: z.string(),
  expect: z.object({
    dishCount: z.number(),
    names: z.array(z.string()),
    cuisines: z.array(z.string()),
    mealTypes: z.array(z.array(z.string())),
    ingredients: z.object({
      dishIndex: z.number(),
      must: z.array(z.object({ ingredient: z.string(), provenance: z.enum(["stated", "inferred", "unknown"]), quantity: z.number().optional() })),
    }).optional(),
  }),
});

export interface EvalRow { videoId: string; check: string; expected: string; actual: string; pass: boolean }

export async function runEval(deps: IngestDeps, caseDir: string, opts: { force: boolean }): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const files = (await readdir(caseDir)).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const c = CaseSchema.parse(JSON.parse(await readFile(path.join(caseDir, f), "utf8")));
    await ingest(`https://www.youtube.com/watch?v=${c.videoId}`, deps, { force: opts.force });
    const recipes = (await deps.catalog.load())
      .filter((r) => r.source.videoId === c.videoId)
      .sort((a, b) => a.source.segmentStart - b.source.segmentStart);
    const row = (check: string, expected: unknown, actual: unknown) =>
      rows.push({ videoId: c.videoId, check, expected: JSON.stringify(expected), actual: JSON.stringify(actual), pass: JSON.stringify(expected) === JSON.stringify(actual) });
    row("dishCount", c.expect.dishCount, recipes.length);
    row("names", c.expect.names, recipes.map((r) => r.nameRu));
    row("cuisines", c.expect.cuisines, recipes.map((r) => r.cuisine));
    row("mealTypes", c.expect.mealTypes, recipes.map((r) => r.mealTypes));
    if (c.expect.ingredients) {
      const dish = recipes[c.expect.ingredients.dishIndex];
      for (const m of c.expect.ingredients.must) {
        const found = dish?.ingredients.find((i) => i.ingredient === m.ingredient);
        row(`ingredient:${m.ingredient}`, m, found ? { ingredient: found.ingredient, provenance: found.provenance, ...(m.quantity !== undefined ? { quantity: found.quantity } : {}) } : null);
      }
    }
  }
  return rows;
}

export function renderEval(rows: EvalRow[]): string {
  const lines = ["| video | check | expected | actual | ok |", "|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.videoId} | ${r.check} | ${r.expected} | ${r.actual} | ${r.pass ? "✓" : "✗"} |`);
  const failed = rows.filter((r) => !r.pass).length;
  lines.push("", `${rows.length - failed}/${rows.length} checks passed`);
  return lines.join("\n");
}
```

- [ ] **Step 3: Add the `eval` command to src/cli.ts**

Replace the `if (command !== "ingest" || !url)` block with a `switch (command)`: case `"ingest"` runs the existing code; case `"eval"` builds the same `deps`, calls `runEval(deps, config.paths.eval + "/cases", { force: values.force })`, prints `renderEval(rows)`, and `process.exit(rows.some(r => !r.pass) ? 1 : 0)`. Default prints usage for both commands. Add `"eval": "tsx src/cli.ts eval"` to `package.json` scripts.

- [ ] **Step 4: Run the eval**

Run: `set -a && source .env && set +a && npm run eval`
Expected: table printed, the lasagna case passes on cached stages. Fix any failing check by either correcting the case (if the chef really said something else) or tuning the prompt and rerunning with `--force`.

- [ ] **Step 5: Add the remaining nine cases**

Pick videos from the channel listing (`yt-dlp --flat-playlist --print "%(id)s %(title)s" "https://www.youtube.com/channel/UCi51Ivjt6EKC4OegheuJ4zQ/videos"`). For each: run `ingest`, watch the key moments, write the case with true values. Required coverage: one video with ≥4 dishes, one vlog expecting `dishCount: 0`, one with heavy caption noise.

- [ ] **Step 6: Commit**

```bash
git add src/eval src/cli.ts package.json eval catalog
git commit -m "Add regression eval set and eval command"
```

---

## Self-review notes

- **Spec coverage:** §4.1 fetcher → Task 5; §4.2 scout → Task 7 (rawText overwritten with verbatim slice, min-length filter); §4.3 extractor → Task 8; §4.4 verifier → Task 9; §4.5 categorizer → Task 10; §4.6 judge → Task 11 + placement in Task 13; §4.7 orchestrator (cache, resume, `--force`, `--only-stage`, concurrency, usage logging, report, catalog layout) → Tasks 6, 12, 13, 14; §5 naming rule → prompts in Tasks 8 and 10; §6 shapes → Task 2; §7 vocab → Task 3; §9 tests → each task plus Task 15.
- **Not in this plan (spec §11 deferred):** Batch API, Whisper, translation, thumbnails.
- **Known simplification:** SDK retries on 429/5xx are the SDK defaults (2); the spec's "one outer retry per stage" is implemented only for parse failures. Add a stage-level retry in `run.ts` if real runs show transient failures.
