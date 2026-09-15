# Kambuz — recipe ingestion pipeline design

**Date:** 2026-09-15
**Status:** approved in brainstorming, ready for implementation plan

## 1. Goal

A command-line multi-agent system that takes a YouTube video URL or playlist URL
and produces one clean, structured recipe file per dish found in the videos.

Every fact in a recipe must come from what the chef said on camera. The system
extracts and normalizes; it never invents a dish, a step, or a quantity the chef
neither said nor clearly implied.

The first source is the channel **Vishniakov kitchen** (a ship's cook,
Russian-language, ~390 videos, mixed recipes and vlogs). A single video can
contain 5–8 recipes ("меню на день" videos). Videos have no description and no
chapters; the only text is the title, tags, and auto-generated Russian captions.

The eventual "what to cook tonight" app is out of scope. The pipeline's output
is designed so that app can later filter recipes by cuisine and loved products.

## 2. Non-goals (first version)

- No web app, no database, no frontend. Output is files on disk.
- No partner/household preferences.
- No translation of steps into English (names get an English form, steps stay
  in the transcript language).
- No Whisper transcription. Videos without auto-captions are logged and skipped.
- No Batch API. Calls run live with a concurrency limit; batch is a later
  optimization.

## 3. Stack

- TypeScript (Node 22), run with `tsx`.
- `@anthropic-ai/sdk` with structured outputs (`output_config.format`) for every
  agent. Default model `claude-opus-5` for all agents; the model per agent is a
  config value so cheaper models can be tried per role.
- `yt-dlp` as a subprocess for video metadata, playlist expansion, and
  auto-caption download (VTT). No YouTube API key needed.
- Zod for schemas: one schema per agent output, shared with the SDK's
  structured-output helper.
- Vitest for tests.

## 4. Pipeline overview

```
URL ──▶ fetcher ──▶ scout ──▶ extractor (×N segments) ──▶ verifier ──▶ categorizer ──▶ judge ──▶ catalog/
         (code)     (LLM)        (LLM)                      (LLM)         (LLM)         (code+LLM)
```

The **orchestrator** is plain TypeScript. It runs stages per video, caches
every stage's output on disk, resumes after failures, and writes the final
report. Agents are pure functions: typed input in, typed output out, no I/O.

### 4.1 Fetcher (no LLM)

Input: a video URL or playlist URL.

- Expands a playlist to a list of video ids (`yt-dlp --flat-playlist`).
- Per video: id, url, title, tags, channel name, channel id, duration,
  upload date.
- Downloads Russian auto-captions as VTT, parses to
  `{ start: number, end: number, text: string }[]`, merges into cue-level
  segments with timestamps preserved.
- If no `ru` captions exist: writes a `no-captions` marker and skips the video.

Output: `VideoSource` (see §6).

### 4.2 Scout (LLM)

The segmentation agent. Input: title, tags, and the full timestamped transcript.

Output: a list of dishes found in the video. For each dish:

- `working_name` — the dish as the chef refers to it (not yet canonical).
- `start`, `end` — timestamp range where this dish is cooked.
- `raw_text` — the exact transcript slice for that range (copied, not
  rewritten).
- `clean_text` — the same slice with obvious speech-to-text errors fixed
  ("стебля сидений" → "стебля сельдерея"), filler removed, sentences split.

An empty list means "not a recipe video" (vlog, travel, sponsor update).

Rules:
- Dishes cooked in interleaved fashion (chef starts a soup, then a salad while
  the soup simmers) get overlapping ranges; that's allowed.
- Sauces and sides that are part of a main dish are not separate dishes
  (bolognese inside a lasagna is not a recipe on its own) unless the chef
  presents them as standalone.
- `clean_text` may fix words and punctuation. It must not add, remove, or
  reorder ingredients, quantities, or steps. The verifier checks the extractor
  against `raw_text`, so cleaning errors are caught downstream.

### 4.3 Extractor (LLM, one call per segment)

Input: one scout segment (`working_name`, `clean_text`, timestamps), plus the
ingredient vocabulary.

Output: one `DraftRecipe`:

- `name_ru` — canonical name by the naming rule in §5.
- `name_en` — English form of the same canonical name.
- `servings` — number or `null`.
- `ingredients[]` — each with:
  - `ingredient` — canonical id from the vocabulary, or `null` if unmappable.
  - `raw_name` — what the chef called it.
  - `quantity`, `unit` — number and unit, or `null`.
  - `provenance` — `stated` (chef said the amount), `inferred` (chef's phrasing
    implies it: "возьмём луковицу" → 1 onion, "пару зубчиков" → 2 cloves), or
    `unknown` (chef showed it but never said an amount).
  - `note` — optional preparation note ("diced", "room temperature").
- `steps[]` — ordered, each with `text` and `timestamp` (seconds into the
  video, the moment the chef starts that step).
- `unmapped_ingredients[]` — raw names it could not map to the vocabulary.
  These are reported, never invented into the vocabulary.

Rules:
- Never fill a quantity from general cooking knowledge. "A lasagna normally
  needs 500 g of mince" is forbidden; only what was said or implied.
- Steps are written in the transcript language as imperative sentences.
- Eight recipes in one output is where quality dies, hence one call per
  segment. The orchestrator assembles the array.

### 4.4 Verifier (LLM)

Input: the segment's `raw_text` and the `DraftRecipe`.

Output: `Verification`:

- For every ingredient with provenance `inferred` or `stated`: the supporting
  transcript quote, or a flag `unsupported`.
- For every step: the supporting quote, or a flag.
- `confidence` — overall 0–1.

Flagged items do not block the recipe; they go into the run's review report
and are kept on the recipe as `flags[]` so the judge can score them.

### 4.5 Categorizer (LLM)

Input: the verified recipe (ingredients + steps, no transcript).

Output: `Categorization`:

- `cuisine` — one id from the cuisine vocabulary.
- `meal_types[]` — one or more of `breakfast`, `lunch`, `dinner`.
- `category` — one id from the category vocabulary (soup, pasta, dumplings,
  bake, salad, …).
- `active_minutes`, `total_minutes` — estimates from the steps; `null` if the
  steps don't support an estimate.
- `richness` — `light` | `medium` | `hearty`.
- `dish_key` — normalized slug: base dish plus its defining variation,
  e.g. `lasagna-bolognese`, `borscht-beans`. Used for duplicate matching.

Kept separate from the extractor so it judges the whole dish, and so its prompt
can be tuned independently.

### 4.6 Judge (code + LLM)

Runs when a recipe is about to be written to the catalog.

1. **Candidate lookup (code):** existing catalog recipes with the same
   `dish_key`, or with canonical-ingredient Jaccard overlap ≥ 0.6.
2. **Completeness score (code):**
   - share of ingredients with provenance `stated` or `inferred`
   - minus a penalty per verifier flag
   - plus a small bonus for step count and `raw_text` length
   The exact weights are constants in one file, covered by unit tests.
3. **Same-or-variant decision (LLM), only when a candidate exists:** given
   old and new, answer `same` or `variant` with a one-sentence reason.
   - `same` → the higher completeness score wins; the loser moves to
     `catalog/archive/` (never deleted). Ties keep the existing one.
   - `variant` → both stay; the LLM proposes the distinguishing variation for
     each name (e.g. "Лазанья с соусом болоньезе" / "Лазанья овощная").

### 4.7 Orchestrator (code)

- CLI: `kambuz ingest <url> [--force] [--only-stage <stage>] [--model <id>]`.
- Per-video cache directory `.cache/<videoId>/` with one JSON per stage
  (`source.json`, `scout.json`, `extract-<n>.json`, `verify-<n>.json`,
  `categorize-<n>.json`). A stage runs only if its file is missing or
  `--force` is set.
- Concurrency limit for LLM calls (default 4). Retries with backoff on 429/5xx
  via the SDK's built-in retries plus one outer retry per stage.
- Every LLM call logs `usage` so a run prints its total token cost.
- Writes `catalog/recipes/<dish_key>--<videoId>.json` and appends to
  `catalog/index.json`.
- Writes `reports/<timestamp>.md`: videos processed and skipped, recipes
  written, archived, unmapped ingredients (grouped, with counts), verifier
  flags, token cost.

## 5. Naming rule

The video title is stored as `video_title` but never used as the recipe name.

`name_ru` = base dish + the single variation that defines it. Nothing else.

- "Лазанья с соусом болоньезе", not "Самая вкусная сырная лазанья".
- "Борщ с фасолью", not "Борщ как у бабушки".
- No adjectives ("вкусный", "простой"), no chef or channel name, no "судовой".
- If the chef's version has no defining variation, the base dish alone:
  "Оливье".

`dish_key` is the slug form of the same idea in English: `lasagna-bolognese`,
`borscht-beans`, `olivier`.

The rule lives in the categorizer and extractor prompts with ten worked
examples. Drift is caught by the regression set.

## 6. Data shapes

All schemas are Zod, in `src/schemas/`. Summary of the final recipe file:

```ts
Recipe {
  id: string                 // `${dish_key}--${videoId}`
  name_ru: string
  name_en: string
  dish_key: string
  cuisine: CuisineId
  meal_types: ("breakfast"|"lunch"|"dinner")[]
  category: CategoryId
  richness: "light"|"medium"|"hearty"
  servings: number|null
  active_minutes: number|null
  total_minutes: number|null
  ingredients: {
    ingredient: IngredientId|null
    raw_name: string
    quantity: number|null
    unit: string|null
    provenance: "stated"|"inferred"|"unknown"
    note?: string
  }[]
  steps: { order: number; text: string; timestamp: number }[]
  flags: { kind: "ingredient"|"step"; ref: string; reason: string }[]
  completeness: number       // 0–1, judge score
  source: {
    video_id: string; url: string; video_title: string
    channel: string; channel_id: string
    segment_start: number; segment_end: number
    language: "ru"
  }
  extracted_at: string       // ISO date
  models: Record<string, string>  // stage → model id used
}
```

Intermediate shapes (`VideoSource`, `ScoutResult`, `DraftRecipe`,
`Verification`, `Categorization`, `JudgeDecision`) follow §4.

## 7. Vocabularies

Plain JSON files in `vocab/`, edited only by hand:

- `cuisines.json` — id, name_ru, name_en. Initial list: ukrainian, russian,
  georgian, italian, french, spanish, turkish, asian (split later), other.
- `categories.json` — soup, salad, pasta, dumplings, bake, stew, grill,
  breakfast-dish, dessert, bread, sauce, side.
- `ingredients.json` — id, name_ru, name_en, aliases[] (both languages,
  including common speech-to-text garbles once observed).

A validator (`src/vocab/validate.ts`) rejects any recipe referencing an id not
in these files. Unmapped raw names from the extractor are collected into the
run report so you can add ids or aliases, then rerun with `--only-stage
extract` for the affected videos.

The ingredient list starts with ~150 common entries and grows from reports.

## 8. Cost

Rough one-time cost for the whole channel at Opus 5 pricing ($5 in / $25 out
per 1M tokens): ~390 videos, ~half recipes, ~5k transcript tokens each, five
LLM stages, roughly $30–40. Individual videos cost cents. `usage` is logged
on every call, and the report prints the total.

## 9. Testing

**Unit (no LLM):**
- VTT parsing and segment slicing by timestamp range.
- Vocabulary validator.
- Judge candidate lookup and completeness score with fixed weights.
- Orchestrator cache/resume: a stage whose file exists is not re-run;
  `--force` re-runs it.
- Prompt builders produce the expected structure for a fixture segment.

**Regression set (LLM, run on demand):**
- Ten hand-checked videos from the channel under `eval/`: at least one
  multi-dish "меню на день" video, one single-recipe video (the lasagna
  `bskR7LVpF7I`), one vlog that must yield zero dishes, one with heavy
  speech-to-text noise.
- Expected values per video: number of dishes (scout), canonical names, the
  ingredient list with provenance for one dish, and cuisine/meal type.
- `kambuz eval` runs the set and prints a diff table. Run it whenever a prompt
  changes.

## 10. Repository layout

```
kambuz/
  src/
    cli.ts
    orchestrator/      run.ts, cache.ts, report.ts
    fetcher/           ytdlp.ts, vtt.ts
    agents/            scout.ts, extractor.ts, verifier.ts, categorizer.ts, judge.ts
    prompts/           one .md per agent, loaded at runtime
    schemas/           zod schemas per stage
    vocab/             load.ts, validate.ts
    llm/               client.ts (SDK wrapper: model per agent, usage logging, structured output)
  vocab/               cuisines.json, categories.json, ingredients.json
  eval/                regression videos + expected values
  catalog/             recipes/, archive/, index.json   (git-tracked output)
  reports/             run reports (git-ignored)
  .cache/              per-video stage cache (git-ignored)
  docs/superpowers/    specs and plans
```

## 11. Open questions deferred to later versions

- Batch API for full-channel runs.
- Whisper fallback for videos without captions.
- Second channel / multi-language transcripts.
- Translating steps to English.
- Photo/thumbnail per recipe (frame at the step timestamp).
