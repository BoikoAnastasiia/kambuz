# Kambuz

Multi-agent pipeline that turns YouTube cooking videos into grounded, structured recipes.
Give it a video or playlist URL; it writes one JSON per dish into `catalog/recipes/`.

Kambuz (камбуз) is the galley on a ship. The first source channel is a ship's cook
who films his recipes in Russian, without descriptions or chapters, so the only
input is the auto-generated captions. One video often holds five to eight dishes.

## How it works

Six stages run per video. Every LLM stage is a pure function with a typed
(Zod) structured output, and the orchestrator in plain TypeScript does all the I/O.

| Stage | What it does | LLM |
|---|---|---|
| fetcher | `yt-dlp` pulls metadata and Russian auto-captions, parsed into timestamped cues | no |
| scout | splits the transcript into one segment per dish actually cooked; says when a video is not a recipe at all | yes |
| extractor | one call per segment: name, ingredients with quantities, ordered steps | yes |
| verifier | checks every ingredient and step against the raw transcript and quotes the evidence | yes |
| categorizer | cuisine, meal type, course, cooking method, timing, and a `dishKey` slug used for duplicate detection | yes |
| judge | finds candidate duplicates in the catalog, scores completeness, decides same dish or variant | yes |

Nothing is invented. Every ingredient and step must be supported by what the
chef said. Quantities carry a provenance tag: `stated` (he said "1.5 litres"),
`inferred` (he said "take an onion", so one onion), or `unknown`. Ingredients
that are not in the controlled vocabulary in `vocab/` are reported as unmapped,
never made up; the vocabulary files are edited by hand only.

Per-video stage results are cached in `.cache/<videoId>/`, so a run resumes
where it stopped and a single stage can be re-run after a prompt or vocabulary
change. Every LLM call logs token usage, and the run report prints the total.
Re-processing a segment (same video and segment start) always replaces its
previous catalog entry outright, even with a lower score — the judge and
completeness comparison only run across different segments.

## Setup

    brew install yt-dlp        # or: pipx install yt-dlp
    npm install
    cp .env.example .env       # add ANTHROPIC_API_KEY

Node 22 or newer.

## Run

    npm run kambuz -- ingest "https://youtu.be/bskR7LVpF7I"
    npm run kambuz -- ingest "https://www.youtube.com/playlist?list=..."
    npm run kambuz -- ingest <url> --only-stage extract   # rerun extraction after editing vocab
    npm run eval                                         # score the catalog against eval/cases

`--only-stage <stage>` re-runs that stage and every stage downstream of it
(`scout` < `extract` < `verify` < `categorize`); `--force` alone re-runs
every agent stage. Neither flag re-fetches captions — the `yt-dlp` source
stage is only re-run when its cache entry is missing.

While it runs, `ingest` draws a live tree with one line per video (spinner
while it's in progress) and, under it, one line per stage — a segment's
working name in brackets where more than one is running at once, "cached"
for a stage served from `.cache/`, or elapsed time and a token count once
it's done. A video's stage breakdown and its `N recipes · Xs · Yk tokens`
summary stay on screen after it finishes rather than disappearing, and
errors are shown in red. If two calls for the same agent overlap closely
enough that a token count can't be attributed with confidence, that stage
shows `— tok` instead of guessing. Pass `--quiet` to skip the tree and just
print the final report.

Each run writes a report to `reports/<timestamp>.md` and prints its path
and the token-usage table to stdout. The report lists what was written,
what the verifier flagged, which segments failed, and every ingredient the
extractor could not map to `vocab/ingredients.json`.

## Reports

Every LLM call is priced from `src/llm/pricing.ts` (per-model $/1M tokens,
cache reads at 0.1x and cache writes at 1.25x the input rate) and the
markdown report's token table gains a `$` column and a `Cost:` line.

Each run also writes `reports/<timestamp>.html` — one self-contained page,
no external requests, light/dark via `prefers-color-scheme` — with cost and
token tiles, a per-agent cost table, the video and catalog-change tables,
and a card per recipe written this run: ingredients with their vocab id (or
"unmapped") and provenance, and steps whose timestamps link straight to
that point in the source video. Pass `--open` to open it automatically
(`open` on macOS, `xdg-open` elsewhere) once the run finishes.

Every run also appends one line to `reports/spend.jsonl` (timestamp,
source, cost, tokens), and the HTML header shows the running total spent
across every past run.

The cache is keyed by video and stage, so nothing short of deleting a file
re-fetches captions. To start a video over completely — a corrupt download,
a changed caption track — remove its directory:

    rm -rf .cache/<videoId>

A cache file that is corrupt or no longer matches its schema is ignored with
a warning and the stage re-runs, so a half-written file cannot wedge a video.

## Eval

    npm run eval              # scores the existing catalog against eval/cases/*.json
    npm run eval -- --ingest  # ingests each case's video first (real API calls if uncached)

Each case names a video and what the pipeline should find in it (dish count,
names, cuisines, meal types, and optionally specific ingredients with their
provenance). The command prints a table and exits non-zero if any check fails,
so a prompt or vocabulary change can be regression-tested. Without `--ingest`
it never calls the API — it only reads what is already in `catalog/`.

## Bench

Compares models and thinking effort for one agent on the same cached inputs
(`.cache/<videoId>/scout.json` segments and their `extract-<i>.json` drafts),
without touching the catalog:

    npm run kambuz -- bench categorizer --models claude-sonnet-5,claude-sonnet-5:low,claude-haiku-4-5
    npm run kambuz -- bench verifier --models claude-sonnet-5,claude-sonnet-5:low --repeat 2 --yes --open

Each variant is `model[:effort]` (`low`, `medium`, `high`). Without `--yes` the
command only prints the plan ("N calls across M variants on K segments") and
calls nothing; with it, it writes `reports/bench-<agent>-<timestamp>.json` and
`.html` and prints a table per variant with scores, tokens, cost and latency.

- `categorizer` scores cuisine, course, method and meal types against hand labels in
  `eval/bench/categorizer.json` (format in `eval/bench/README.md`), plus dishKey
  stability across `--repeat` runs.
- `verifier` needs no labels: it plants errors into each cached draft (an
  ingredient borrowed from a similar dish, a quantity ×1.5, a swapped unit, a
  changed number in a step, an invented step). A planted item counts as
  detected only when the verifier explicitly marks it unsupported; an omitted
  entry is reported separately. Detection is shown next to the false-positive
  rate on the untouched drafts.

The JSON keeps every case's exact input draft, raw model output and token
usage, plus hashes of the prompt and vocabulary, so a saved run can be
re-scored after a scoring change without calling the API:

    npm run kambuz -- bench rescore reports/bench-verifier-<timestamp>.json

Every rate counts failed calls as misses and shows hits/total with a 95%
Wilson interval; with a dozen segments those intervals are wide, so use
`--repeat 3` or more before choosing a model.

The plan also prints a rough dollar estimate per variant (prompt characters / 3
for input, a fixed per-call output guess that adaptive thinking can exceed).
A variant written without an effort on a model that thinks by default is
labelled with that default, e.g. `claude-sonnet-5 (default effort: high)`. A
cost shown as `≥$…` is a lower bound: some attempts failed to parse and their
usage could not be recorded.

A variant the API rejects (for example an effort on a model without it) is
recorded as errors in the report; the rest of the bench still runs.

## Migrating category → course/method

The old `category` field mixed two axes — what a dish is in a meal and how it
was cooked — and has been split into `course` and `method` (`method` may be
`null`). A one-time script rewrites everything that used to hold `category`:

    npm run migrate-catalog

It rewrites `catalog/recipes/*.json`, `catalog/archive/*.json`,
`catalog/index.json` and `eval/bench/categorizer.json`, printing a table of
what changed. It is idempotent — running it again after the first pass finds
nothing left to change. It never calls the API and never touches `.cache/`:
a cached `categorize-<i>.json` still has the old `category` field, so it will
fail the new schema and be treated as a cache miss on the next `ingest` —
just that one stage re-runs for the affected segment, nothing is lost.

## Configuration

`.env` (copied from `.env.example`) holds `ANTHROPIC_API_KEY` and, optionally:

- `KAMBUZ_MODEL=<id>` — model for every agent (default `claude-sonnet-5`).
- `KAMBUZ_MODEL_SCOUT`, `..._EXTRACTOR`, `..._VERIFIER`, `..._CATEGORIZER`,
  `..._JUDGE` — override one agent, e.g. `KAMBUZ_MODEL_SCOUT=claude-opus-5`.
- `KAMBUZ_EFFORT_<AGENT>=low|medium|high` — thinking effort for one agent,
  e.g. `KAMBUZ_EFFORT_VERIFIER=low`. Unset (or any other value) sends no
  effort field, which is what every run sent before this setting existed.
- `KAMBUZ_CONCURRENCY=<n>` — simultaneous LLM calls across the whole run
  (default 4).

## Test

    npm test
    npm run typecheck

The tests never call the API. Agents are tested with a fake LLM client,
the fetcher with fixture caption files, and the cache and catalog on a
temporary directory.

## Layout

    src/
      fetcher/       yt-dlp wrapper and VTT caption parser
      agents/        scout, extractor, verifier, categorizer, judge
      prompts/       one markdown prompt per agent
      llm/           structured-output client and usage ledger
      orchestrator/  stage cache, catalog, pipeline
      schemas/       Zod schemas for every stage
      vocab/         loader and validator for vocab/*.json
      migrate/       one-time category → course/method migration logic
    vocab/           cuisines, courses, methods, ingredients (human-edited)
    scripts/         migrate-catalog.ts (npm run migrate-catalog)
    docs/specs/      design document
    docs/plans/      implementation plan

## Design

See `docs/specs/2026-09-15-kambuz-ingestion-pipeline-design.md`.
